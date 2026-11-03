import type { Context } from 'hono'

import { getUser } from '../users.ts'
import { bearerToken, verifyToken } from './tokens.ts'

/** The signed-in user, as the API sees them. Never includes password material. */
export interface SessionUser {
  userId: string
  email?: string
  username?: string
  firstName?: string
  lastName?: string
  photoUrl?: string
  roles: string[]
  /**
   * The notification tags this account hears. The app asks for notification
   * permission only when this is not empty — no tags, no prompt, ever.
   */
  notificationTags: string[]
}

/**
 * Resolves the caller from `Authorization: Bearer`.
 *
 * Null when the header is missing, the token is invalid or expired, or the
 * account has since been deactivated — the last one is why the user is re-read
 * rather than trusted from the token.
 */
export async function sessionUser(c: Context): Promise<SessionUser | null> {
  const token = bearerToken(c.req.header('authorization'))
  if (!token) return null

  const userId = verifyToken(token)
  if (!userId) return null

  const user = await getUser(userId)
  if (!user || !('userId' in user) || !user.userId) return null
  if (user.active === false) return null

  return {
    userId: user.userId,
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    photoUrl: user.photoUrl,
    roles: user.roles ?? [],
    notificationTags: user.notificationTags ?? [],
  }
}

/** The caller, or the 401 response to send. */
export async function requireUser(c: Context): Promise<SessionUser | Response> {
  const user = await sessionUser(c)
  if (!user) return c.json({ error: 'Not signed in' }, 401)
  return user
}

/** The caller holding any one of `roles`, or the response to send. */
export async function requireRoles(
  c: Context,
  roles: readonly string[],
): Promise<SessionUser | Response> {
  const user = await requireUser(c)
  if (user instanceof Response) return user
  if (!roles.some((role) => user.roles.includes(role))) {
    return c.json({ error: 'You do not have access to this' }, 403)
  }
  return user
}

/**
 * The caller as an administrator, or the response to send.
 *
 * The website's admin pages hard-check `administrator` rather than accepting
 * every role their shell allows, and this matches that.
 */
export async function requireAdmin(c: Context): Promise<SessionUser | Response> {
  const user = await requireRoles(c, ['administrator'])
  if (user instanceof Response) return user
  return user
}
