import jwt from 'jsonwebtoken'

/**
 * Tokens for the Kiosk Connect signaling socket.
 *
 * The socket server used to live in `cooperrtc`, which trusted tokens v1 signed
 * with `jwtSecret`: `{ type: 'operator', session }` for the operator console and
 * `{ type: 'kiosk', rtcDeviceId }` for a device. Those tokens are still honoured
 * here — a device in the field holds one for four days, and pointing its page at
 * this service must not log it out — while new ones are minted with the same
 * secret and the same shape so either service can verify the other's.
 *
 * `RTC_AUTH_SECRET` overrides the signing key; without it the website's
 * `jwtSecret` is used, which is what every kiosk already carries.
 */

const OPERATOR_TTL_SECONDS = 60 * 60 // v1's hour
const KIOSK_TTL_SECONDS = 60 * 60 * 96 // v1's four days

function tokenSecret(): string | null {
  return process.env.RTC_AUTH_SECRET ?? process.env.jwtSecret ?? process.env.AUTH_SECRET ?? null
}

export interface OperatorTokenUser {
  userId: string
  roles: string[]
}

export interface RtcToken {
  token: string
  /** ISO timestamp the token stops being accepted. */
  expiresOn: string
}

/** The console's token: who is calling, and what they may do in the admin API. */
export function mintOperatorToken(user: OperatorTokenUser): RtcToken {
  const secret = tokenSecret()
  if (!secret) {
    throw new Error('Please add jwtSecret (or RTC_AUTH_SECRET) to the environment')
  }

  return {
    token: jwt.sign(
      { type: 'operator', userId: user.userId, roles: user.roles },
      secret,
      { expiresIn: OPERATOR_TTL_SECONDS },
    ),
    expiresOn: new Date(Date.now() + OPERATOR_TTL_SECONDS * 1000).toISOString(),
  }
}

/** A device's token: only its own id, since a kiosk has no user to speak of. */
export function mintKioskToken(deviceId: string): RtcToken {
  const secret = tokenSecret()
  if (!secret) {
    throw new Error('Please add jwtSecret (or RTC_AUTH_SECRET) to the environment')
  }

  return {
    token: jwt.sign({ type: 'kiosk', rtcDeviceId: deviceId }, secret, {
      expiresIn: KIOSK_TTL_SECONDS,
    }),
    expiresOn: new Date(Date.now() + KIOSK_TTL_SECONDS * 1000).toISOString(),
  }
}

export type RtcIdentity =
  | { kind: 'operator'; userId?: string; roles: string[] }
  | { kind: 'kiosk'; deviceId: string }

/**
 * Who a socket claims to be, or null when the token is not one of ours.
 *
 * `client` is accepted as a device: it is the type the old socket server's own
 * token helpers used where v1's pages sign `kiosk`, and both mean the same
 * thing — this end of the call is a kiosk.
 */
export function verifyRtcToken(raw: unknown): RtcIdentity | null {
  const secret = tokenSecret()
  const token = typeof raw === 'string' ? raw.trim() : ''
  if (!secret || !token) return null

  try {
    const decoded = jwt.verify(token, secret)
    if (!decoded || typeof decoded !== 'object') return null

    const payload = decoded as Record<string, unknown>
    const type = payload.type

    if (type === 'kiosk' || type === 'client') {
      const deviceId = payload.rtcDeviceId
      if (typeof deviceId !== 'string' || !deviceId.trim()) return null
      return { kind: 'kiosk', deviceId: deviceId.trim() }
    }

    if (type === 'operator') {
      return {
        kind: 'operator',
        ...(typeof payload.userId === 'string' ? { userId: payload.userId } : {}),
        roles: Array.isArray(payload.roles)
          ? payload.roles.filter((role): role is string => typeof role === 'string')
          : [],
      }
    }

    return null
  } catch {
    return null
  }
}
