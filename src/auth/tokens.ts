import jwt from 'jsonwebtoken'

/**
 * Bearer tokens for the native app.
 *
 * The website authenticates with an httpOnly cookie, which a native client can
 * neither read nor send. The app signs in through this API instead and carries a
 * signed token in `Authorization: Bearer`.
 *
 * The token only carries the user id. Roles and profile are re-read from Mongo on
 * every request, so a deactivated user loses access immediately even though the
 * token itself is still valid for weeks.
 */

const ISSUER = 'inssapp'
const AUDIENCE = 'inss-support'
const TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days

function tokenSecret(): string {
  const secret = process.env.MOBILE_AUTH_SECRET ?? process.env.AUTH_SECRET
  if (!secret) {
    throw new Error('Please add AUTH_SECRET (or MOBILE_AUTH_SECRET) to the environment')
  }
  return secret
}

export function mintToken(userId: string): string {
  return jwt.sign({}, tokenSecret(), {
    subject: userId,
    expiresIn: TTL_SECONDS,
    issuer: ISSUER,
    audience: AUDIENCE,
  })
}

/** Returns the user id carried by a token, or null when the token is not ours. */
export function verifyToken(token: string): string | null {
  try {
    const payload = jwt.verify(token, tokenSecret(), {
      issuer: ISSUER,
      audience: AUDIENCE,
    })
    if (payload && typeof payload === 'object' && payload.sub) {
      return String(payload.sub)
    }
    return null
  } catch {
    return null
  }
}

/** The token in an Authorization header, or an empty string. */
export function bearerToken(header: string | undefined): string {
  const [scheme, value] = (header ?? '').split(' ')
  if (!value || scheme.toLowerCase() !== 'bearer') return ''
  return value.trim()
}
