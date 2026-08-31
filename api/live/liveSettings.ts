let autoSubmitEnabled = process.env.FUTU_AUTO_SUBMIT_ENABLED === 'true'

export function getFutuLiveSettings() {
  return {
    liveTradingEnabled: process.env.LIVE_TRADING_ENABLED === 'true' && process.env.FUTU_LIVE_TRD_ENV === 'REAL',
    autoSubmitEnabled,
    updatedAt: new Date().toISOString(),
  }
}

export function updateFutuLiveSettings(input: { autoSubmitEnabled?: boolean }) {
  if (typeof input.autoSubmitEnabled === 'boolean') autoSubmitEnabled = input.autoSubmitEnabled
  return getFutuLiveSettings()
}
