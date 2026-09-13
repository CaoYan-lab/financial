import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

describe('富途账户Python数据语义', () => {
  it('失败关闭、强制刷新、合法零、非有限值及币种方向隔离', () => {
    const result = execFileSync('python3', ['-c', `
import sys
sys.path.insert(0, "api/futu_bridge")
import futu_account as a
from futu_common import safe_float
from types import SimpleNamespace
assert a.first_number(0, 100) == 0
assert safe_float("inf") is None
assert safe_float(float("inf")) is None
assert a.available_to_close(float("inf"), 10) is None
assert a.available_to_close(-1, 10) is None
assert a.available_to_close(11, 10) is None
assert a.available_to_close(0, 10) == 0
assert a.trading_currency_value({"currency":"HKD","cash":780,"us_cash":100},780) is None
assert a.currency_specific_value({"currency":"HKD","hk_max_power_short":10000},"HKD","buying_power",0) == 0
assert a.currency_money(10, "") == "unavailable"
class Frame:
    empty = False
    iloc = [{"acc_id":1,"currency":"USD","power":0,"max_power_short":9999,
             "total_assets":100,"cash":0,"avl_withdrawal_cash":0,"available_funds":999,
             "exposure_level":"WARNING","risk_status":"LEVEL7","initial_margin":50,
             "maintenance_margin":30,"margin_call_margin":60}]
class Trade:
    def accinfo_query(self, **kwargs):
        assert kwargs["refresh_cache"] is True
        return 0, Frame()
summary = a.fetch_summary(Trade(), SimpleNamespace(REAL="REAL"), {}, 1, "USD", True)
assert summary["buyingPower"] == "$0.00"
assert summary["availableFunds"] == "$0.00"
assert summary["futuExposureLevel"] == "WARNING"
assert "marginCall" not in summary
class Failed:
    def accinfo_query(self, **kwargs): return -1, None
    def position_list_query(self, **kwargs): return -1, None
for fn in [a.fetch_summary, a.fetch_positions]:
    try: fn(Failed(), SimpleNamespace(REAL="REAL"), {})
    except RuntimeError: pass
    else: raise AssertionError("query failure accepted")
print("passed")
`], { encoding: 'utf8' })
    expect(result.trim()).toBe('passed')
  })
})
