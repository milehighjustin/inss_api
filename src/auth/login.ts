import { compare } from 'bcryptjs'

import { db } from '../db.ts'

/**
 * The password check the website's credentials provider performs.
 *
 * The app and the website therefore accept exactly the same accounts and
 * passwords. Only active accounts can sign in, and every successful sign-in
 * records `lastLogin`.
 *
 * The identifier is matched against email or username, case-insensitively.
 * v1 passed the typed value straight into a `$regex`, which made it a pattern
 * rather than a value; this matches the whole field instead.
 */
export async function login(
  username: string,
  password: string,
): Promise<{ userId: string; success: true } | { error: string }> {
  const collection = (await db()).collection('users')
  const escaped = username.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

  const query = await collection.findOne({
    active: true,
    $or: [
      { email: { $regex: `^${escaped}$`, $options: 'i' } },
      { username: { $regex: `^${escaped}$`, $options: 'i' } },
    ],
  })

  if (!query) return { error: 'User not found' }
  if (!Object.prototype.hasOwnProperty.call(query, 'pwd')) return { error: 'User Corrupt' }

  const valid = await compare(password, String(query.pwd)).catch(() => false)
  if (!valid) return { error: 'Credentials Invalid' }

  await collection.updateOne({ _id: query._id }, { $set: { lastLogin: new Date() } })

  return { userId: String(query._id), success: true }
}
