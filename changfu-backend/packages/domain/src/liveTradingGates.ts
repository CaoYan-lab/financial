import { createHash } from 'node:crypto'
import type { BrokerProvider } from './contracts.js'

export type LiveTradingGates = Readonly<Record<BrokerProvider, boolean>>

export function readLiveTradingGates(
  environment: NodeJS.ProcessEnv = process.env,
): LiveTradingGates {
  return {
    FUTU: environment.CHANGFU_FUTU_LIVE_TRADING_ENABLED === 'true',
    LONGBRIDGE: environment.CHANGFU_LONGBRIDGE_LIVE_TRADING_ENABLED === 'true',
  }
}

export function liveTradingGateDigest(gates: LiveTradingGates): string {
  return createHash('sha256')
    .update(JSON.stringify({ FUTU: gates.FUTU, LONGBRIDGE: gates.LONGBRIDGE }))
    .digest('hex')
}
