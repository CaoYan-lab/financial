import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from 'node:crypto'

const algorithm = 'aes-256-gcm'
const nonceBytes = 12

export type EncryptedCredential = {
  ciphertext: Buffer
  nonce: Buffer
  authTag: Buffer
}

export function decodeCredentialKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    throw new Error('MODEL_CREDENTIAL_KEY_INVALID')
  }
  return key
}

export function credentialAad(userId: string, configId: string): Buffer {
  return Buffer.from(`changfu:model-provider:${userId}:${configId}:v1`, 'utf8')
}

export function encryptCredential(
  plaintext: string,
  key: Buffer,
  aad: Buffer,
): EncryptedCredential {
  if (key.length !== 32) throw new Error('MODEL_CREDENTIAL_KEY_INVALID')
  const nonce = randomBytes(nonceBytes)
  const cipher = createCipheriv(algorithm, key, nonce)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return { ciphertext, nonce, authTag: cipher.getAuthTag() }
}

export function decryptCredential(
  encrypted: EncryptedCredential,
  key: Buffer,
  aad: Buffer,
): string {
  if (key.length !== 32) throw new Error('MODEL_CREDENTIAL_KEY_INVALID')
  const decipher = createDecipheriv(algorithm, key, encrypted.nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(encrypted.authTag)
  return Buffer.concat([
    decipher.update(encrypted.ciphertext),
    decipher.final(),
  ]).toString('utf8')
}
