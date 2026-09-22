import { beforeEach, describe, expect, it, vi } from 'vitest'

const pgMocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('../../api/cloud/db/pgClient.js', () => pgMocks)

import {
  claimNextJob,
  enqueueLatestJob,
  failOrphanedRunningJobs,
} from '../../api/cloud/state/taskStores.js'

describe('云端任务分泳道存储', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('交互泳道只认领券商交互任务', async () => {
    pgMocks.queryOne.mockResolvedValue({
      id: '42',
      job_type: 'longbridge_live.orders',
      payload: { requestedBy: 'admin' },
    })

    await expect(claimNextJob('worker-new', 'interactive')).resolves.toEqual({
      id: '42',
      jobType: 'longbridge_live.orders',
      payload: { requestedBy: 'admin' },
    })

    expect(pgMocks.queryOne).toHaveBeenCalledWith(
      expect.stringContaining(`$2::text = 'interactive'`),
      expect.arrayContaining([
        'worker-new',
        'interactive',
        expect.arrayContaining(['longbridge_live.orders', 'longbridge_live.confirm']),
      ]),
    )
  })

  it('订单列表入队时替代同一用户的旧排队请求', async () => {
    pgMocks.queryOne.mockResolvedValue({ id: '43' })

    await expect(enqueueLatestJob('longbridge_live.orders', {
      requestedBy: 'admin',
      page: 2,
    })).resolves.toBe('43')

    expect(pgMocks.queryOne).toHaveBeenCalledWith(
      expect.stringContaining(`last_error = '已由较新的同类请求替代。'`),
      [
        'longbridge_live.orders',
        JSON.stringify({ requestedBy: 'admin', page: 2 }),
        'admin',
      ],
    )
  })

  it('新 Worker 接管后终止其他 Worker 遗留的运行中任务', async () => {
    pgMocks.query.mockResolvedValue([{ id: '40' }, { id: '41' }])

    await expect(failOrphanedRunningJobs('worker-new')).resolves.toBe(2)
    expect(pgMocks.query).toHaveBeenCalledWith(
      expect.stringContaining(`claimed_by IS DISTINCT FROM $1`),
      ['worker-new'],
    )
  })
})
