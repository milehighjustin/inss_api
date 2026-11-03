import { Hono } from 'hono'

import { requireAdmin } from '../auth/session.ts'
import { fail, readJson, text } from '../http.ts'
import {
  MAX_TAGS_PER_SEND,
  TagError,
  assertKnownTags,
  createTag,
  deleteTag,
  listTags,
  slugsOf,
  tagUsage,
  updateTag,
  usersWithTags,
} from '../notificationTags.ts'
import { recentNotifications, sendManual } from '../notifications.ts'
import { LIMITS, checkLimit, retryAfterHeaders } from '../rateLimit.ts'
import { countInstallationsForTags } from '../push/installations.ts'

/**
 * The admin console's notification settings: the tag registry, and sending by
 * hand.
 *
 * Tags are the vocabulary everyone else uses — Users assigns them, QR codes
 * choose them — so this is where they are created, renamed and turned off. A tag
 * still in use cannot be deleted: it is deactivated instead, which hides it from
 * pickers while the accounts and codes that already reference it keep working.
 */

export const notificationTagRoutes = new Hono()

/**
 * GET /api/mobile/admin/notification-tags
 *
 * Success: { tags } — every tag with how many accounts and codes use it.
 *
 * The list is whatever administrators have created; there are no predefined tags,
 * so a new install answers with an empty array and the pickers say so.
 */
notificationTagRoutes.get('/', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  return c.json({ tags: await tagUsage() })
})

/** POST /api/mobile/admin/notification-tags   { label, slug?, description? } */
notificationTagRoutes.post('/', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  const body = await readJson(c)

  try {
    const tag = await createTag({
      slug: text(body.slug) || undefined,
      label: text(body.label),
      description: text(body.description),
    })

    return c.json({ tag: { ...tag, users: 0, codes: 0 } }, 201)
  } catch (cause) {
    if (cause instanceof TagError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

/** PATCH /api/mobile/admin/notification-tags/:slug   { label?, description?, active? } */
notificationTagRoutes.patch('/:slug', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  const body = await readJson(c)

  try {
    const tag = await updateTag(c.req.param('slug'), {
      ...(body.label !== undefined ? { label: text(body.label) } : {}),
      ...(body.description !== undefined ? { description: text(body.description) } : {}),
      ...(body.active !== undefined ? { active: body.active === true } : {}),
    })

    return c.json({ tag })
  } catch (cause) {
    if (cause instanceof TagError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

/** DELETE /api/mobile/admin/notification-tags/:slug — only when unused. */
notificationTagRoutes.delete('/:slug', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  try {
    await deleteTag(c.req.param('slug'))
    return c.json({ deleted: true })
  } catch (cause) {
    if (cause instanceof TagError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

export const adminNotificationRoutes = new Hono()

/** Every tag, for the composer. */
adminNotificationRoutes.get('/tags', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  return c.json({ tags: await listTags() })
})

/**
 * GET /api/mobile/admin/notifications?limit=50
 *
 * Success: { notifications } — the log, newest first: what was sent, to which
 * tags, on which channels, and what each channel said.
 */
adminNotificationRoutes.get('/', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  const limit = Number(c.req.query('limit') ?? '50')
  return c.json({ notifications: await recentNotifications(Number.isFinite(limit) ? limit : 50) })
})

/**
 * GET /api/mobile/admin/notifications/preview?tags=support,accounting
 *
 * Success: { users, devices } — how many accounts carry any of these tags and
 * how many phone installations they have between them. The composer shows this
 * before anyone sends, so "support" is a number rather than a guess.
 */
adminNotificationRoutes.get('/preview', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  const tags = slugsOf((c.req.query('tags') ?? '').split(','), MAX_TAGS_PER_SEND)
  const users = await usersWithTags(tags)

  return c.json({
    users: users.length,
    devices: await countInstallationsForTags(tags),
  })
})

/**
 * POST /api/mobile/admin/notifications/send
 *
 * Body: { tags, title, body?, priority }
 * Success: { notification }
 *
 * Sends now, to everyone carrying any of the tags, on every channel they have
 * enabled. The reply is the log row, so the console can show exactly what was
 * attempted without a second request.
 */
adminNotificationRoutes.post('/send', async (c) => {
  const gate = await requireAdmin(c)
  if (gate instanceof Response) return gate

  // An alert is the one thing here that reaches real people, so the ceiling is
  // per administrator: a stuck button or a script should not flush the whole
  // company's phones.
  const allowed = checkLimit(`send:${gate.userId}`, LIMITS.send)
  if (!allowed.ok) {
    return fail(
      c,
      `That is a lot of alerts at once. Try again in ${allowed.retryAfterSeconds} seconds.`,
      429,
      retryAfterHeaders(allowed.retryAfterSeconds),
    )
  }

  const body = await readJson(c)
  const tags = slugsOf(body.tags, MAX_TAGS_PER_SEND)
  const title = text(body.title)
  const message = text(body.body)
  const priority = body.priority === 'loud' ? 'loud' : 'quiet'

  if (tags.length === 0) return fail(c, 'Choose at least one tag to send to', 400)
  if (!title) return fail(c, 'Give the notification a title', 400)

  try {
    await assertKnownTags(tags)
  } catch (cause) {
    if (cause instanceof TagError) return fail(c, cause.message, cause.status)
    throw cause
  }

  const notification = await sendManual({
    tags,
    title,
    body: message,
    priority,
    createdBy: gate.userId,
  })

  return c.json({ notification, remaining: allowed.remaining }, 201)
})
