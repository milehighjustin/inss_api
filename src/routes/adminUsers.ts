import { randomUUID } from 'node:crypto'

import type { Context } from 'hono'
import { Hono } from 'hono'

import { blobUploadSignature, blobUrl, containerClient } from '../azure.ts'
import { requireAdmin, type SessionUser } from '../auth/session.ts'
import { fail, readJson, text } from '../http.ts'
import {
  MAX_TAGS_PER_USER,
  TagError,
  assertKnownTags,
  slugsOf,
} from '../notificationTags.ts'
import { deleteUserInstallations, syncUserInstallations } from '../push/installations.ts'
import { SUPPORT_ROLE, endSession } from '../support.ts'
import {
  createUser,
  findUserByEmail,
  getAllUsers,
  getUser,
  updateUser,
  type UserDocument,
  type UserPatch,
} from '../users.ts'

/**
 * User management for administrators.
 *
 * One list, one detail endpoint and a two-step photo upload. Every route is
 * administrator-only: the app's nav hides the console from everyone else, but
 * the bearer token is what actually decides.
 */

export const adminUserRoutes = new Hono()

export const ASSIGNABLE_ROLES = [
  'access',
  'administrator',
  'developer',
  'investor',
  'kiosk',
  'kpi',
  'manager',
  'support',
  'supervisor',
] as const

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number]

function isAssignableRole(role: string): role is AssignableRole {
  return (ASSIGNABLE_ROLES as readonly string[]).includes(role)
}

/** The user shape the app receives. Never includes password material. */
export interface AdminUser {
  userId: string
  firstName?: string
  lastName?: string
  email?: string
  username?: string
  phone?: string
  photoUrl?: string
  roles: string[]
  active: boolean
  locked: boolean
  lastLogin: string | null
  /** Notification tag slugs: what this account is told about. */
  notificationTags: string[]
}

/** Either a Mongo document or an already-mapped `getUser` record. */
type UserLike = Omit<UserDocument, '_id' | 'userId' | 'pwd'> & {
  _id?: string
  userId?: string
}

function serializeAdminUser(doc: UserLike): AdminUser {
  return {
    userId: String(doc._id ?? doc.userId ?? ''),
    firstName: doc.firstName,
    lastName: doc.lastName,
    email: doc.email,
    username: doc.username,
    phone: doc.phone,
    photoUrl: doc.photoUrl,
    roles: doc.roles ?? [],
    active: doc.active !== false,
    locked: doc.locked === true,
    lastLogin: doc.lastLogin ? new Date(doc.lastLogin).toISOString() : null,
    notificationTags: doc.notificationTags ?? [],
  }
}

/** The caller, or the response to send. */
async function admin(c: Context): Promise<SessionUser | Response> {
  return requireAdmin(c)
}

async function loadAdminUser(userId: string): Promise<AdminUser | null> {
  const user = await getUser(userId)
  if (!user || !('userId' in user) || !user.userId) return null
  return serializeAdminUser(user)
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/**
 * GET /api/mobile/admin/users
 *
 * Success: { users: AdminUser[] }
 *
 * Every user, active and inactive, without password material. The website's
 * list filters client side and so does the app, so the full set is returned and
 * the work happens on the device.
 */
adminUserRoutes.get('/', async (c) => {
  const gate = await admin(c)
  if (gate instanceof Response) return gate

  const users = await getAllUsers({ projection: { pwd: 0 } })
  return c.json({ users: users.map(serializeAdminUser) })
})

/**
 * POST /api/mobile/admin/users   { firstName, lastName, email?, roles? }
 *
 * Success: { user } (201)
 *
 * The same shape the website's create modal sends, with the same messages, so
 * the app can show them verbatim. No password is set here, exactly like v1.
 */
adminUserRoutes.post('/', async (c) => {
  const gate = await admin(c)
  if (gate instanceof Response) return gate

  const body = await readJson(c)
  const firstName = text(body.firstName)
  const lastName = text(body.lastName)
  const email = text(body.email).toLowerCase()

  if (!firstName) return fail(c, 'First name is required', 400)
  if (!lastName) return fail(c, 'Last name is required', 400)
  if (email && !EMAIL_PATTERN.test(email)) return fail(c, 'Invalid email address', 400)

  const requestedRoles = Array.isArray(body.roles)
    ? body.roles.filter((role): role is string => typeof role === 'string')
    : []
  const unknownRole = requestedRoles.find((role) => !isAssignableRole(role))
  if (unknownRole) return fail(c, `Unknown role: ${unknownRole}`, 400)

  if (email) {
    const existing = await findUserByEmail(email)
    if (existing) return fail(c, 'A user with this email already exists', 409)
  }

  const created = await createUser(
    { firstName, lastName, email: email || undefined },
    requestedRoles as AssignableRole[],
  )
  if ('error' in created) return fail(c, 'Error creating user', 500)

  const user: AdminUser = {
    userId: created.userId,
    firstName,
    lastName,
    email: email || undefined,
    roles: requestedRoles,
    active: true,
    locked: false,
    lastLogin: null,
    notificationTags: [],
  }

  return c.json({ user }, 201)
})

/**
 * GET /api/mobile/admin/users/:userId
 *
 * Success: { user }
 */
adminUserRoutes.get('/:userId', async (c) => {
  const gate = await admin(c)
  if (gate instanceof Response) return gate

  const user = await loadAdminUser(c.req.param('userId'))
  if (!user) return fail(c, 'User not found', 404)

  return c.json({ user })
})

/**
 * PATCH /api/mobile/admin/users/:userId
 *
 * Body: any of { firstName, lastName, phone, email, roles, active, notificationTags }
 * Success: { user }
 *
 * One endpoint for every edit the user panel makes: profile fields, role
 * changes, deactivation and reactivation. A locked user cannot be edited.
 *
 * Two guards the website does not have, both to stop an administrator removing
 * their own access by accident: you cannot deactivate yourself, and you cannot
 * drop your own administrator role.
 */
adminUserRoutes.patch('/:userId', async (c) => {
  const gate = await admin(c)
  if (gate instanceof Response) return gate

  const userId = c.req.param('userId')
  const existing = await loadAdminUser(userId)
  if (!existing) return fail(c, 'User not found', 404)
  if (existing.locked) return fail(c, 'This user is locked and cannot be edited', 409)

  const body = await readJson(c)
  const patch: UserPatch = {}
  const errors: string[] = []

  if ('firstName' in body) {
    const firstName = text(body.firstName)
    if (!firstName) errors.push('First name is required')
    else patch.firstName = firstName
  }

  if ('lastName' in body) {
    const lastName = text(body.lastName)
    if (!lastName) errors.push('Last name is required')
    else patch.lastName = lastName
  }

  if ('phone' in body) {
    patch.phone = text(body.phone) || undefined
  }

  if ('email' in body) {
    const email = text(body.email).toLowerCase()
    const current = (existing.email ?? '').toLowerCase()

    // A field sent back exactly as it was is not an edit, and must not be able to
    // fail the save. v1 stored a bare username in `email` on some accounts — no
    // `@`, so it can never pass the check below — and a client that posts the
    // whole form would otherwise be unable to save a role or a notification tag
    // on those accounts, forever, with an error about a field nobody touched.
    if (email === current) {
      // Unchanged: nothing to write.
    } else if (!email) {
      // Cleared on purpose: an empty field means "no address", not "leave it".
      patch.email = undefined
    } else if (!EMAIL_PATTERN.test(email)) {
      errors.push('Invalid email address')
    } else {
      const taken = await findUserByEmail(email)
      if (taken && String(taken._id) !== userId) {
        errors.push('A user with this email already exists')
      } else {
        patch.email = email
      }
    }
  }

  if ('roles' in body) {
    if (!Array.isArray(body.roles)) {
      errors.push('Roles must be a list')
    } else {
      const roles = body.roles.filter((role): role is string => typeof role === 'string')
      const unknown = roles.find((role) => !isAssignableRole(role))
      if (unknown) errors.push(`Unknown role: ${unknown}`)
      else if (userId === gate.userId && !roles.includes('administrator')) {
        errors.push('You cannot remove your own administrator role')
      } else {
        patch.roles = roles
      }
    }
  }

  if ('active' in body) {
    if (typeof body.active !== 'boolean') {
      errors.push('Active must be true or false')
    } else if (body.active === false && userId === gate.userId) {
      errors.push('You cannot deactivate your own account')
    } else {
      patch.active = body.active
    }
  }

  // Notification tags: slugs the registry knows, so a save cannot address an
  // audience nobody is in. `undefined` means "not touched", which is different
  // from an empty list. Every device is re-registered after the save, because
  // the hub routes by the tags on the installation, not by the account.
  let nextTags: string[] | undefined
  if ('notificationTags' in body) {
    const tags = slugsOf(body.notificationTags, MAX_TAGS_PER_USER)
    try {
      await assertKnownTags(tags)
      nextTags = tags
      patch.notificationTags = tags
    } catch (cause) {
      if (cause instanceof TagError) errors.push(cause.message)
      else throw cause
    }
  }

  if (errors.length > 0) return fail(c, errors.join('. '), 400)
  if (Object.keys(patch).length === 0) return c.json({ user: existing })

  const result = await updateUser(userId, patch)
  if ('error' in result) {
    // updateUser reports "no changes made" as an error. The user still exists,
    // so answer with its current state rather than failing the save.
    const unchanged = await loadAdminUser(userId)
    if (!unchanged) return fail(c, 'User not found', 404)
    return c.json({ user: unchanged })
  }

  // A deactivated account stops getting alerts at once: its devices are removed
  // rather than left subscribed to a person who can no longer sign in. Its shift
  // ends with it, so the panel does not show somebody on duty who cannot sign in.
  // Losing the support role ends it too: the group is what a shift belongs to.
  if (patch.active === false) {
    await deleteUserInstallations(userId)
    await endSession(userId, 'deactivated')
  } else {
    if (nextTags !== undefined) await syncUserInstallations(userId, nextTags)
    if (patch.roles && !patch.roles.includes(SUPPORT_ROLE)) {
      await endSession(userId, 'role-removed')
    }
  }

  const updated = await loadAdminUser(userId)
  if (!updated) return fail(c, 'User not found', 404)
  return c.json({ user: updated })
})

/**
 * Photo upload, in two steps.
 *
 * POST  { contentType } -> { upload: { uploadUrl, blobUrl, blobName, headers } }
 *   The app PUTs the image straight to Azure with that URL, so the bytes never
 *   pass through this API.
 *
 * PATCH { blobName } -> { user }
 *   The app says which blob it wrote; the blob is checked to exist, to be an
 *   image and to be within the size limit, then its URL is saved on the user.
 *
 * The SAS is write-only and signed for one server-chosen blob, so a leaked URL
 * cannot read, list, overwrite another photo or delete anything. Files land in
 * the same `master-open/userPhotos/` folder the website uses.
 */

const CONTAINER = 'master-open'
const FOLDER = 'userPhotos/'
const ALLOWED_TYPES: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}
const MAX_BYTES = 8 * 1024 * 1024

/** The target user, or the response to send. */
async function photoTarget(c: Context, userId: string): Promise<AdminUser | Response> {
  const user = await loadAdminUser(userId)
  if (!user) return fail(c, 'User not found', 404)
  if (user.locked) return fail(c, 'This user is locked and cannot be edited', 409)
  return user
}

adminUserRoutes.post('/:userId/photo', async (c) => {
  const gate = await admin(c)
  if (gate instanceof Response) return gate

  const userId = c.req.param('userId')
  const target = await photoTarget(c, userId)
  if (target instanceof Response) return target

  const body = await readJson(c)
  const contentType = text(body.contentType).toLowerCase()
  const extension = ALLOWED_TYPES[contentType]
  if (!extension) return fail(c, 'Upload a PNG, JPEG or WebP image', 400)

  const blobName = `${FOLDER}${randomUUID()}.${extension}`
  const signature = blobUploadSignature(CONTAINER, blobName)

  return c.json({
    upload: {
      uploadUrl: signature.uploadUrl,
      blobUrl: signature.blobUrl,
      blobName,
      // Azure needs the blob type on the PUT, and the content type is what makes
      // the file display in a browser instead of downloading.
      headers: {
        'x-ms-blob-type': 'BlockBlob',
        'Content-Type': contentType,
      },
    },
    expiresOn: signature.expiresOn,
  })
})

adminUserRoutes.patch('/:userId/photo', async (c) => {
  const gate = await admin(c)
  if (gate instanceof Response) return gate

  const userId = c.req.param('userId')
  const target = await photoTarget(c, userId)
  if (target instanceof Response) return target

  const body = await readJson(c)
  const blobName = text(body.blobName)

  // Only blobs this endpoint hands out: the photo folder, no traversal, no
  // absolute paths, and the shape the POST above generates.
  if (!blobName.startsWith(FOLDER) || blobName.includes('..') || !/^[\w/.-]+$/.test(blobName)) {
    return fail(c, 'Unknown photo', 400)
  }

  const blob = containerClient(CONTAINER).getBlockBlobClient(blobName)

  let size = 0
  let contentType = ''
  try {
    const properties = await blob.getProperties()
    size = properties.contentLength ?? 0
    contentType = properties.contentType ?? ''
  } catch {
    return fail(c, 'The photo had not finished uploading. Try again.', 409)
  }

  if (!contentType.startsWith('image/') || !ALLOWED_TYPES[contentType]) {
    await blob.deleteIfExists().catch(() => undefined)
    return fail(c, 'Upload a PNG, JPEG or WebP image', 400)
  }

  if (size <= 0 || size > MAX_BYTES) {
    await blob.deleteIfExists().catch(() => undefined)
    return fail(c, 'Images must be 8 MB or smaller', 413)
  }

  const updated = await updateUser(userId, { photoUrl: blobUrl(CONTAINER, blobName) })
  if ('error' in updated) {
    return fail(c, 'The photo uploaded but could not be saved to the user', 500)
  }

  const user = await loadAdminUser(userId)
  if (!user) return fail(c, 'User not found', 404)
  return c.json({ user })
})
