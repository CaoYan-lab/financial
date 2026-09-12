# Debug Session: longbridge-price-tick
- **Status**: [OPEN]
- **Issue**: Longbridge rejects a valid one-share US order because its limit price violates the minimum quote increment.
- **Debug Server**: existing production structured logs and persisted order payload
- **Log File**: veFaaS Worker logs and cloud PostgreSQL state

## Reproduction Steps
1. Run the Longbridge live-trading evaluation.
2. Let the model approve a one-share BUY for MU.
3. Auto-submit the generated limit order.
4. Longbridge rejects the request with error 602035.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Observation |
|----|------------|------------|-------------|
| A | Model limit price is not normalized | High | Model generated `982.369` |
| B | Pending-order persistence preserves invalid precision | High | Inspect persisted MU order intent |
| C | Submit guard validates quantity but not price increment | High | Inspect Longbridge submit path |
| D | Security quote metadata is available but unused | Medium | Inspect Longbridge SDK quote/profile methods |

## Log Evidence
- User-visible broker error: `602035`, minimum quote unit mismatch.
- Requested quantity is one share, which is valid for this US security.
- Requested limit price is `982.369`, which is not aligned to a USD 0.01 tick.
- Cloud persistence confirms the MU pending order used quantity `1` and
  `limitPrice=982.369` through `PENDING_CONFIRMATION`,
  `CONFIRMED_SUBMITTING`, and `SUBMIT_FAILED`.
- The submit adapter passed `intent.limitPrice` directly to the Longbridge SDK.

## Verification Conclusion
- Hypothesis A confirmed: model price was not normalized.
- Hypothesis B confirmed: the pending order preserved three decimal places.
- Hypothesis C confirmed: submit guards covered quantity and session only.
- Hypothesis D rejected for the current SDK: static security information exposes
  lot size but not the minimum quote increment.

## Fix Attempt
- Normalize US limit prices at the final SDK submission boundary.
- Prices at or above USD 1 use two decimal places.
- Prices below USD 1 retain four decimal places.
- Quantity remains unchanged, so one-share US orders continue to be valid.
- HK prices are not changed by the US-specific rule.

## Post-Fix Evidence
- `982.369` becomes `982.37`.
- `21.911` becomes `21.91`.
- `0.98765` becomes `0.9877`.
- Focused tests: 16 passed, 1 skipped.
- Full test suite: 401 passed, 1 skipped.
- TypeScript check and production build passed.
- Cloud deployment and broker-side verification are pending.
