import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../../api/cloud/db/pgClient.js', () => ({ query: mocks.query }))

import { writeSecurityAudit } from '../../api/cloud/multiuser/audit/securityAuditStore.js'

describe('安全审计存储', () => {
  beforeEach(() => vi.clearAllMocks())

  it('哈希 IP 和 UA，序列化详情且不保存原文', async () => {
    mocks.query.mockResolvedValueOnce([])
    await writeSecurityAudit({
      actorUserId: 'actor',
      targetUserId: 'target',
      eventType: 'event',
      resourceType: 'order',
      resourceId: '1',
      success: true,
      ip: '1.2.3.4',
      userAgent: 'browser',
      detail: { reason: 'test' },
    })
    const params = mocks.query.mock.calls[0][1] as unknown[]
    expect(params).toHaveLength(9)
    expect(params).not.toContain('1.2.3.4')
    expect(params).not.toContain('browser')
    expect(params[8]).toBe('{"reason":"test"}')
  })

  it('缺省字段写 null，数据库失败不影响主流程', async () => {
    mocks.query.mockRejectedValueOnce(new Error('audit unavailable'))
    await expect(writeSecurityAudit({ eventType: 'event', success: false })).resolves.toBeUndefined()
    expect(mocks.query.mock.calls[0][1]).toEqual([
      null, null, 'event', null, null, false, null, null, null,
    ])
  })
})
