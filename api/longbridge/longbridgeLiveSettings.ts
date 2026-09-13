import type { BrokerExecutionSettings } from '../../shared/managedOrderTypes.js'
import {
  defaultBrokerExecutionSettings,
  loadBrokerExecutionSettings,
  saveBrokerExecutionSettings,
} from '../cloud/state/brokerExecutionSettingsStore.js'

let controls: BrokerExecutionSettings | undefined

export function getLongbridgeLiveSettings() {
  return {
    liveTradingEnabled: process.env.LONGBRIDGE_LIVE_TRADING_ENABLED === 'true',
    ...(controls ?? defaultBrokerExecutionSettings('longbridge')),
    updatedAt: new Date().toISOString(),
  }
}

export async function hydrateLongbridgeLiveSettings() {
  controls = await loadBrokerExecutionSettings('longbridge')
  return getLongbridgeLiveSettings()
}

export async function updateLongbridgeLiveSettings(input: Partial<BrokerExecutionSettings>) {
  controls = await saveBrokerExecutionSettings('longbridge', {
    ...(controls ?? defaultBrokerExecutionSettings('longbridge')),
    ...input,
  })
  return getLongbridgeLiveSettings()
}
