import { randomUUID } from 'node:crypto'

import { personActivity, type PersonActivity } from './activity.ts'
import { db } from './db.ts'

/**
 * Support sessions: one shift at the desk, and what happened during it.
 *
 * A session is not a login and not a call — it is a person saying "I am on the
 * desk now". Two things hang off it:
 *
 * 1. **Delivery.** A `support` account only hears the alerts its notification
 *    tags address while a session is open. That is the whole point of a shift:
 *    off duty, the phone stays quiet, and the person who is on is the person the
 *    metrics are about.
 * 2. **Attribution.** The numbers a supervisor reads — offered, answered, the
 *    median time it took, the calls — are cut to the window of the session, so
 *    "how did this person do on that shift" is a question the log can answer.
 *
 * One open session per account. Starting a second one closes the first and says
 * so (`endedReason: 'replaced'`), rather than leaving two rows claiming the same
 * person is on duty.
 *
 * The metrics are not stored on the row. They are computed from the activity log
 * on read, which is the same source the performance report uses — one set of
 * numbers, no second copy to drift.
 */

/** The role that puts an account in the support group. */
export const SUPPORT_ROLE = 'support'

/**
 * Who may open the Support panel and run their own session.
 *
 * Managers and supervisors keep their way in because they are the desk's
 * supervisors and can still take a shift themselves; the numbers everyone's
 * shifts add up to live in Admin → Support, which is administrator-only.
 */
export const SUPPORT_ROLES = ['support', 'administrator', 'manager', 'supervisor'] as const

/** Who may read every session, not only their own. */
export const SESSION_STAFF_ROLES = ['administrator', 'manager', 'supervisor'] as const

export type SessionEndReason = 'ended' | 'replaced' | 'deactivated' | 'role-removed'

export interface SessionDocument {
  _id: string
  userId: string
  startedAt: Date
  endedAt: Date | null
  endedReason?: SessionEndReason
  /** The notification tags the account carried when the shift began. */
  tags: string[]
}

export interface SupportSession {
  sessionId: string
  userId: string
  name: string
  roles: string[]
  /** What this person was listening for during the shift. */
  tags: string[]
  startedAt: string
  endedAt: string | null
  endedReason?: SessionEndReason
  active: boolean
  /** Seconds so far, or the whole shift once it has ended. */
  durationSeconds: number
  metrics: PersonActivity
}

function sessions() {
  return db('global').then((global) => global.collection<SessionDocument>('supportSessions'))
}

interface PersonRow {
  _id: string
  firstName?: unknown
  lastName?: unknown
  roles?: unknown
}

/**
 * Names and roles for a set of ids, read once per batch.
 *
 * A session outlives a rename, so the name is looked up rather than copied onto
 * the row; a deleted account still gets a row, labelled honestly. Exported
 * because the desk board needs the same names for whoever answered an alert.
 */
export async function peopleById(
  userIds: readonly string[],
): Promise<Map<string, { name: string; roles: string[] }>> {
  const unique = [...new Set(userIds.filter(Boolean))]
  if (unique.length === 0) return new Map()

  const rows = await (await db('global'))
    .collection<PersonRow>('users')
    .find(
      { _id: { $in: unique } },
      { projection: { firstName: 1, lastName: 1, roles: 1 } },
    )
    .toArray()

  return new Map(
    rows.map((row) => {
      const name = [row.firstName, row.lastName]
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter(Boolean)
        .join(' ')
      const roles = Array.isArray(row.roles)
        ? row.roles.filter((role): role is string => typeof role === 'string')
        : []

      return [String(row._id), { name: name || 'Former account', roles }] as const
    }),
  )
}

/** One row plus its numbers, with the people looked up already. */
function shape(
  row: SessionDocument,
  person: { name: string; roles: string[] } | undefined,
  metrics: PersonActivity,
  now: Date,
): SupportSession {
  const end = row.endedAt ?? now

  return {
    sessionId: row._id,
    userId: row.userId,
    name: person?.name ?? 'Former account',
    roles: person?.roles ?? [],
    tags: row.tags ?? [],
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    ...(row.endedReason ? { endedReason: row.endedReason } : {}),
    active: row.endedAt === null,
    durationSeconds: Math.max(0, Math.round((end.getTime() - row.startedAt.getTime()) / 1000)),
    metrics,
  }
}

async function summarizeMany(
  rows: SessionDocument[],
  now = new Date(),
): Promise<SupportSession[]> {
  if (rows.length === 0) return []

  const persons = await peopleById(rows.map((row) => row.userId))

  // `to` is exclusive, so an event written at the exact instant of the end is
  // included rather than falling off the shift it belongs to.
  return Promise.all(
    rows.map(async (row) => {
      const end = row.endedAt ?? now
      const metrics = await personActivity(row.userId, row.startedAt, new Date(end.getTime() + 1))
      return shape(row, persons.get(row.userId), metrics, now)
    }),
  )
}

async function summarize(row: SessionDocument, now = new Date()): Promise<SupportSession> {
  const [shaped] = await summarizeMany([row], now)
  return shaped
}

/** The session this account has open right now, or null. */
export async function mySession(userId: string): Promise<SupportSession | null> {
  const row = await (await sessions()).findOne({ userId, endedAt: null })
  return row ? summarize(row) : null
}

export interface UserShifts {
  /** Shifts that overlap the window. */
  count: number
  /** Seconds of desk time inside the window, clipped to it. */
  seconds: number
  /** True when one of them is still open. */
  active: boolean
  lastStartedAt: string | null
}

/**
 * How long a person held the desk inside a window.
 *
 * A shift that started before the window and ended inside it still contributed
 * that part of itself, so the overlap is clipped rather than the shift counted
 * whole: "how long were they on duty this week" has to be the week, not the
 * shifts that happen to begin in it.
 */
export async function userShifts(
  userId: string,
  from: Date,
  to: Date,
): Promise<UserShifts> {
  const rows = await (await sessions())
    .find({ userId, startedAt: { $lt: to } })
    .sort({ startedAt: -1 })
    .limit(500)
    .toArray()

  let count = 0
  let seconds = 0
  let active = false
  let lastStartedAt: Date | null = null

  for (const row of rows) {
    const end = row.endedAt ?? to
    if (end <= from) continue

    count += 1
    if (row.endedAt === null) active = true
    if (!lastStartedAt || row.startedAt > lastStartedAt) lastStartedAt = row.startedAt

    const start = Math.max(row.startedAt.getTime(), from.getTime())
    const stop = Math.min(end.getTime(), to.getTime())
    seconds += Math.max(0, Math.round((stop - start) / 1000))
  }

  return {
    count,
    seconds,
    active,
    lastStartedAt: lastStartedAt ? lastStartedAt.toISOString() : null,
  }
}

/**
 * Opens a shift, closing any that was already open.
 *
 * The tags are snapshotted: what a supervisor should see is what the person was
 * listening for at the time, not what their account says today.
 */
export async function startSession(user: {
  userId: string
  notificationTags: string[]
}): Promise<{ session: SupportSession; replaced: boolean }> {
  const collection = await sessions()
  const now = new Date()
  const open = await collection.findOne({ userId: user.userId, endedAt: null })

  if (open) {
    await collection.updateOne(
      { _id: open._id },
      { $set: { endedAt: now, endedReason: 'replaced' } },
    )
  }

  const row: SessionDocument = {
    _id: randomUUID(),
    userId: user.userId,
    startedAt: now,
    endedAt: null,
    tags: [...new Set(user.notificationTags)],
  }

  await collection.insertOne(row)

  return { session: await summarize(row), replaced: Boolean(open) }
}

/**
 * Closes this account's open session.
 *
 * Returns null when there was none — a second press, or a session ended on
 * another device, is the outcome the caller wanted either way.
 */
export async function endSession(
  userId: string,
  reason: SessionEndReason = 'ended',
): Promise<SupportSession | null> {
  const collection = await sessions()
  const open = await collection.findOne({ userId, endedAt: null })
  if (!open) return null

  const endedAt = new Date()
  await collection.updateOne({ _id: open._id }, { $set: { endedAt, endedReason: reason } })

  return summarize({ ...open, endedAt, endedReason: reason })
}

/** Every open session, longest-serving first. */
export async function activeSessions(): Promise<SupportSession[]> {
  const rows = await (await sessions()).find({ endedAt: null }).sort({ startedAt: 1 }).toArray()
  return summarizeMany(rows)
}

/** One page of shift history, and how many rows there are in all. */
export interface SessionPage {
  sessions: SupportSession[]
  total: number
  page: number
  pageSize: number
}

/** The page size both the desk and the admin list use. */
export const SESSIONS_PAGE_SIZE = 25

/**
 * Past and current sessions, newest first, one page at a time, optionally one
 * person's.
 *
 * `total` is counted rather than guessed from a short page: the list has to say
 * "page 2 of 9" before the reader gets to the end of it. Ties are broken by id so
 * two shifts starting in the same second cannot swap places between pages.
 */
export async function sessionHistory({
  page = 1,
  pageSize = SESSIONS_PAGE_SIZE,
  userId,
}: { page?: number; pageSize?: number; userId?: string } = {}): Promise<SessionPage> {
  const size = Math.min(Math.max(Math.round(pageSize), 1), 100)
  const filter = userId ? { userId } : {}
  const collection = await sessions()

  const total = await collection.countDocuments(filter)
  const lastPage = Math.max(1, Math.ceil(total / size))
  const current = Math.min(Math.max(Math.round(page), 1), lastPage)

  const rows = await collection
    .find(filter)
    .sort({ startedAt: -1, _id: -1 })
    .skip((current - 1) * size)
    .limit(size)
    .toArray()

  return { sessions: await summarizeMany(rows), total, page: current, pageSize: size }
}

export async function sessionById(sessionId: string): Promise<SupportSession | null> {
  const row = await (await sessions()).findOne({ _id: sessionId })
  return row ? summarize(row) : null
}

/**
 * Splits an audience into the people who should hear an alert now, and the
 * support accounts that are off duty.
 *
 * Only accounts holding the `support` role are gated. Everyone else — an
 * investor with documents, a manager with a tag — is delivered to exactly as
 * before; a shift is a property of the support group, not of notifications.
 *
 * The off-duty list is returned rather than merely dropped because the hub fans
 * out by tag expression: a phone registered with `nt:support` would still be
 * reached unless its owner is excluded inside the expression.
 */
export async function onDuty(
  userIds: readonly string[],
): Promise<{ onDuty: string[]; offDuty: string[] }> {
  const unique = [...new Set(userIds.filter(Boolean))]
  if (unique.length === 0) return { onDuty: [], offDuty: [] }

  const rows = await (await db('global'))
    .collection<{ _id: string; roles?: unknown }>('users')
    .find({ _id: { $in: unique } }, { projection: { roles: 1 } })
    .toArray()

  const gated = new Set(
    rows
      .filter((row) => Array.isArray(row.roles) && row.roles.includes(SUPPORT_ROLE))
      .map((row) => String(row._id)),
  )

  if (gated.size === 0) return { onDuty: unique, offDuty: [] }

  const open = await (await sessions())
    .find(
      { userId: { $in: [...gated] }, endedAt: null },
      { projection: { userId: 1 } },
    )
    .toArray()

  const serving = new Set(open.map((row) => row.userId))
  const off = new Set(unique.filter((id) => gated.has(id) && !serving.has(id)))

  return {
    onDuty: unique.filter((id) => !off.has(id)),
    offDuty: [...off],
  }
}
