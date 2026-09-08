import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  hashPassword: vi.fn((value: string) => `hash:${value}`),
}))

vi.mock('../../api/cloud/db/pgClient.js', () => ({ query: mocks.query, queryOne: mocks.queryOne }))
vi.mock('../../api/cloud/multiuser/auth/passwordService.js', () => ({ hashPassword: mocks.hashPassword }))

import {
  changePassword,
  createMember,
  ensureOwnerProfile,
  getPasswordHash,
  getProfile,
  listProfiles,
  resetMemberPassword,
  setProfileActive,
} from '../../api/cloud/multiuser/auth/profileStore.js'

const row = {
  user_id: '1',
  username: 'member',
  display_name: '成员',
  role: 'member' as const,
  active: true,
  must_change_password: true,
  sessions_valid_after: new Date(0),
}

describe('多用户资料存储', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.MULTIUSER_OWNER_USERNAME = 'owner'
    mocks.query.mockResolvedValue([])
  })

  it('owner 配置缺失、用户缺失和冲突时 fail closed', async () => {
    delete process.env.MULTIUSER_OWNER_USERNAME
    delete process.env.ADMIN_USERNAME
    await expect(ensureOwnerProfile()).rejects.toThrow('未配置')

    process.env.ADMIN_USERNAME = 'admin'
    mocks.queryOne.mockResolvedValueOnce(null)
    await expect(ensureOwnerProfile()).rejects.toThrow('owner 用户不存在')

    mocks.queryOne
      .mockResolvedValueOnce({ id: '1' })
      .mockResolvedValueOnce({ user_id: '2' })
    await expect(ensureOwnerProfile()).rejects.toThrow('已存在其他 owner')
  })

  it('幂等建立 owner 和 legacy 绑定', async () => {
    mocks.queryOne
      .mockResolvedValueOnce({ id: '1' })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ user_id: '1' })
      .mockResolvedValueOnce({ id: 'legacy-longbridge-owner' })
    await ensureOwnerProfile()
    expect(mocks.queryOne).toHaveBeenCalledTimes(4)
  })

  it('读取单个和全部资料并标准化日期', async () => {
    mocks.queryOne.mockResolvedValueOnce(row).mockResolvedValueOnce(null)
    await expect(getProfile('1')).resolves.toMatchObject({
      userId: '1', username: 'member', sessionsValidAfter: new Date(0).toISOString(),
    })
    await expect(getProfile('missing')).resolves.toBeNull()
    mocks.query.mockResolvedValueOnce([row, { ...row, user_id: '2', username: 'member2' }])
    await expect(listProfiles()).resolves.toHaveLength(2)
  })

  it('创建成员并处理数据库未返回记录', async () => {
    mocks.queryOne.mockResolvedValueOnce(row)
    await expect(createMember({
      username: 'member',
      displayName: '成员',
      temporaryPassword: 'Password12',
      createdBy: 'owner',
    })).resolves.toMatchObject({ username: 'member', mustChangePassword: true })
    expect(mocks.hashPassword).toHaveBeenCalledWith('Password12')
    mocks.queryOne.mockResolvedValueOnce(null)
    await expect(createMember({
      username: 'broken', displayName: '失败', temporaryPassword: 'Password12', createdBy: 'owner',
    })).rejects.toThrow('创建用户失败')
  })

  it('启停、重置、改密和读取哈希使用 user_id 约束', async () => {
    await setProfileActive('1', false)
    await resetMemberPassword('1', 'Temporary12')
    await changePassword('1', 'NewPassword12')
    mocks.queryOne.mockResolvedValueOnce({ password_hash: 'hash' }).mockResolvedValueOnce(null)
    await expect(getPasswordHash('1')).resolves.toBe('hash')
    await expect(getPasswordHash('2')).resolves.toBeNull()
    expect(mocks.query).toHaveBeenCalledTimes(5)
    expect(mocks.hashPassword).toHaveBeenCalledWith('Temporary12')
    expect(mocks.hashPassword).toHaveBeenCalledWith('NewPassword12')
  })
})
