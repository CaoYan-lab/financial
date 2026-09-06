import type { BrokerExecutionSettings } from '../../shared/managedOrderTypes.js'
import {
  defaultBrokerExecutionSettings,
  loadBrokerExecutionSettings,
  saveBrokerExecutionSettings,
} from '../cloud/state/brokerExecutionSettingsStore.js'

let controls = defaultBrokerExecutionSettings('futu')

export function getFutuLiveSettings() {
  return {
    liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === 'true' && process.env.FUTU_LIVE_TRD_ENV === 'REAL',
    ...controls,
    updatedAt: new Date().toISOString(),
  }
}

export async function hydrateFutuLiveSettings() {
  controls = await loadBrokerExecutionSettings('futu')
  return getFutuLiveSettings()
}

export async function updateFutuLiveSettings(input: Partial<BrokerExecutionSettings>) {
  controls = await saveBrokerExecutionSettings('futu', { ...controls, ...input })
  return getFutuLiveSettings()
}
