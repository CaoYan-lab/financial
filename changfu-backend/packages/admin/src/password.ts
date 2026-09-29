import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const keyLength = 64

function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, (error, value) => {
      if (error) reject(error)
      else resolve(value as Buffer)
    })
  })
}

export function validateAdminPassword(password: string): boolean {
  return (
    password.length >= 12
    && password.length <= 256
    && /[A-Za-z]/.test(password)
    && /\d/.test(password)
  )
}

export async function hashAdminPassword(password: string): Promise<string> {
  if (!validateAdminPassword(password)) throw new Error('ADMIN_PASSWORD_INVALID')
  const salt = randomBytes(16).toString('hex')
  const key = await derive(password, salt)
  return `scrypt$${salt}$${key.toString('hex')}`
}

export async function verifyAdminPassword(password: string, stored: string): Promise<boolean> {
  const [algorithm, salt, encoded] = stored.split('$')
  if (algorithm !== 'scrypt' || !salt || !encoded) return false
  const expected = Buffer.from(encoded, 'hex')
  const actual = await derive(password, salt)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
