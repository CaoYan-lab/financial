import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  credentialFingerprint,
  decryptCredentialBundle,
  encryptCredentialBundle,
  tokenExpiresAt,
  validateCredentialBundle,
} from '../../api/cloud/multiuser/longbridge/credentialVault.js'

const credentials = {
  appKey: 'app-key',
  appSecret: 'app-secret',
  accessToken: 'access-token',
}

describe('Longbridge 凭据保险箱', () => {
  const originalKey = process.env.MULTIUSER_CREDENTIAL_MASTER_KEY

  beforeEach(() => {
    process.env.MULTIUSER_CREDENTIAL_MASTER_KEY = randomBytes(32).toString('base64')
  })

  afterEach(() => {
    if (originalKey === undefined) delete process.env.MULTIUSER_CREDENTIAL_MASTER_KEY
    else process.env.MULTIUSER_CREDENTIAL_MASTER_KEY = originalKey
  })

  it('使用独立 IV 加密并可完整解密', () => {
    const first = encryptCredentialBundle(credentials)
    const second = encryptCredentialBundle(credentials)

    expect(first.iv).not.toBe(second.iv)
    expect(first.ciphertext).not.toContain(credentials.appSecret)
    expect(decryptCredentialBundle(first)).toEqual(credentials)
  })

  it('认证标签或主密钥被篡改时拒绝解密', () => {
    const encrypted = encryptCredentialBundle(credentials)
    const tag = Buffer.from(encrypted.authTag, 'base64')
    tag[0] ^= 0xff

    expect(() => decryptCredentialBundle({
      ...encrypted,
      authTag: tag.toString('base64'),
    })).toThrow()

    process.env.MULTIUSER_CREDENTIAL_MASTER_KEY = randomBytes(32).toString('base64')
    expect(() => decryptCredentialBundle(encrypted)).toThrow()
  })

  it('拒绝缺失字段和非法主密钥', () => {
    expect(() => validateCredentialBundle({ ...credentials, appSecret: ' ' })).toThrow('均不能为空')
    process.env.MULTIUSER_CREDENTIAL_MASTER_KEY = 'not-a-32-byte-key'
    expect(() => encryptCredentialBundle(credentials)).toThrow('32 字节')
  })

  it('指纹稳定且不包含凭据明文', () => {
    const fingerprint = credentialFingerprint(credentials)

    expect(credentialFingerprint(credentials)).toBe(fingerprint)
    expect(fingerprint).toHaveLength(16)
    expect(fingerprint).not.toContain(credentials.appKey)
    expect(fingerprint).not.toContain(credentials.accessToken)
  })

  it('解析带前缀的 JWT 到期时间', () => {
    const payload = Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString('base64url')
    const accessToken = `prefix_header.${payload}.signature`

    expect(tokenExpiresAt(accessToken)?.toISOString()).toBe('2033-05-18T03:33:20.000Z')
    expect(tokenExpiresAt('not-a-token')).toBeUndefined()
  })
})
