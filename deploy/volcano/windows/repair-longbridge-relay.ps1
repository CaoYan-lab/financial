[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [switch]$Repair
)

$ErrorActionPreference = "Stop"
$RelayDirectory = "C:\FinProxy"
$RelaySource = Join-Path $RelayDirectory "LongbridgeRelay.cs"
$RelayHost = Join-Path $RelayDirectory "LongbridgeRelayHost.ps1"
$BlockedRelayExecutable = Join-Path $RelayDirectory "LongbridgeRelay.exe"
$RelayLog = Join-Path $RelayDirectory "relay.log"
$TaskName = "FinLongbridgeProxy"
$FirewallRuleName = "Fin Worker Longbridge Proxy"
$ListenAddress = "10.20.1.37"
$ListenPort = 1080

function Get-RelayDiagnostics {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $taskInfo = if ($task) {
        Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue
    }
    $listener = Get-NetTCPConnection `
        -LocalPort $ListenPort `
        -State Listen `
        -ErrorAction SilentlyContinue
    $processes = Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -match "LongbridgeRelay|gost" -or
            $_.CommandLine -match "LongbridgeRelayHost"
        } |
        Select-Object Name, ProcessId, ExecutablePath, CommandLine
    $firewall = Get-NetFirewallRule `
        -DisplayName $FirewallRuleName `
        -ErrorAction SilentlyContinue

    [ordered]@{
        timestamp = (Get-Date).ToString("o")
        blockedExecutableExists = Test-Path $BlockedRelayExecutable
        hostScriptExists = Test-Path $RelayHost
        sourceExists = Test-Path $RelaySource
        processes = @($processes)
        listeners = @(
            $listener |
                Select-Object LocalAddress, LocalPort, OwningProcess, State
        )
        scheduledTask = if ($task) {
            [ordered]@{
                state = $task.State.ToString()
                execute = $task.Actions.Execute
                arguments = $task.Actions.Arguments
                lastRunTime = $taskInfo.LastRunTime
                lastTaskResult = $taskInfo.LastTaskResult
            }
        } else {
            $null
        }
        firewallRule = if ($firewall) {
            [ordered]@{
                enabled = $firewall.Enabled.ToString()
                direction = $firewall.Direction.ToString()
                action = $firewall.Action.ToString()
            }
        } else {
            $null
        }
        loopbackReachable = Test-NetConnection `
            127.0.0.1 `
            -Port $ListenPort `
            -InformationLevel Quiet
        privateAddressReachable = Test-NetConnection `
            $ListenAddress `
            -Port $ListenPort `
            -InformationLevel Quiet
    }
}

function Test-RelayConnect {
    $client = [Net.Sockets.TcpClient]::new()
    try {
        $client.Connect($ListenAddress, $ListenPort)
        $stream = $client.GetStream()
        $stream.ReadTimeout = 20000
        $request = [Text.Encoding]::ASCII.GetBytes(
            "CONNECT openapi.longbridge.com:443 HTTP/1.1`r`n" +
            "Host: openapi.longbridge.com:443`r`n`r`n"
        )
        $stream.Write($request, 0, $request.Length)
        $buffer = [byte[]]::new(256)
        $count = $stream.Read($buffer, 0, $buffer.Length)
        return [Text.Encoding]::ASCII.GetString($buffer, 0, $count).Trim()
    } finally {
        $client.Dispose()
    }
}

function Install-Relay {
    New-Item -ItemType Directory -Path $RelayDirectory -Force | Out-Null

    $source = @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public static class LongbridgeRelay
{
    private const string ListenIp = "10.20.1.37";
    private const int ListenPort = 1080;
    private const string AllowedHost = "openapi.longbridge.com";
    private const int AllowedPort = 443;
    private static readonly object LogLock = new object();

    public static void Main()
    {
        TcpListener listener = new TcpListener(
            IPAddress.Parse(ListenIp), ListenPort);
        listener.Start(64);
        Log("relay started on " + ListenIp + ":" + ListenPort);

        while (true)
        {
            TcpClient client = listener.AcceptTcpClient();
            ThreadPool.QueueUserWorkItem(Handle, client);
        }
    }

    private static void Handle(object state)
    {
        TcpClient client = (TcpClient)state;

        try
        {
            using (client)
            {
                client.ReceiveTimeout = 10000;
                NetworkStream downstream = client.GetStream();
                string header = ReadHeader(downstream);

                if (String.IsNullOrEmpty(header))
                    return;

                string firstLine = header.Split(
                    new[] { "\r\n" },
                    StringSplitOptions.None)[0];
                string[] parts = firstLine.Split(' ');

                if (parts.Length < 2 ||
                    !parts[0].Equals(
                        "CONNECT",
                        StringComparison.OrdinalIgnoreCase))
                {
                    Reply(downstream, "405 Method Not Allowed");
                    return;
                }

                int separator = parts[1].LastIndexOf(':');
                if (separator <= 0)
                {
                    Reply(downstream, "400 Bad Request");
                    return;
                }

                string host = parts[1].Substring(0, separator);
                int port;
                if (!Int32.TryParse(
                        parts[1].Substring(separator + 1), out port) ||
                    !host.Equals(
                        AllowedHost,
                        StringComparison.OrdinalIgnoreCase) ||
                    port != AllowedPort)
                {
                    Log("denied target " + parts[1]);
                    Reply(downstream, "403 Forbidden");
                    return;
                }

                using (TcpClient upstream = new TcpClient())
                {
                    IAsyncResult result = upstream.BeginConnect(
                        host, port, null, null);
                    if (!result.AsyncWaitHandle.WaitOne(15000))
                        throw new TimeoutException("upstream timeout");

                    upstream.EndConnect(result);
                    NetworkStream upstreamStream = upstream.GetStream();
                    byte[] response = Encoding.ASCII.GetBytes(
                        "HTTP/1.1 200 Connection Established\r\n\r\n");
                    downstream.Write(response, 0, response.Length);

                    Task left = Pump(downstream, upstreamStream);
                    Task right = Pump(upstreamStream, downstream);
                    Task.WaitAny(left, right);
                }
            }
        }
        catch (Exception exception)
        {
            Log("connection error: " + exception.Message);
        }
    }

    private static string ReadHeader(Stream stream)
    {
        MemoryStream buffer = new MemoryStream();
        while (buffer.Length < 8192)
        {
            int value = stream.ReadByte();
            if (value < 0)
                return null;

            buffer.WriteByte((byte)value);
            byte[] bytes = buffer.GetBuffer();
            int length = (int)buffer.Length;
            if (length >= 4 &&
                bytes[length - 4] == 13 &&
                bytes[length - 3] == 10 &&
                bytes[length - 2] == 13 &&
                bytes[length - 1] == 10)
            {
                return Encoding.ASCII.GetString(bytes, 0, length);
            }
        }

        return null;
    }

    private static async Task Pump(Stream input, Stream output)
    {
        byte[] buffer = new byte[32768];
        try
        {
            int count;
            while ((count = await input.ReadAsync(
                buffer, 0, buffer.Length)) > 0)
            {
                await output.WriteAsync(buffer, 0, count);
            }
        }
        catch
        {
        }
    }

    private static void Reply(Stream stream, string status)
    {
        byte[] response = Encoding.ASCII.GetBytes(
            "HTTP/1.1 " + status +
            "\r\nConnection: close\r\n\r\n");
        stream.Write(response, 0, response.Length);
    }

    private static void Log(string message)
    {
        lock (LogLock)
        {
            File.AppendAllText(
                @"C:\FinProxy\relay.log",
                DateTime.UtcNow.ToString("O") +
                " " + message + Environment.NewLine);
        }
    }
}
'@

    Stop-ScheduledTask `
        -TaskName $TaskName `
        -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.Name -eq "LongbridgeRelay.exe" -or
            $_.CommandLine -match "LongbridgeRelayHost"
        } |
        ForEach-Object {
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
    Remove-Item $BlockedRelayExecutable -Force -ErrorAction SilentlyContinue
    Set-Content $RelaySource $source -Encoding UTF8

    $hostScript = @"
`$ErrorActionPreference = "Stop"
try {
    `$source = @'
$source
'@
    Add-Type -TypeDefinition `$source -Language CSharp
    [LongbridgeRelay]::Main()
} catch {
    `$timestamp = (Get-Date).ToUniversalTime().ToString("o")
    "`$timestamp `$(`$_.Exception.ToString())" |
        Out-File "C:\FinProxy\relay-host-error.log" -Append -Encoding UTF8
    exit 1
}
"@
    Set-Content $RelayHost $hostScript -Encoding UTF8

    $powerShell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$RelayHost`""
    $action = New-ScheduledTaskAction `
        -Execute $powerShell `
        -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtStartup
    Register-ScheduledTask `
        -TaskName $TaskName `
        -Action $action `
        -Trigger $trigger `
        -User "SYSTEM" `
        -RunLevel Highest `
        -Force | Out-Null

    Remove-NetFirewallRule `
        -DisplayName $FirewallRuleName `
        -ErrorAction SilentlyContinue
    New-NetFirewallRule `
        -DisplayName $FirewallRuleName `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalAddress $ListenAddress `
        -LocalPort $ListenPort `
        -RemoteAddress "10.20.1.0/24", "10.20.2.0/24" `
        -Profile Any | Out-Null

    Start-ScheduledTask -TaskName $TaskName
    Start-Sleep -Seconds 3
}

try {
    Write-Host "=== BEFORE ==="
    Get-RelayDiagnostics | ConvertTo-Json -Depth 6

    if (-not $Repair) {
        Write-Host "Diagnostic only. Re-run with -Repair to rebuild the relay."
        return
    }

    if ($PSCmdlet.ShouldProcess(
        "$ListenAddress`:$ListenPort",
        "Rebuild and restart Longbridge relay"
    )) {
        Install-Relay
    }

    Write-Host "=== AFTER ==="
    Get-RelayDiagnostics | ConvertTo-Json -Depth 6
    Write-Host "=== CONNECT ==="
    Write-Host (Test-RelayConnect)
} catch {
    Write-Error $_
    if (Test-Path $RelayLog) {
        Get-Content $RelayLog -Tail 50
    }
    exit 1
} finally {
    Read-Host "Press Enter to close"
}
