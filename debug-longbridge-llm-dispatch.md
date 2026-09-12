# Debug Session: longbridge-llm-dispatch
- **Status**: [OPEN]
- **Issue**: Verify whether the cloud Longbridge live engine dispatched LLM trading-evaluation requests.
- **Debug Server**: existing production structured logs
- **Log File**: veFaaS Worker logs and cloud PostgreSQL state

## Reproduction Steps
1. Open the cloud Longbridge live-trading page.
2. Start live evaluation.
3. Observe `实盘评估运行中`, with 15 active, 3 waiting, and 2 market-state errors.
4. Verify whether the active symbols reached the Ark LLM request stage.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Observation |
|----|------------|------------|-------------|
| A | The start or run-once job is still queued | Medium | Latest `cloud_jobs` status and timestamps |
| B | Worker started the batch and dispatched Ark requests | High | `longbridge.live.llm_batch.started` and `llm.ark.request.started` logs |
| C | Symbols were skipped before LLM because of data/account gates | Medium | preflight and `skipped_before_llm` logs |
| D | Ark requests were sent but failed or timed out | Medium | Ark failed/errored logs and durations |
| E | UI shows a stale running snapshot without a current cycle | Low | engine snapshot timestamps versus Worker logs |

## Log Evidence
- `longbridge_live.start` job 1323 was queued at 21:48:03 and succeeded at 21:48:32.
- The Worker started a 20-symbol batch at 21:50:04.
- Three closed HK symbols were skipped by the market-session preflight gate.
- The batch contained 17 active symbols with effective concurrency 1.
- MU.US Ark request started at 21:50:04 and succeeded after 98,011 ms.
- MU.US produced an approved BUY decision.
- MULL.US Ark request started at 21:51:55 and succeeded after 51,326 ms.
- MULL.US produced an approved HOLD decision.
- NVDA.US Ark request started at 21:52:50 and was still in progress at the
  observation cutoff.
- No `llm.ark.request.failed` or `llm.ark.request.errored` event was observed.

## Verification Conclusion
- Hypothesis A rejected: the start job completed.
- Hypothesis B confirmed: Ark evaluation requests were dispatched and returned.
- Hypothesis C partially confirmed only for the three closed HK symbols.
- Hypothesis D rejected for the completed requests: no failure or timeout event.
- Hypothesis E rejected: the Worker is actively progressing through the batch.

The apparent delay is caused by effective Longbridge evaluation concurrency 1
combined with individual model response times of about 51-98 seconds.
