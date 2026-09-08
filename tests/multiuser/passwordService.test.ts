import { describe, expect, it } from 'vitest'
import {
  hashPassword,
  validatePassword,
  verifyPassword,
} from '../../api/cloud/multiuser/auth/passwordService.js'

describe('多用户密码服务', () => {
  it('要求至少 12 位且同时包含字母和数字', () => {
    expect(validatePassword('short1')).toContain('至少')
    expect(validatePassword('abcdefghijkl')).toContain('字母和数字')
    expect(validatePassword('123456789012')).toContain('字母和数字')
    expect(validatePassword('StrongPassword12')).toBeUndefined()
  })

  it('使用独立 salt 生成不可复用的哈希', () => {
    const first = hashPassword('StrongPassword12')
    const second = hashPassword('StrongPassword12')

    expect(first).not.toBe(second)
    expect(verifyPassword('StrongPassword12', first)).toBe(true)
    expect(verifyPassword('StrongPassword12', second)).toBe(true)
  })

  it('拒绝错误密码和非法哈希格式', () => {
    const stored = hashPassword('StrongPassword12')

    expect(verifyPassword('WrongPassword12', stored)).toBe(false)
    expect(verifyPassword('StrongPassword12', 'invalid')).toBe(false)
  })
})
