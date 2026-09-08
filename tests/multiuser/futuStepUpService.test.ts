import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  getPasswordHash: vi.fn(),
  hashPassword: vi.fn((value: string) => `hash:${value}`),
  validatePassword: vi.fn(),
  verifyPassword: vi.fn((value: string, hash: string) => hash === `hash:${value}`),
}))

vi.mock('../../api/cloud/db/pgClient.js', () => ({ query: mocks.query, queryOne: mocks.queryOne }))
vi.mock('../../api/cloud/multiuser/auth/profileStore.js', () => ({ getPasswordHash: mocks.getPasswordHash }))
vi.mock('../../api/cloud/multiuser/auth/passwordService.js', () => ({
  hashPassword: mocks.hashPassword,
  validatePassword: mocks.validatePassword,
  verifyPassword: mocks.verifyPassword,
}))

import {
  createFutuUnlock,
  futuSecretConfigured,
  revokeFutuUnlock,
  setFutuSecondaryPassword,
  validateFutuUnlock,
} from '../../api/cloud/multiuser/futu/futuStepUpService.js'

describe('Futu 二次验证服务', () => {
  beforeEach(() => vi.clearAllMocks())

  it('查询二次密码配置状态', async () => {
    mocks.queryOne.mockResolvedValue({ configured: true })
    await expect(futuSecretConfigured('1')).resolves.toBe(true)
    expect(mocks.queryOne.mock.calls[0][1]).toEqual(['1'])
  })

  it('校验主密码、密码强度和密码不同性', async () => {
    mocks.validatePassword.mockReturnValueOnce('密码太弱')
    await expect(setFutuSecondaryPassword({
      ownerUserId: '1', currentPassword: 'a', secondaryPassword: 'b',
    })).rejects.toThrow('密码太弱')

    mocks.validatePassword.mockReturnValue(undefined)
    mocks.getPasswordHash.mockResolvedValue('hash:Primary123456')
    await expect(setFutuSecondaryPassword({
      ownerUserId: '1', currentPassword: 'wrong', secondaryPassword: 'Secondary123456',
    })).rejects.toThrow('当前登录密码错误')
    await expect(setFutuSecondaryPassword({
      ownerUserId: '1', currentPassword: 'Primary123456', secondaryPassword: 'Primary123456',
    })).rejects.toThrow('不能与登录密码相同')
    expect(mocks.query).not.toHaveBeenCalled()
  })

  it('设置新密码并撤销全部旧解锁会话', async () => {
    mocks.validatePassword.mockReturnValue(undefined)
    mocks.getPasswordHash.mockResolvedValue('hash:Primary123456')
    await setFutuSecondaryPassword({
      ownerUserId: '1',
      currentPassword: 'Primary123456',
      secondaryPassword: 'Secondary123456',
    })
    expect(mocks.query).toHaveBeenCalledTimes(2)
    expect(mocks.query.mock.calls[0][1]).toEqual(['1', 'hash:Secondary123456'])
    expect(mocks.query.mock.calls[1][0]).toContain('revoked_at = now()')
  })

  it('拒绝未配置或错误的二次密码', async () => {
    mocks.queryOne.mockResolvedValueOnce(null)
    await expect(createFutuUnlock({ ownerUserId: '1', secondaryPassword: 'x' }))
      .rejects.toThrow('FUTU_STEP_UP_SETUP_REQUIRED')
    mocks.queryOne.mockResolvedValueOnce({ password_hash: 'hash:right' })
    await expect(createFutuUnlock({ ownerUserId: '1', secondaryPassword: 'wrong' }))
      .rejects.toThrow('FUTU_SECONDARY_PASSWORD_INVALID')
  })

  it('创建会话时只存 token 哈希并绑定上下文哈希', async () => {
    mocks.queryOne.mockResolvedValue({ password_hash: 'hash:right' })
    const token = await createFutuUnlock({
      ownerUserId: '1',
      secondaryPassword: 'right',
      ip: '127.0.0.1',
      userAgent: 'vitest',
    })
    const params = mocks.query.mock.calls[0][1] as string[]
    expect(token).toHaveLength(43)
    expect(params.join('|')).not.toContain(token)
    expect(params.join('|')).not.toContain('127.0.0.1')
    expect(params.join('|')).not.toContain('vitest')
  })

  it('有效令牌滑动续期，无令牌直接拒绝', async () => {
    await expect(validateFutuUnlock('1', null)).resolves.toBe(false)
    expect(mocks.queryOne).not.toHaveBeenCalled()
    mocks.queryOne.mockResolvedValue({ id: 'unlock-1' })
    await expect(validateFutuUnlock('1', 'opaque')).resolves.toBe(true)
    expect(mocks.queryOne.mock.calls[0][0]).toContain('expires_at = now()')
  })

  it('主动撤销仅作用于当前 owner 和令牌', async () => {
    await revokeFutuUnlock('1', null)
    expect(mocks.query).not.toHaveBeenCalled()
    await revokeFutuUnlock('1', 'opaque')
    expect(mocks.query.mock.calls[0][1]?.[0]).toBe('1')
    expect(mocks.query.mock.calls[0][1]?.[1]).not.toBe('opaque')
  })
})
