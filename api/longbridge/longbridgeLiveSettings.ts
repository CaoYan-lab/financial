let autoSubmitEnabled = process.env.LONGBRIDGE_AUTO_SUBMIT_ENABLED === 'true'

export function getLongbridgeLiveSettings() {
  return {
    liveTradingEnabled: process.env.LONGBRIDGE_LIVE_TRADING_ENABLED === 'true',
    autoSubmitEnabled,
    updatedAt: new Date().toISOString(),
  }
}

export function updateLongbridgeLiveSettings(input: { autoSubmitEnabled?: boolean }) {
  if (typeof input.autoSubmitEnabled === 'boolean') autoSubmitEnabled = input.autoSubmitEnabled
  return getLongbridgeLiveSettings()
}
