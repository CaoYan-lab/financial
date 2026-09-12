import { describe, expect, it } from 'vitest'
import { overlayBrokerExecutionSettings } from '../api/cloud/http/routeOverrides'
import { defaultBrokerExecutionSettings } from '../api/cloud/state/brokerExecutionSettingsStore'
import type { BrokerExecutionSettings } from '../shared/managedOrderTypes'

const persistedSettings: BrokerExecutionSettings = {
  autoSubmitEnabled: true,
  autoCancelEnabled: true,
  blockOpeningWhenCashNegative: true,
  marketableLimitTimeoutSeconds: 90,
  limitTimeoutSeconds: 600,
  brokerSyncIntervalSeconds: 15,
  modelReviewIntervalSeconds: 60,
  modelAutoCancelConfidence: 'high',
}

describe('broker execution settings snapshot', () => {
  it('长桥负现金开仓保护默认开启', () => {
    expect(defaultBrokerExecutionSettings('longbridge').blockOpeningWhenCashNegative).toBe(true)
  })

  it.each(['futu', 'longbridge'])(
    'uses persisted %s settings instead of stale worker heartbeat values',
    () => {
      const result = overlayBrokerExecutionSettings(
        {
          liveTradingEnabled: true,
          autoSubmitEnabled: false,
          autoCancelEnabled: false,
          account: { ok: true },
          updatedAt: '2026-09-06T00:00:00.000Z',
        },
        persistedSettings,
      )

      expect(result).toMatchObject({
        liveTradingEnabled: true,
        autoSubmitEnabled: true,
        autoCancelEnabled: true,
        account: { ok: true },
      })
      expect(result.updatedAt).not.toBe('2026-09-06T00:00:00.000Z')
    },
  )
})
