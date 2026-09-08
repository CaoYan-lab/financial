import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  fingerprint: vi.fn(() => 'fingerprint'),
  decrypt: vi.fn(() => ({ appKey: 'key', appSecret: 'secret', accessToken: 'token' })),
  encrypt: vi.fn(() => ({ ciphertext: 'cipher', iv: 'iv', authTag: 'tag', keyVersion: 1 })),
  expiresAt: vi.fn(() => new Date('2030-01-01T00:00:00.000Z')),
}))

vi.mock('../../api/cloud/db/pgClient.js', () => ({
  query: mocks.query,
  queryOne: mocks.queryOne,
  getPool: () => ({ connect: mocks.connect }),
}))
vi.mock('../../api/cloud/multiuser/longbridge/credentialVault.js', () => ({
  credentialFingerprint: mocks.fingerprint,
  decryptCredentialBundle: mocks.decrypt,
  encryptCredentialBundle: mocks.encrypt,
  tokenExpiresAt: mocks.expiresAt,
}))

import {
  credentialsForConnection,
  disableConnection,
  getActiveConnection,
  getConnectionForVerification,
  getOwnedConnection,
  markConnectionInvalid,
  markConnectionVerified,
  savePendingConnection,
} from '../../api/cloud/multiuser/longbridge/connectionStore.js'

const row = {
  id: 'binding-1',
  user_id: 'user-1',
  platform: 'longbridge' as const,
  credential_source: 'encrypted_bundle' as const,
  credential_ciphertext: 'cipher',
  credential_iv: 'iv',
  credential_auth_tag: 'tag',
  key_version: 1,
  account_fingerprint: 'fingerprint',
  status: 'verified' as const,
  token_expires_at: new Date('2030-01-01T00:00:00.000Z'),
  last_verified_at: new Date('2026-01-01T00:00:00.000Z'),
}

describe('Longbridge 连接存储', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.query.mockResolvedValue([])
    mocks.queryOne.mockResolvedValue(row)
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release })
    mocks.clientQuery.mockResolvedValue({ rows: [{ ...row, status: 'pending' }] })
  })

  it('查询活动、归属和待验证连接并标准化加密字段', async () => {
    await expect(getActiveConnection('user-1')).resolves.toMatchObject({
      id: 'binding-1',
      encrypted: { ciphertext: 'cipher', iv: 'iv', authTag: 'tag', keyVersion: 1 },
      tokenExpiresAt: '2030-01-01T00:00:00.000Z',
      lastVerifiedAt: '2026-01-01T00:00:00.000Z',
    })
    await expect(getOwnedConnection('user-1', 'binding-1')).resolves.toMatchObject({ id: 'binding-1' })
    await expect(getConnectionForVerification('user-1', 'binding-1')).resolves.toMatchObject({ id: 'binding-1' })
    mocks.queryOne.mockResolvedValueOnce(null)
    await expect(getActiveConnection('missing')).resolves.toBeNull()
  })

  it('保存 pending 连接时加密凭据并提交事务', async () => {
    await expect(savePendingConnection('user-1', {
      appKey: 'key', appSecret: 'secret', accessToken: 'token',
    })).resolves.toMatchObject({ status: 'pending' })
    expect(mocks.clientQuery.mock.calls[0][0]).toBe('BEGIN')
    expect(mocks.clientQuery.mock.calls.at(-1)?.[0]).toBe('COMMIT')
    expect(mocks.release).toHaveBeenCalled()
  })

  it('保存失败时回滚并释放连接', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('insert failed'))
      .mockResolvedValueOnce(undefined)
    await expect(savePendingConnection('user-1', {
      appKey: 'key', appSecret: 'secret', accessToken: 'token',
    })).rejects.toThrow('insert failed')
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK')
    expect(mocks.release).toHaveBeenCalled()
  })

  it('验证连接使用事务禁用旧绑定并初始化引擎状态', async () => {
    mocks.clientQuery.mockResolvedValue(undefined)
    await markConnectionVerified('user-1', 'binding-1')
    expect(mocks.clientQuery).toHaveBeenCalledTimes(5)
    expect(mocks.clientQuery.mock.calls[0][0]).toBe('BEGIN')
    expect(mocks.clientQuery.mock.calls[4][0]).toBe('COMMIT')
  })

  it('验证失败时回滚事务', async () => {
    mocks.clientQuery
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('update failed'))
      .mockResolvedValueOnce(undefined)
    await expect(markConnectionVerified('user-1', 'binding-1')).rejects.toThrow('update failed')
    expect(mocks.clientQuery).toHaveBeenCalledWith('ROLLBACK')
    expect(mocks.release).toHaveBeenCalled()
  })

  it('禁用和标记无效严格携带租户或连接键', async () => {
    await disableConnection('user-1')
    await markConnectionInvalid('binding-1')
    expect(mocks.query.mock.calls[0][1]).toEqual(['user-1'])
    expect(mocks.query.mock.calls[1][1]).toEqual(['binding-1'])
  })

  it('按来源读取 legacy 或加密凭据并拒绝缺失配置', () => {
    const original = {
      key: process.env.LONGBRIDGE_APP_KEY,
      secret: process.env.LONGBRIDGE_APP_SECRET,
      token: process.env.LONGBRIDGE_ACCESS_TOKEN,
    }
    process.env.LONGBRIDGE_APP_KEY = 'env-key'
    process.env.LONGBRIDGE_APP_SECRET = 'env-secret'
    process.env.LONGBRIDGE_ACCESS_TOKEN = 'env-token'
    expect(credentialsForConnection({
      id: 'legacy', userId: 'owner', platform: 'longbridge',
      credentialSource: 'legacy_env', status: 'verified',
    })).toEqual({ appKey: 'env-key', appSecret: 'env-secret', accessToken: 'env-token' })
    delete process.env.LONGBRIDGE_APP_KEY
    expect(() => credentialsForConnection({
      id: 'legacy', userId: 'owner', platform: 'longbridge',
      credentialSource: 'legacy_env', status: 'verified',
    })).toThrow('环境变量凭据未配置')
    expect(() => credentialsForConnection({
      id: 'encrypted', userId: 'user', platform: 'longbridge',
      credentialSource: 'encrypted_bundle', status: 'verified',
    })).toThrow('加密凭据不完整')
    expect(credentialsForConnection({
      id: 'encrypted', userId: 'user', platform: 'longbridge',
      credentialSource: 'encrypted_bundle', status: 'verified',
      encrypted: { ciphertext: 'cipher', iv: 'iv', authTag: 'tag', keyVersion: 1 },
    })).toEqual({ appKey: 'key', appSecret: 'secret', accessToken: 'token' })
    if (original.key === undefined) delete process.env.LONGBRIDGE_APP_KEY
    else process.env.LONGBRIDGE_APP_KEY = original.key
    if (original.secret === undefined) delete process.env.LONGBRIDGE_APP_SECRET
    else process.env.LONGBRIDGE_APP_SECRET = original.secret
    if (original.token === undefined) delete process.env.LONGBRIDGE_ACCESS_TOKEN
    else process.env.LONGBRIDGE_ACCESS_TOKEN = original.token
  })
})
