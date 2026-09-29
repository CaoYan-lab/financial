import assert from 'node:assert/strict'
import test from 'node:test'
import {
  liveTradingGateDigest,
  readLiveTradingGates,
} from '../packages/domain/src/liveTradingGates.js'

test('双券商真实交易门禁仅接受精确 true 且摘要稳定', () => {
  const gates = readLiveTradingGates({
    CHANGFU_FUTU_LIVE_TRADING_ENABLED: 'true',
    CHANGFU_LONGBRIDGE_LIVE_TRADING_ENABLED: 'TRUE',
  })
  assert.deepEqual(gates, { FUTU: true, LONGBRIDGE: false })
  assert.equal(liveTradingGateDigest(gates), liveTradingGateDigest({ ...gates }))
  assert.notEqual(
    liveTradingGateDigest(gates),
    liveTradingGateDigest({ FUTU: false, LONGBRIDGE: false }),
  )
})
