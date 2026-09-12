# Debug Session: longbridge-margin-exposure
- **Status**: [RESOLVED]
- **Issue**: Longbridge buying power remains positive while available USD cash is deeply negative.
- **Debug Server**: existing production account snapshot and structured logs
- **Log File**: cloud API response, Longbridge SDK gateway output, and source mapping

## Reproduction Steps
1. Open the cloud Longbridge account and live-trading dashboards.
2. Observe available USD cash near -21,918.
3. Observe positive maximum buying power near 2,525-2,884.
4. Determine whether the value is broker-provided financing capacity or an application mapping error.

## Hypotheses & Verification
| ID | Hypothesis | Likelihood | Observation |
|----|------------|------------|-------------|
| A | Broker buying power includes remaining margin capacity | High | Compare raw `buyPower`, `maxFinanceAmount`, and cash |
| B | Application maps the wrong financing field to buying power | Medium | Inspect SDK gateway and adapter mapping |
| C | USD cash and multi-currency account totals are mixed | Medium | Compare per-currency cash information |
| D | Dashboard cards use snapshots from different times | Medium | Compare response timestamps and values |
| E | Risk control ignores negative cash and financing exposure | High | Inspect pre-trade risk rules |

## Log Evidence
- At 2026-09-11 15:21:37 UTC, the Longbridge SDK returned:
  - net assets: USD 14,483.35
  - total cash: USD -9,710.14
  - available cash: USD -22,894.41
  - buy power: USD 2,437.26
  - maximum financing: USD 28,819.52
  - remaining financing: USD 5,925.11
  - initial margin: USD 11,996.37
  - maintenance margin: USD 9,968.03
  - margin call: USD 0
  - risk level: 1
- `maximum financing - remaining financing = 22,894.41`, exactly matching
  the magnitude of negative available cash.
- The application maps `balance.buyPower` to maximum buying power and maps
  USD `cashInfo.availableCash` to available cash. No field swap was found.
- The current pre-trade guard only caps opening notional at 95% of broker
  buying power. It does not block new opening trades when available cash is
  negative.

## Verification Conclusion
- Hypothesis A confirmed: positive buying power is remaining broker-approved
  margin-backed capacity.
- Hypothesis B rejected: the application uses the correct SDK fields.
- Hypothesis C rejected for the displayed values: both are USD values from the
  same balance response.
- Hypothesis D explains small value differences between screenshots but not the
  positive/negative sign difference.
- Hypothesis E confirmed: the system can continue opening positions while cash
  is negative, until the broker buying-power guard is reached.

## Resolution
- Preserve `risk_level`, initial margin, maintenance margin, margin call,
  maximum financing, and remaining financing from the Longbridge SDK account
  balance response.
- Add the financing risk snapshot to every Longbridge live LLM prompt. The
  prompt explicitly states that warning or danger overrides positive buying
  power.
- Treat Longbridge risk levels `2` (warning) and `3` (danger), a positive
  margin call, or net assets at/below initial margin as an opening restriction.
- Enforce the restriction in both candidate generation and the final
  single-account/multi-tenant submission paths. Closing or reducing an existing
  position remains allowed.

## Fix Attempt
- Added user-controlled `blockOpeningWhenCashNegative`; default is enabled.
- Owner settings persist in `app_config`; member settings persist in each
  tenant's `longbridge_engine_state.settings`.
- Negative available cash blocks new long and short exposure.
- Sell-to-close and short-cover orders remain allowed when they do not reverse
  the position.
- Both single-symbol and portfolio-review prompts contain the financing risk
  snapshot.
- Candidate promotion, manual confirmation, and automatic submission all
  enforce the same complete risk check.
- Final submission forces a fresh account snapshot and fails closed when the
  account, risk level, equity, or buying power is unavailable.
- Sell-to-close and short-cover quantities cannot reverse the position.
- US limit prices use direction-safe tick normalization in both single-account
  and tenant submission paths, and the persisted audit price matches the
  submitted price.

## Post-Fix Evidence
- Focused backend, tenant, settings, prompt, and route tests passed.
- Full suite: 423 passed, 1 skipped.
- Coverage gates passed: 93.89% statements and 80.17% branches.
- TypeScript check and production build passed.
- Cloud deployment and live verification are pending.
