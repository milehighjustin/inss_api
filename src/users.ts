import { randomUUID } from 'node:crypto'

import { db } from './db.ts'

/**
 * Reads and writes on the `users` collection.
 *
 * Accounts are created by the website and by administrators in the app; this
 * API never sets a password. `_id` is a UUID string, which is what `userId`
 * carries everywhere else.
 */

export interface UserDocument {
  _id: string
  email?: string
  username?: string
  firstName?: string
  lastName?: string
  phone?: string
  photoUrl?: string
  roles?: string[]
  active?: boolean
  locked?: boolean
  lastLogin?: Date | string | null
  pwd?: string
  /** Notification tag slugs this account hears: `support`, `accounting`, … */
  notificationTags?: string[]
}

/** What `getUser` returns: the fields the app is allowed to see. */
export interface UserRecord {
  userId: string
  email?: string
  username?: string
  firstName?: string
  lastName?: string
  phone?: string
  photoUrl?: string
  roles?: string[]
  active?: boolean
  locked?: boolean
  lastLogin: string | null
  /** Empty for most people: no tags means no notification is ever addressed to them. */
  notificationTags: string[]
}

async function users() {
  return (await db()).collection<UserDocument>('users')
}

export async function getUser(userId: string): Promise<UserRecord | { error: string }> {
  const collection = await users()
  const query = await collection.findOne({ _id: userId })
  if (!query) return { error: 'User not found' }

  return {
    userId: query._id,
    email: query.email,
    username: query.username,
    firstName: query.firstName,
    lastName: query.lastName,
    phone: query.phone,
    photoUrl: query.photoUrl,
    roles: query.roles,
    active: query.active,
    locked: query.locked,
    lastLogin: query.lastLogin ? new Date(query.lastLogin).toISOString() : null,
    notificationTags: query.notificationTags ?? [],
  }
}

/** Every user, active or not. `pwd` is excluded by the caller's projection. */
export async function getAllUsers({
  projection,
}: { projection?: Record<string, 0 | 1> } = {}): Promise<UserDocument[]> {
  const collection = await users()
  return collection.find({}, { projection }).toArray()
}

export async function findUserByEmail(email: string): Promise<UserDocument | null> {
  const clean = email.trim()
  if (!clean) return null

  const collection = await users()
  const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return collection.findOne({ email: { $regex: `^${escaped}$`, $options: 'i' } })
}

export interface NewUser {
  firstName: string
  lastName: string
  email?: string
}

export async function createUser(
  userObject: NewUser,
  roles: string[] = [],
): Promise<UserRecord | { error: string }> {
  const collection = await users()
  const userId = randomUUID()

  const result = await collection.insertOne({
    _id: userId,
    firstName: userObject.firstName,
    lastName: userObject.lastName,
    email: userObject.email,
    active: true,
    roles,
  })

  if (!result.insertedId) return { error: 'Error creating user' }

  return {
    userId,
    firstName: userObject.firstName,
    lastName: userObject.lastName,
    email: userObject.email,
    active: true,
    roles,
    lastLogin: null,
    notificationTags: [],
  }
}

export type UserPatch = Partial<
  Pick<
    UserDocument,
    'firstName' | 'lastName' | 'phone' | 'email' | 'roles' | 'active' | 'photoUrl' | 'notificationTags'
  >
>

/**
 * `updateOne` with the full patch. Mongo reports a no-op update as zero
 * modified documents, which callers treat as "nothing changed" rather than a
 * failure.
 */
export async function updateUser(
  userId: string,
  updateData: UserPatch,
): Promise<{ success: true } | { error: string }> {
  const collection = await users()
  const result = await collection.updateOne({ _id: userId }, { $set: updateData })

  if (result.modifiedCount === 1) return { success: true }
  return { error: 'User not found or no changes made' }
}
