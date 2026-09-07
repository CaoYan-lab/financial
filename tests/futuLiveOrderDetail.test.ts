import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

function detailDateRange(value: string) {
  const result = spawnSync('python3', [
    '-c',
    [
      'import sys',
      "sys.path.insert(0, 'api/futu_bridge')",
      'from futu_live_order_detail import detail_date_range',
      `print('|'.join(detail_date_range('${value}')))`,
    ].join('\n'),
  ], { encoding: 'utf8' })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  return result.stdout.trim()
}

describe('Futu 券商订单详情日期范围', () => {
  it('兼容券商返回的无时区提交时间', () => {
    const naive = detailDateRange('2026-09-05 12:27:59.087')
    const utc = detailDateRange('2026-09-05T12:27:59.087Z')

    expect(naive).toBe(utc)
    expect(naive).toMatch(/^\d{4}-\d{2}-\d{2}\|\d{4}-\d{2}-\d{2}$/)
  })
})
