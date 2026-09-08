import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import type { LongbridgeCredentialBundle } from '../types.js'

export type EncryptedCredentialBundle = {
  ciphertext: string
  iv: string
  authTag: string
  keyVersion: number
}

function encryptionKey(): Buffer {
  const raw = process.env.MULTIUSER_CREDENTIAL_MASTER_KEY?.trim()
  if (!raw) throw new Error('MULTIUSER_CREDENTIAL_MASTER_KEY 未配置')
  const decoded = Buffer.from(raw, 'base64')
  if (decoded.length !== 32) throw new Error('MULTIUSER_CREDENTIAL_MASTER_KEY 必须为 32 字节 Base64')
  return decoded
}

export function validateCredentialBundle(bundle: LongbridgeCredentialBundle): void {
  if (!bundle.appKey.trim() || !bundle.appSecret.trim() || !bundle.accessToken.trim()) {
    throw new Error('App Key、App Secret、Access Token 均不能为空')
  }
}

export function encryptCredentialBundle(
  bundle: LongbridgeCredentialBundle,
): EncryptedCredentialBundle {
  validateCredentialBundle(bundle)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const plaintext = Buffer.from(JSON.stringify(bundle), 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion: 1,
  }
}

export function decryptCredentialBundle(
  encrypted: EncryptedCredentialBundle,
): LongbridgeCredentialBundle {
  if (encrypted.keyVersion !== 1) throw new Error(`不支持的凭据密钥版本：${encrypted.keyVersion}`)
  const decipher = createDecipheriv(
    'aes-256-gcm',
    encryptionKey(),
    Buffer.from(encrypted.iv, 'base64'),
  )
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'))
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
    decipher.final(),
  ])
  const bundle = JSON.parse(plaintext.toString('utf8')) as LongbridgeCredentialBundle
  validateCredentialBundle(bundle)
  return bundle
}

export function credentialFingerprint(bundle: LongbridgeCredentialBundle): string {
  return createHash('sha256')
    .update(bundle.appKey)
    .update('\0')
    .update(bundle.accessToken)
    .digest('hex')
    .slice(0, 16)
}

export function tokenExpiresAt(accessToken: string): Date | undefined {
  try {
    const jwt = accessToken.includes('_') ? accessToken.slice(accessToken.indexOf('_') + 1) : accessToken
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8')) as { exp?: number }
    return Number.isFinite(payload.exp) ? new Date(Number(payload.exp) * 1_000) : undefined
  } catch {
    return undefined
  }
}
