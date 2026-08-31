import { describe, expect, it } from 'vitest'
import { normalizeFutuOrderQuery } from '../api/simulation/futuSimulationOrderService'

describe('futu simulation orders', () => {
  it('默认使用结束日期前 7 天作为订单查询范围', () => {
    const query = normalizeFutuOrderQuery({ endDate: '2026-06-17' })

    expect(query.startDate).toBe('2026-06-10')
    expect(query.endDate).toBe('2026-06-17')
  })

  it('分页参数会被限制在安全范围内', () => {
    const query = normalizeFutuOrderQuery({ page: -3, pageSize: 999, endDate: '2026-06-17' })

    expect(query.page).toBe(1)
    expect(query.pageSize).toBe(100)
  })

  it('仅允许用户股票池内 ticker 作为 Futu 订单筛选条件', () => {
    expect(normalizeFutuOrderQuery({ ticker: 'spcx' }).ticker).toBe('SPCX')
    expect(normalizeFutuOrderQuery({ ticker: 'MSFT' }).ticker).toBeUndefined()
  })
})
