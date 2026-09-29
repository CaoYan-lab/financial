# Debug Session: longbridge-connect-timeout
- **Status**: [OPEN]
- **Issue**: Longbridge live evaluation stops after `timeout exceeded when trying to connect`; expected transient connection failures to be isolated and retried without stopping the engine or aborting all remaining symbols.
- **Debug Server**: http://127.0.0.1:7777/event
- **Log File**: `.dbg/trae-debug-log-longbridge-connect-timeout.ndjson`

## Reproduction Steps
1. Start the Longbridge live engine with the configured 20-symbol universe.
2. Allow a scheduled or manual evaluation batch to begin.
3. Observe a database connection timeout during the batch.
4. Confirm whether the whole batch rejects and the engine transitions to stopped.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Effort | Expected evidence |
|----|------------|------------|--------|-------------------|
| A | The exact timeout message is absent from the retryable PostgreSQL classifier. | High | Low | Confirmed: pre-fix log line 1 records `retryable=false` and only one attempt. |
| B | One symbol's database error escapes `mapLimit` and rejects the whole batch. | High | Low | Confirmed by the instrumented worker path and `Promise.all` rejection semantics; the original UI shows the engine stopped with all 20 symbols unevaluated. |
| C | Evaluation concurrency exhausts or queues the PostgreSQL pool. | Medium | Medium | Confirmed: `pg-pool` emits this exact text only when its pool is full and checkout waits past `connectionTimeoutMillis`; each symbol currently performs the same managed-order query while the pool max defaults to 5. |
| D | The cloud job wrapper times out or rewrites an otherwise recoverable failure. | Medium | Medium | Rejected as primary cause: the exact message originates in `pg-pool`, and the engine policy receives it unchanged. |

## Log Evidence
- `.dbg/trae-debug-log-longbridge-connect-timeout.ndjson:1`: `operation=longbridge-reproduction`, `attempt=1`, `maxAttempts=3`, `retryable=false`, `errorMessage=timeout exceeded when trying to connect`.
- Minimal reproduction output: `calls=1`, proving the configured three-attempt retry loop is bypassed.
- `node_modules/pg-pool/index.js:206-224`: when the pool is full, a queued checkout is failed after `connectionTimeoutMillis` with the exact reported message.
- `api/longbridge/longbridgeLiveTradingEngine.ts`: every parallel ticker calls `listManagedOrders('longbridge', true)` before evaluation; default evaluation concurrency can be 20 while `PG_POOL_MAX` defaults to 5.

## Verification Conclusion
Pre-fix root cause confirmed. The retry classifier recognizes a different connection-timeout wording but not the current `pg-pool` queue-timeout wording. Parallel duplicate managed-order reads create unnecessary pool pressure, and the unclassified error is treated as fatal by the engine.

Post-fix comparison:
- Pre-fix: `retryable=false`, one operation attempt, error propagated.
- Post-fix: `retryable=true`, the same first-attempt error enters retry, second attempt returns `ok`.
- Longbridge batches now load one managed-order snapshot and share it across all ticker evaluations instead of issuing one duplicate PostgreSQL query per ticker.
- Focused verification: 34 tests passed, 1 integration test skipped.
- TypeScript verification: `tsc --noEmit` passed.
- Full unit suite: 574 tests passed, 1 skipped, 4 failed only in the pre-existing uncommitted `PortfolioContext` work because its Longbridge mock has not been updated. The failures do not touch this timeout fix.
- Production release: commit `01515c3`, image `financial-workbench:v73`, Worker Revision 71, Web Revision 62.
- Production leader verification: exactly one Ready Worker instance and one granted PostgreSQL advisory leader lock; heartbeat advanced under worker `worker-244-08fc5566`.
- Production engine verification: `longbridge_live.engine.running=true`, `lastError=""`, and `lastRunAt=2026-09-16T16:52:45.854Z`.
- Post-release logs: multiple Longbridge evaluation batches and successful decisions; no `timeout exceeded when trying to connect`, transient engine failure, or failed cloud job.
- Network verification: HTTPS `/api/health` returned 200 five consecutive times; HTTP/80 refused connections.
- The release script's first health probe received the known post-cutover 403 transient after both revisions completed; direct repeated checks immediately recovered to 200 without redeploying.
