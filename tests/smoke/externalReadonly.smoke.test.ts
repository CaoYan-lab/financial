import { describe, expect, it } from 'vitest'

const enabled = process.env.RUN_EXTERNAL_READONLY_SMOKE === '1'
const describeExternal = enabled ? describe : describe.skip

describeExternal('真实外部服务只读冒烟', () => {
  it('Futu OpenD 可读取账户快照但不执行交易', async () => {
    expect(process.env.FUTU_LIVE_TRADING_ENABLED).not.toBe('true')
    const { loadLiveAccountDashboard } = await import('../../api/live/liveAccountService.js')
    const dashboard = await loadLiveAccountDashboard()
    expect(dashboard.ok).toBe(true)
    expect(dashboard.summary).toBeTruthy()
  }, 45_000)

  it('Longbridge SDK 可读取账户与持仓但不执行交易', async () => {
    expect(process.env.LONGBRIDGE_LIVE_TRADING_ENABLED).not.toBe('true')
    const { loadLongbridgeLiveAccountDashboard } = await import('../../api/longbridge/longbridgeAdapter.js')
    const dashboard = await loadLongbridgeLiveAccountDashboard()
    expect(dashboard.ok).toBe(true)
    expect(dashboard.summary).toBeTruthy()
  }, 45_000)

  it('Longbridge 资讯/研究链路状态可读', async () => {
    const { loadLongbridgeSourceStatus } = await import('../../api/longbridge/longbridgeAdapter.js')
    const status = await loadLongbridgeSourceStatus()
    expect(status.ok).toBe(true)
    expect(status.lastCheckedAt).toBeTruthy()
  }, 45_000)
})
