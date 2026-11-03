import { Hono } from 'hono'

import { landingPage } from '../auth/landingPage.ts'
import { login } from '../auth/login.ts'
import {
  createMagicLinkToken,
  findActiveUserByEmail,
  postmarkKey,
  redeemMagicLinkToken,
  sendMagicLinkEmail,
} from '../auth/magicLink.ts'
import { sessionUser } from '../auth/session.ts'
import { mintToken } from '../auth/tokens.ts'
import { publicOrigin } from '../env.ts'
import { fail, readJson, text } from '../http.ts'
import { getUser } from '../users.ts'

/**
 * Sign-in for the app.
 *
 * Both routes answer with the same bearer token, so the app has one session
 * regardless of how the person signed in.
 */

export const authRoutes = new Hono()

const DEEP_LINK_SCHEME = 'inssappv2'

/**
 * POST /api/mobile/auth/signin   { username | email, password }
 *
 * Success: { token, user }
 *
 * The password check is the website's, so the app and the site accept exactly
 * the same accounts.
 */
authRoutes.post('/signin', async (c) => {
  const body = await readJson(c)
  const username = text(body.username) || text(body.email)
  const password = typeof body.password === 'string' ? body.password : ''

  if (!username || !password) {
    return fail(c, 'Email and password are required', 400)
  }

  const result = await login(username, password)
  if (!('success' in result) || !result.success) {
    // Deliberately generic: never reveal whether the account exists.
    return fail(c, 'Email or password is incorrect', 401)
  }

  const user = await getUser(result.userId)
  const profile =
    user && 'userId' in user
      ? {
          userId: user.userId,
          email: user.email,
          username: user.username,
          firstName: user.firstName,
          lastName: user.lastName,
          photoUrl: user.photoUrl,
          roles: user.roles ?? [],
          notificationTags: user.notificationTags ?? [],
        }
      : { userId: result.userId, roles: [] as string[], notificationTags: [] as string[] }

  return c.json({ token: mintToken(result.userId), user: profile })
})

/**
 * GET /api/mobile/auth/session
 *
 * Success: { user }
 *
 * The app calls this on launch to check its stored token and to pick up profile
 * or role changes. The user is re-read, so a deactivated account is rejected
 * here even though its token has not expired.
 */
authRoutes.get('/session', async (c) => {
  const user = await sessionUser(c)
  if (!user) return fail(c, 'Not signed in', 401)
  return c.json({ user })
})

/**
 * POST /api/mobile/auth/magic-link   { email }
 *   Emails a one-time link. Answers identically whether or not the address
 *   belongs to an active user, so it cannot be used to discover accounts.
 *
 * GET  /api/mobile/auth/magic-link?token=…
 *   Redeems the link and hands the token to the app through the custom scheme.
 */
authRoutes.post('/magic-link', async (c) => {
  const body = await readJson(c)
  const email = text(body.email)
  if (!email || !email.includes('@')) {
    return fail(c, 'A valid email address is required', 400)
  }

  const isDev = process.env.NODE_ENV !== 'production'
  const userId = await findActiveUserByEmail(email)

  if (!userId) {
    return c.json({ sent: true, ...(isDev ? { dev: { matched: false } } : {}) })
  }

  const raw = await createMagicLinkToken(userId, email)
  const origin = publicOrigin(c.req.url)
  const link = `${origin}/api/mobile/auth/magic-link?token=${encodeURIComponent(raw)}`
  const delivered = await sendMagicLinkEmail(email, link)
  if (!delivered) {
    console.error('[auth] magic link not delivered', { configured: Boolean(postmarkKey()) })
  }

  return c.json({
    sent: true,
    // Development only: lets the flow be exercised without an inbox.
    ...(isDev ? { dev: { matched: true, link, delivered } } : {}),
  })
})

authRoutes.get('/magic-link', async (c) => {
  const raw = c.req.query('token') ?? ''
  if (!raw) {
    return c.html(
      landingPage({
        title: 'Link is incomplete',
        message: 'This sign-in link is missing its token. Request a new link from the app.',
        tone: 'error',
      }),
      400,
    )
  }

  const userId = await redeemMagicLinkToken(raw)
  if (!userId) {
    return c.html(
      landingPage({
        title: 'Link has expired',
        message:
          'This link has already been used or is more than 15 minutes old. Request a new one from the app.',
        tone: 'error',
      }),
      400,
    )
  }

  const user = await getUser(userId)
  if (!user || !('userId' in user) || user.active === false) {
    return c.html(
      landingPage({
        title: 'Account is not active',
        message:
          'This account cannot sign in. Contact an administrator if you think that is a mistake.',
        tone: 'error',
      }),
      403,
    )
  }

  const token = mintToken(userId)
  const deepLink = `${DEEP_LINK_SCHEME}://auth/callback?token=${encodeURIComponent(token)}`

  return c.html(
    landingPage({
      title: "You're signed in",
      message: 'Opening INSS Support to finish signing in…',
      deepLink,
    }),
  )
})
