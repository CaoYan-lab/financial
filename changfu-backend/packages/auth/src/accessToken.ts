import { createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'

type JwtHeader = {
  alg: string
  typ?: string
  kid?: string
}

export type AccessClaims = {
  sub: string
  aud: string | string[]
  iss: string
  exp: number
  iat: number
  device_id: string
}

export class AccessTokenError extends Error {
  constructor(readonly code: string) {
    super('访问令牌无效')
    this.name = 'AccessTokenError'
  }
}

function encodePart(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

export function signAccessToken(input: {
  userId: string
  deviceId: string
  privateKeyPem: string
  keyId: string
  issuer: string
  audience: string
  ttlSeconds?: number
  now?: Date
}): { token: string; expiresAt: Date } {
  if (!/^[1-9][0-9]*$/.test(input.userId)) throw new AccessTokenError('TOKEN_SUBJECT_INVALID')
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000)
  const ttlSeconds = input.ttlSeconds ?? 15 * 60
  const expiresAt = new Date((nowSeconds + ttlSeconds) * 1000)
  const header = encodePart({ alg: 'EdDSA', typ: 'JWT', kid: input.keyId })
  const claims = encodePart({
    sub: input.userId,
    device_id: input.deviceId,
    iss: input.issuer,
    aud: input.audience,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
  })
  const signature = sign(
    null,
    Buffer.from(`${header}.${claims}`),
    createPrivateKey(input.privateKeyPem),
  ).toString('base64url')
  return { token: `${header}.${claims}.${signature}`, expiresAt }
}

function decodePart<T>(part: string): T {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as T
  } catch {
    throw new AccessTokenError('TOKEN_MALFORMED')
  }
}

export function verifyAccessToken(
  token: string,
  options: {
    publicKeyPem: string
    issuer: string
    audience: string
    now?: Date
  },
): AccessClaims {
  const parts = token.split('.')
  if (parts.length !== 3) throw new AccessTokenError('TOKEN_MALFORMED')
  const [headerPart, claimsPart, signaturePart] = parts
  if (!headerPart || !claimsPart || !signaturePart) throw new AccessTokenError('TOKEN_MALFORMED')

  const header = decodePart<JwtHeader>(headerPart)
  const claims = decodePart<AccessClaims>(claimsPart)
  if (header.alg !== 'EdDSA') throw new AccessTokenError('TOKEN_ALGORITHM_REJECTED')
  if (
    typeof claims.sub !== 'string'
    || !/^[1-9][0-9]*$/.test(claims.sub)
    || typeof claims.exp !== 'number'
    || typeof claims.iat !== 'number'
    || typeof claims.device_id !== 'string'
  ) {
    throw new AccessTokenError('TOKEN_CLAIMS_INVALID')
  }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (claims.iss !== options.issuer || !audiences.includes(options.audience)) {
    throw new AccessTokenError('TOKEN_SCOPE_INVALID')
  }
  const nowSeconds = Math.floor((options.now ?? new Date()).getTime() / 1000)
  if (claims.exp <= nowSeconds || claims.iat > nowSeconds + 5) {
    throw new AccessTokenError('TOKEN_EXPIRED')
  }

  const valid = verify(
    null,
    Buffer.from(`${headerPart}.${claimsPart}`),
    createPublicKey(options.publicKeyPem),
    Buffer.from(signaturePart, 'base64url'),
  )
  if (!valid) throw new AccessTokenError('TOKEN_SIGNATURE_INVALID')
  return claims
}
