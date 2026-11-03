import { db } from './db.ts'

/**
 * Notification tags: the names an alert is addressed to.
 *
 * A tag is a slug in a registry an administrator builds — the vocabulary is
 * theirs, not ours. Users carry tags; QR codes and manual sends name tags;
 * delivery goes to everyone whose account has one of them. The registry exists so
 * a typo cannot create a second, silently empty audience — an unknown slug is a
 * 400, not a send to nobody.
 *
 * Slugs are also what lands on a phone installation in Azure Notification Hubs,
 * prefixed as `nt:<slug>`. They are stored **unencrypted** there, so they are
 * deliberately dull words and never names, emails or property ids.
 */

/** A slug: lowercase, starts with a letter or digit, 1–40 characters. */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/

/** What Azure will take on one device, beside the `user:` tag we add. */
export const MAX_TAGS_PER_USER = 40

/** Azure takes at most 20 tags in one OR expression; so do we. */
export const MAX_TAGS_PER_SEND = 20

export interface TagDocument {
  _id: string
  label: string
  description?: string
  active: boolean
  createdAt: Date
  updatedAt: Date
}

export interface Tag {
  slug: string
  label: string
  description: string
  active: boolean
  createdAt: string
  updatedAt: string
}

/** A tag plus how much depends on it, which is what makes deletion unsafe. */
export interface TagUsage extends Tag {
  users: number
  codes: number
}

export class TagError extends Error {
  status: 400 | 404 | 409

  constructor(message: string, status: 400 | 404 | 409 = 400) {
    super(message)
    this.name = 'TagError'
    this.status = status
  }
}

function tags() {
  return db('global').then((global) => global.collection<TagDocument>('notificationTags'))
}

function serialize(row: TagDocument): Tag {
  return {
    slug: row._id,
    label: row.label || row._id,
    description: row.description ?? '',
    active: row.active !== false,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  }
}

/** A label as a slug: lowercase, spaces and punctuation to `-`. */
export function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 40)
}

export function checkSlug(value: string): string {
  const slug = slugify(value)
  if (!slug || !SLUG_PATTERN.test(slug)) {
    throw new TagError('A tag needs a name: letters, numbers, dots and dashes')
  }
  return slug
}

/**
 * The tags out of a value a client sent: slugs only, no repeats, capped.
 *
 * Anything unrecognisable is dropped rather than refused here — the routes name
 * the field that is wrong, and this keeps the shape tidy wherever it is used.
 */
export function slugsOf(value: unknown, limit = MAX_TAGS_PER_USER): string[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const slug = slugify(entry)
    // Only what could be a slug at all: a stray "__" is not a tag, and keeping
    // it would turn a format mistake into a confusing "unknown tag" later.
    if (slug && SLUG_PATTERN.test(slug)) seen.add(slug)
  }

  return [...seen].slice(0, limit)
}

/**
 * Every tag, by label.
 *
 * The registry starts **empty**. Nothing here is predefined: an administrator
 * names the tags their staff actually use (see Admin → Notifications), and every
 * picker, code and send reads that registry. There is no seed on purpose — a
 * first-run list of words we invented would be an audience nobody belongs to,
 * and one more thing to rename before the feature is honest.
 */
export async function listTags(): Promise<Tag[]> {
  const collection = await tags()
  const rows = await collection.find({}).toArray()

  return rows
    .map(serialize)
    .sort((left, right) => left.label.localeCompare(right.label, 'en', { numeric: true }))
}

/** The slugs that may still be assigned. */
export async function activeSlugs(): Promise<Set<string>> {
  const collection = await tags()
  const rows = await collection.find({ active: { $ne: false } }, { projection: { _id: 1 } }).toArray()

  return new Set(rows.map((row) => row._id))
}

/**
 * Refuses slugs that are not in the registry, so a save cannot create an
 * audience nobody will ever be in.
 */
export async function assertKnownTags(slugs: string[]): Promise<void> {
  if (slugs.length === 0) return

  const collection = await tags()
  const rows = await collection.find({ _id: { $in: slugs } }, { projection: { _id: 1 } }).toArray()
  const known = new Set(rows.map((row) => row._id))

  const missing = slugs.filter((slug) => !known.has(slug))
  if (missing.length > 0) {
    throw new TagError(`Unknown notification tag: ${missing.join(', ')}`, 400)
  }
}

export async function createTag(input: {
  slug?: string
  label: string
  description?: string
}): Promise<Tag> {
  const label = input.label.trim()
  if (!label) throw new TagError('Give the tag a name')

  const slug = checkSlug(input.slug?.trim() || label)
  const collection = await tags()

  const existing = await collection.findOne({ _id: slug })
  if (existing) throw new TagError(`There is already a tag called “${slug}”`, 409)

  const now = new Date()
  const row: TagDocument = {
    _id: slug,
    label,
    description: input.description?.trim(),
    active: true,
    createdAt: now,
    updatedAt: now,
  }

  await collection.insertOne(row)
  return serialize(row)
}

export async function updateTag(
  slug: string,
  patch: { label?: string; description?: string; active?: boolean },
): Promise<Tag> {
  const collection = await tags()
  const existing = await collection.findOne({ _id: checkSlug(slug) })
  if (!existing) throw new TagError('That tag is not there', 404)

  const update: Partial<TagDocument> = { updatedAt: new Date() }

  if (patch.label !== undefined) {
    const label = patch.label.trim()
    if (!label) throw new TagError('Give the tag a name')
    update.label = label
  }
  if (patch.description !== undefined) update.description = patch.description.trim()
  if (patch.active !== undefined) update.active = patch.active

  await collection.updateOne({ _id: existing._id }, { $set: update })

  const row = await collection.findOne({ _id: existing._id })
  if (!row) throw new TagError('That tag is not there', 404)

  return serialize(row)
}

/** How many accounts and codes use each tag. */
export async function tagUsage(): Promise<TagUsage[]> {
  const [list, global] = await Promise.all([listTags(), db('global')])

  const [userCounts, codeCounts] = await Promise.all([
    global
      .collection('users')
      .aggregate<{ _id: string; count: number }>([
        { $match: { notificationTags: { $exists: true, $ne: [] } } },
        { $unwind: '$notificationTags' },
        { $group: { _id: '$notificationTags', count: { $sum: 1 } } },
      ])
      .toArray(),
    global
      .collection('qr')
      .aggregate<{ _id: string; count: number }>([
        { $match: { notifyTags: { $exists: true, $ne: [] } } },
        { $unwind: '$notifyTags' },
        { $group: { _id: '$notifyTags', count: { $sum: 1 } } },
      ])
      .toArray(),
  ])

  const users = new Map(userCounts.map((row) => [row._id, row.count]))
  const codes = new Map(codeCounts.map((row) => [row._id, row.count]))

  return list.map((tag) => ({
    ...tag,
    users: users.get(tag.slug) ?? 0,
    codes: codes.get(tag.slug) ?? 0,
  }))
}

/**
 * Removes a tag nothing depends on.
 *
 * A tag still on an account or a code is deactivated instead: deleting it would
 * leave those records pointing at a name that no longer means anything, and
 * silently change who a printed sign alerts.
 */
export async function deleteTag(slug: string): Promise<void> {
  const clean = checkSlug(slug)
  const usage = (await tagUsage()).find((tag) => tag.slug === clean)
  if (!usage) throw new TagError('That tag is not there', 404)

  if (usage.users > 0 || usage.codes > 0) {
    throw new TagError(
      `“${usage.label}” is still used by ${usage.users} account(s) and ${usage.codes} code(s). Turn it off instead.`,
      409,
    )
  }

  await (await tags()).deleteOne({ _id: clean })
}

/**
 * The accounts that carry any of these tags.
 *
 * This is how a tag names people for delivery: an untagged account, however
 * senior, is not in the audience, which is the point of the whole exercise.
 */
export async function usersWithTags(slugs: string[]): Promise<string[]> {
  if (slugs.length === 0) return []

  const global = await db('global')
  const rows = await global
    .collection<{ _id: string }>('users')
    .find(
      { notificationTags: { $in: slugs }, active: { $ne: false } },
      { projection: { _id: 1 } },
    )
    .toArray()

  return rows.map((row) => String(row._id))
}
