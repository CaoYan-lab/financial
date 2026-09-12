# Debug Session: relay-defender-block
- **Status**: [OPEN]
- **Issue**: Windows Defender blocks the generated Longbridge relay executable; port 1080 remains unavailable.
- **Debug Server**: unavailable from the isolated Windows ECS
- **Log File**: user-provided PowerShell output and screenshot

## Reproduction Steps
1. Run `repair-longbridge-relay.ps1 -Repair` as Administrator on `fin-opend`.
2. The scheduled task remains Ready and returns `2147942405`.
3. No process listens on port 1080; local CONNECT validation fails.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Evidence |
|----|------------|------------|--------|----------|
| A | Defender quarantined or blocked `LongbridgeRelay.exe` | High | Low | Confirmed by user report and task result `0x80070005` |
| B | Application control blocks the generated executable | Medium | Medium | Consistent with `0x80070005`; exact policy event not yet available |
| C | Scheduled task SYSTEM permissions are invalid | Low | Low | Existing task registration succeeds; failure occurs on executable start |
| D | Port 1080 bind fails after process startup | Low | Low | Rejected because no relay process or listener exists |

## Log Evidence
- Scheduled task state: `Ready`
- Scheduled task executable: `C:\FinProxy\LongbridgeRelay.exe`
- Last task result: `2147942405` (`0x80070005`, access denied)
- Listener list is empty.
- Loopback and private-address checks are both false.
- CONNECT fails because `10.20.1.37:1080` refuses or denies the connection.

## Verification Conclusion
Do not restore the blocked executable or add a Defender exclusion. Replace the
disk executable with a source-only PowerShell host that compiles the relay in
memory and runs it inside signed `powershell.exe`.

## Fix Attempt
- Updated `repair-longbridge-relay.ps1` so it no longer creates or executes
  `LongbridgeRelay.exe`.
- The scheduled task now starts the source-only relay through the Microsoft
  signed Windows PowerShell executable.
- Startup failures are written to `C:\FinProxy\relay-host-error.log`.

## Post-Fix Evidence
- Windows local check: `privateAddressReachable = true`.
- Windows CONNECT check: `HTTP/1.1 200 Connection Established`.
- `fin-worker` to `10.20.1.37:1080`: connected in 4 ms.
- Production order API: HTTP 200 in 3.49 seconds.
- Production order response: 12 records on the first page, 21 records total.

## Verification Conclusion
Pre-fix, the relay port timed out and the order API returned 504 after about
35 seconds. Post-fix, the relay is reachable from the Worker and the same order
API returns valid data in under 4 seconds. User confirmation is pending before
debug artifact cleanup.
