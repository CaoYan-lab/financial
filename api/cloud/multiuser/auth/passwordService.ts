import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'

const SCRYPT_KEYLEN = 64
const MIN_PASSWORD_LENGTH = 12

export function validatePassword(password: string): string | undefined {
  if (password.length < MIN_PASSWORD_LENGTH) return `密码至少需要 ${MIN_PASSWORD_LENGTH} 位`
  if (!/[A-Za-z]/.test(password) || !/\d/.test(password)) return '密码必须同时包含字母和数字'
  return undefined
}

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex')
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex')
  return `scrypt$${salt}$${derived}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const expected = Buffer.from(parts[2], 'hex')
  const actual = scryptSync(password, parts[1], SCRYPT_KEYLEN)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
