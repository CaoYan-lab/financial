import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeProviderPoolSymbol } from '../apps/gateway/src/routes/providerPools.js'

test('Provider 标的代码幂等去除重复市场前缀', () => {
  assert.equal(normalizeProviderPoolSymbol('US.US.NVDA'), 'US.NVDA')
  assert.equal(normalizeProviderPoolSymbol('US.US.US.GOOG'), 'US.GOOG')
  assert.equal(normalizeProviderPoolSymbol(' hk.hk.00700 '), 'HK.00700')
  assert.equal(normalizeProviderPoolSymbol('US.BRK.B'), 'US.BRK.B')
  assert.equal(normalizeProviderPoolSymbol('NVDA.US'), 'NVDA.US')
})
