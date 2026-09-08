import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
}))

vi.mock('../../api/cloud/db/pgClient.js', () => ({
  query: mocks.query,
  queryOne: mocks.queryOne,
}))

import {
  claimTenantJob,
  enqueueTenantJob,
  failTenantJob,
} from '../../api/cloud/multiuser/longbridge/tenantJobStore.js'

describe('Longbridge 租户任务存储', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('pending 绑定只允许入队连接验证任务', async () => {
    mocks.queryOne.mockResolvedValue({ id: '41' })

    await expect(enqueueTenantJob({
      userId: '7',
      bindingId: 'pending-binding',
      jobType: 'multiuser.longbridge.verify_connection',
    })).resolves.toBe('41')

    const [sql, params] = mocks.queryOne.mock.calls[0]
    expect(sql).toContain("status = 'pending'")
    expect(sql).toContain("$3 = 'multiuser.longbridge.verify_connection'")
    expect(params).toEqual([
      '7',
      'pending-binding',
      'multiuser.longbridge.verify_connection',
      '{}',
    ])
  })

  it('Worker 可认领 pending 的验证任务并保留租户键', async () => {
    mocks.queryOne.mockResolvedValue({
      id: '42',
      user_id: '7',
      binding_id: 'pending-binding',
      job_type: 'multiuser.longbridge.verify_connection',
      payload: {},
    })

    await expect(claimTenantJob('worker-1')).resolves.toEqual({
      id: '42',
      userId: '7',
      bindingId: 'pending-binding',
      jobType: 'multiuser.longbridge.verify_connection',
      payload: {},
    })

    const [sql, params] = mocks.queryOne.mock.calls[0]
    expect(sql).toContain("c.status = 'pending'")
    expect(sql).toContain("q.job_type = 'multiuser.longbridge.verify_connection'")
    expect(sql).toContain('c.id = q.binding_id AND c.user_id = q.user_id')
    expect(params).toEqual(['worker-1'])
  })

  it('凭据终验失败可直接进入失败终态而不重排队', async () => {
    await failTenantJob('42', '订单读取失败', false)

    const [sql, params] = mocks.query.mock.calls[0]
    expect(sql).toContain("WHEN NOT $3 OR attempts >= 3 THEN 'failed'")
    expect(params).toEqual(['42', '订单读取失败', false])
  })
})
