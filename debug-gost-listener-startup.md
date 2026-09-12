# Debug Session: gost-listener-startup
- **Status**: [OPEN]
- **Issue**: GOST 已下载并创建计划任务，但 ECS 本机 `10.20.1.37:1080` 未监听，HTTP CONNECT 验证失败。
- **Evidence File**: `C:\FinProxy\gost-diagnostic.log`

## Reproduction Steps
1. 在 Windows ECS 以管理员身份运行 GOST 安装脚本。
2. 脚本成功完成下载、计划任务和防火墙步骤。
3. `Test-NetConnection 10.20.1.37 -Port 1080` 返回 `TcpTestSucceeded=False`。

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | GOST v3 启动参数无效，计划任务启动后立即退出 | High | Low | Rejected: executable was not present, so arguments were never evaluated |
| B | SYSTEM 身份无法执行 GOST 或被安全软件阻止 | Medium | Low | Confirmed: Defender events 1116/1117 quarantined `gost.exe` as `Trojan:Script/Wacatac.B!ml` |
| C | GOST 已启动但监听了其他地址或端口 | Medium | Low | Rejected: no `gost.exe` process exists |
| D | `10.20.1.37:1080` 绑定冲突或地址绑定失败 | Medium | Low | Rejected: process never reached socket binding |

## Log Evidence
Pre-fix screenshot confirms TCP port 1080 is not listening and proxy request cannot connect.

Runtime diagnostic screenshot:
- `tasklist` reports no matching `gost.exe` process.
- `netstat` reports no listener on port 1080.
- `Start-Process C:\FinProxy\gost.exe` fails with `系统找不到指定的文件`.
- The control process has no PID, confirming the executable was absent before startup.
- Defender event 1116 identifies `C:\FinProxy\gost.exe` as `Trojan:Script/Wacatac.B!ml` (threat ID 2147735503).
- Defender event 1117 records successful quarantine/remediation, including the `FinLongbridgeProxy` scheduled task path.

## Verification Conclusion
Root cause confirmed: Microsoft Defender quarantined the third-party proxy binary and removed its scheduled-task execution path. Do not restore the binary or add a Defender exclusion. Replace it with a source-auditable, domain-allowlisted relay hosted by Windows PowerShell without persisting another generated executable.

## Minimal Fix
- Run a small C# HTTP CONNECT relay from visible source inside the Microsoft-signed
  Windows PowerShell host; do not persist a generated relay executable.
- Bind only `10.20.1.37:1080`.
- Permit only `CONNECT openapi.longbridge.com:443`.
- Keep Windows Firewall restricted to `10.20.1.0/24` and `10.20.2.0/24`.
- Run through a startup scheduled task so its outbound TCP connection is captured by the HeySocks TUN driver.

## 2026-09-11 Recurrence

- `fin-opend` is running and its public RDP endpoint is reachable.
- From `fin-worker`, `10.20.1.37:11111` connects in about 1 ms.
- From `fin-worker`, `10.20.1.37:1080` times out after 5 seconds.
- The Longbridge order API consequently completes after the child-process timeout and the Web request returns 504.
- ECS Cloud Assistant reports `InvalidInstanceId.Unregister`, so process and scheduled-task state cannot be read remotely.

Use [repair-longbridge-relay.ps1](deploy/volcano/windows/repair-longbridge-relay.ps1)
from an elevated PowerShell session on `fin-opend`:

```powershell
# Read-only diagnosis
powershell -NoProfile -ExecutionPolicy Bypass -File .\repair-longbridge-relay.ps1

# Rebuild the source-auditable relay, scheduled task, and restricted firewall rule
powershell -NoProfile -ExecutionPolicy Bypass -File .\repair-longbridge-relay.ps1 -Repair
```

Success requires:

- `privateAddressReachable` is `true`.
- The `FinLongbridgeProxy` task state is `Running`.
- Port `10.20.1.37:1080` has a listener owned by the scheduled PowerShell host.
- The CONNECT check returns `HTTP/1.1 200 Connection Established`.
