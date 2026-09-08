import type { JwtPayload } from '../auth/jwt.js'
import type { Request } from 'express'

export type MultiUserRole = 'owner' | 'member'

export type UserProfile = {
  userId: string
  username: string
  displayName: string
  role: MultiUserRole
  active: boolean
  mustChangePassword: boolean
  sessionsValidAfter: string
}

export type MultiUserRequest = Request & {
  user?: JwtPayload
  multiUser?: UserProfile
}

export type LongbridgeCredentialBundle = {
  appKey: string
  appSecret: string
  accessToken: string
}

export type BrokerConnection = {
  id: string
  userId: string
  platform: 'longbridge'
  credentialSource: 'legacy_env' | 'encrypted_bundle'
  status: 'pending' | 'verified' | 'invalid' | 'disabled'
  accountFingerprint?: string
  tokenExpiresAt?: string
  lastVerifiedAt?: string
  encrypted?: {
    ciphertext: string
    iv: string
    authTag: string
    keyVersion: number
  }
}
