import {
  loadLongbridgeMarketStates,
} from '../../../longbridge/longbridgeMarketSessionService.js'
import { loadLongbridgeLotSize } from '../../../longbridge/longbridgeLotSizeService.js'
import type { BrokerConnection } from '../types.js'
import { contextsForConnection } from './contextRegistry.js'

export async function loadTenantMarketStates(
  connection: BrokerConnection,
  symbols: string[],
  now = new Date(),
): Promise<Map<string, string>> {
  return loadLongbridgeMarketStates(contextsForConnection(connection).quote, symbols, now)
}

export async function loadTenantLotSize(
  connection: BrokerConnection,
  symbol: string,
): Promise<number> {
  return loadLongbridgeLotSize(contextsForConnection(connection).quote, symbol)
}
