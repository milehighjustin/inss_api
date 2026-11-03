import crypto from 'node:crypto'

import { db } from '../db.ts'

/**
 * Magic-link sign-in for the app.
 *
 * The website's NextAuth flow finishes by setting a session cookie in a browser,
 * which a native client can never see. So the link is sent from here, points back
 * at this API, and is exchanged for the same bearer token the password flow
 * returns.
 *
 * Only a sha256 hash of the token is stored. Tokens are single use and expire
 * after 15 minutes.
 */

const COLLECTION = 'mobileAuthTokens'
const TTL_MS = 15 * 60 * 1000
const FROM = 'no-reply@inselfstorage.com'

function hashToken(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex')
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

interface MagicLinkToken {
  tokenHash: string
  userId: string
  email: string
  createdAt: Date
  expiresAt: Date
  usedAt: Date | null
}

async function tokens() {
  return (await db()).collection<MagicLinkToken>(COLLECTION)
}

/** Looks up an active user by exact email address (magic links are email only). */
export async function findActiveUserByEmail(email: string): Promise<string | null> {
  const users = (await db()).collection<{ _id: unknown; email?: string }>('users')
  const query = await users.findOne({
    active: true,
    email: { $regex: `^${escapeRegex(email)}$`, $options: 'i' },
  })
  if (!query || query._id == null) return null
  return String(query._id)
}

export async function createMagicLinkToken(userId: string, email: string): Promise<string> {
  const collection = await tokens()
  // One live link per user: requesting a new one invalidates the old.
  await collection.deleteMany({ userId, usedAt: null })

  const raw = crypto.randomBytes(32).toString('base64url')
  const now = Date.now()
  await collection.insertOne({
    tokenHash: hashToken(raw),
    userId,
    email,
    createdAt: new Date(now),
    expiresAt: new Date(now + TTL_MS),
    usedAt: null,
  })
  return raw
}

/** Consumes a magic link token. Returns the user id, or null if unusable. */
export async function redeemMagicLinkToken(raw: string): Promise<string | null> {
  const collection = await tokens()
  const doc = await collection.findOne({
    tokenHash: hashToken(raw),
    usedAt: null,
    expiresAt: { $gt: new Date() },
  })
  if (!doc) return null

  // Guards against two concurrent redemptions of the same link.
  const claimed = await collection.updateOne(
    { _id: doc._id, usedAt: null },
    { $set: { usedAt: new Date() } },
  )
  if (claimed.modifiedCount !== 1) return null

  return String(doc.userId)
}

export function postmarkKey(): string {
  return (
    process.env.POSTMARK_KEY ??
    process.env.AUTH_POSTMARK_KEY ??
    process.env.POSTMARK_API_KEY ??
    process.env.POSTMARK_SERVER_TOKEN ??
    ''
  )
}

export async function sendMagicLinkEmail(to: string, link: string): Promise<boolean> {
  const key = postmarkKey()
  if (!key) return false

  const response = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Postmark-Server-Token': key,
    },
    body: JSON.stringify({
      From: FROM,
      To: to,
      Subject: 'Your INSS Support sign-in link',
      MessageStream: 'outbound',
      TextBody: [
        'Tap the link below to sign in to INSS Support.',
        '',
        link,
        '',
        'This link works once and expires in 15 minutes.',
        'If you did not request it, you can ignore this email.',
      ].join('\n'),
      HtmlBody: magicLinkHtml(link),
    }),
  })

  if (!response.ok) {
    // Postmark's error payload never contains the server token.
    const body = await response.text().catch(() => '')
    console.error('[auth] Postmark rejected the message', {
      status: response.status,
      body: body.slice(0, 500),
    })
  }

  return response.ok
}

function magicLinkHtml(link: string): string {
  const safeLink = link.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#111315;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#111315;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#1B1E21;">
            <tr>
              <td style="background:#208AEF;height:8px;font-size:0;line-height:0;">&nbsp;</td>
            </tr>
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <p style="margin:0;color:#9AA0A6;font-size:12px;letter-spacing:2px;text-transform:uppercase;">INSS Support</p>
                <h1 style="margin:8px 0 0 0;color:#ffffff;font-size:30px;line-height:36px;font-weight:600;">Sign in</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:16px 32px 0 32px;">
                <p style="margin:0;color:#C6CACF;font-size:16px;line-height:24px;">Tap the button below to open the app and finish signing in.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;">
                <a href="${safeLink}" style="display:block;background:#208AEF;color:#ffffff;text-decoration:none;text-align:center;font-size:16px;font-weight:600;padding:16px 24px;">Open INSS Support</a>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0 32px;">
                <p style="margin:0;color:#9AA0A6;font-size:13px;line-height:20px;">This link works once and expires in 15 minutes. If you did not request it, ignore this email.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 32px 32px;">
                <p style="margin:0;color:#6B7076;font-size:11px;line-height:18px;word-break:break-all;">${safeLink}</p>
              </td>
            </tr>
            <tr>
              <td style="background:#208AEF;height:8px;font-size:0;line-height:0;">&nbsp;</td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}
