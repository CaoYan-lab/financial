import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

function runFilterExpression(expression: string) {
  const result = spawnSync('python3', [
    '-c',
    [
      'import sys',
      "sys.path.insert(0, 'api/futu_bridge')",
      'from futu_live_orders import matches_side_filter, matches_status_filter',
      `print(${expression})`,
    ].join('\n'),
  ], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  return result.stdout.trim()
}

describe('Futu 券商订单筛选', () => {
  it('按生命周期状态分组', () => {
    expect(runFilterExpression("matches_status_filter('FILLED_ALL', 'FILLED')")).toBe('True')
    expect(runFilterExpression("matches_status_filter('SUBMIT_FAILED', 'FAILED')")).toBe('True')
    expect(runFilterExpression("matches_status_filter('SUBMITTED', 'CANCELED')")).toBe('False')
  })

  it('按买卖方向分组', () => {
    expect(runFilterExpression("matches_side_filter('BUY_BACK', 'BUY')")).toBe('True')
    expect(runFilterExpression("matches_side_filter('SELL_SHORT', 'SELL')")).toBe('True')
    expect(runFilterExpression("matches_side_filter('SELL_SHORT', 'BUY')")).toBe('False')
  })
})
