import type { SessionUser } from './auth/session.ts'
import { ALERT_ANSWER_MINUTES } from './deskAlerts.ts'
import { db } from './db.ts'
import { peopleById } from './support.ts'

/**
 * Every alert, with what became of it — one list, two audiences.
 *
 * The desk reads its own alerts from here, paged, and can still answer the ones
 * inside the five minutes. Admin → Support reads all of them, searchable and
 * filtered, because "what happened to the scan at 14:05" is a question about a
 * single alert, not about a person or a shift.
 *
 * The notification row only says what was sent. Everything else — who answered,
 * how long it took, whether it became a call — is in the activity log against the
 * alert's id, so this module joins the two once and shapes one row per alert.
 *
 * `action` is the row's verdict:
 *
 * - `answered` — somebody took it.
 * - `ignored` — somebody saw it and dismissed it; nobody answered.
 * - `expired` — nobody did anything and the five minutes ran out.
 * - `waiting` — nobody has done anything yet, and it can still be taken.
 *
 * Ignored outranks expired on purpose: an alert somebody dismissed is a decision,
 * and calling it a timeout would hide it.
 */

/** How many alerts one request will look through before filtering and paging. */
const SCAN_LIMIT = 2000

/** The page size both lists use. */
export const ALERTS_PAGE_SIZE = 25

export type AlertAction = 'answered' | 'ignored' | 'expired' | 'waiting'
export type AlertActionFilter = AlertAction | 'all'

export interface AlertCall {
  /** Seconds on the line, or null while it is still running. */
  seconds: number | null
  startedAt: string
}

export interface AlertLogRow {
  notificationId: string
  title: string
  body: string
  priority: 'loud' | 'quiet'
  qrCodeId?: string
  qrCodeName?: string
  locationId?: string
  locationName?: string
  tags: string[]
  createdAt: string
  ageSeconds: number
  action: AlertAction
  /** Who answered it, when somebody did. */
  answeredBy?: string
  answeredById?: string
  /** Ring to answer, in seconds. */
  answerSeconds?: number | null
  /** How many accounts it was offered to, and how many were held on a call. */
  offered: number
  held: number
  /** The video call the answer led to, if there was one. */
  call?: AlertCall
  /** What this viewer did, if they are a support account. */
  mine: 'answered' | 'ignored' | null
  /** True when this viewer could still take it. */
  canAccept: boolean
}

export interface AlertLogPage {
  alerts: AlertLogRow[]
  total: number
  page: number
  pageSize: number
  /** Answers per person in the window, for the list's person filter. */
  people: { userId: string; name: string; answered: number }[]
  /** How many rows each action filter would show under the current search. */
  counts: Record<AlertActionFilter, number>
}

interface NotificationRow {
  _id: string
  kind: string
  qrCodeId?: string
  qrCodeName?: string
  locationId?: string
  locationName?: string
  title: string
  body: string
  priority: 'loud' | 'quiet'
  tags?: string[]
  recipients?: string[]
  createdAt: Date
}

interface ActivityRow {
  kind: string
  userId: string
  at: Date
  notificationId?: string
  callId?: string
  latencyMs?: number
  durationMs?: number
}

export interface AlertLogOptions {
  page?: number
  pageSize?: number
  /** Free text over the title, body, code and property. */
  q?: string
  /** Only alerts whose answer came from this person. */
  answeredBy?: string
  action?: AlertActionFilter
  /** Only alerts raised in the last N days. Off when absent. */
  days?: number
  /** Restrict to the alerts addressed to this account, as its desk board does. */
  mine?: SessionUser
}

/** Escape a user's search so a stray `(` cannot become a regex group. */
function literal(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * One page of alerts, newest first.
 *
 * The search and the range are narrowed in the database; the action and the
 * answerer are applied here, because they come from the activity join and cannot
 * be expressed against the notification rows alone. The scan ceiling is the
 * honest limit on that: past it, narrow the range rather than page further.
 */
export async function alertLog({
  page = 1,
  pageSize = ALERTS_PAGE_SIZE,
  q,
  answeredBy,
  action = 'all',
  days,
  mine,
}: AlertLogOptions = {}): Promise<AlertLogPage> {
  const size = Math.min(Math.max(Math.round(pageSize), 1), 100)
  const global = await db('global')

  const filter: Record<string, unknown> = { kind: { $ne: 'document' } }
  const clauses: Record<string, unknown>[] = []

  if (days && days > 0) {
    filter.createdAt = { $gte: new Date(Date.now() - days * 86_400_000) }
  }

  if (mine) {
    clauses.push({
      $or: [
        ...(mine.notificationTags.length > 0
          ? [{ tags: { $in: mine.notificationTags } }]
          : []),
        // Always present, so the `$or` is never empty on an untagged account.
        { recipients: mine.userId },
      ],
    })
  }

  const search = q?.trim()
  if (search) {
    const rx = { $regex: literal(search), $options: 'i' }
    clauses.push({
      $or: [{ title: rx }, { body: rx }, { qrCodeName: rx }, { locationName: rx }],
    })
  }

  if (clauses.length > 0) filter.$and = clauses

  const rows = await global
    .collection<NotificationRow>('notifications')
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(SCAN_LIMIT)
    .toArray()

  const ids = rows.map((row) => row._id)
  // Every event that points back at an alert carries its id; a call's end only
  // carries the call, so it is read in the second pass below.
  const events = ids.length
    ? await global
        .collection<ActivityRow>('activity')
        .find({ notificationId: { $in: ids } })
        .toArray()
    : []

  const callIds = events
    .filter((event) => event.kind === 'call-started' && event.callId)
    .map((event) => String(event.callId))

  const ends = callIds.length
    ? await global
        .collection<ActivityRow>('activity')
        .find({ kind: 'call-ended', callId: { $in: callIds } })
        .toArray()
    : []

  const ended = new Map<string, ActivityRow>()
  for (const end of ends) if (end.callId) ended.set(end.callId, end)

  const answeredNames = await peopleById(
    events.filter((event) => event.kind === 'alert-answered').map((event) => event.userId),
  )

  const now = Date.now()
  const maxAgeSeconds = ALERT_ANSWER_MINUTES * 60

  const shaped = rows.map((row): AlertLogRow => {
    const about = events.filter((event) => event.notificationId === row._id)
    const answers = about
      .filter((event) => event.kind === 'alert-answered')
      .sort((left, right) => left.at.getTime() - right.at.getTime())
    const ignores = about.filter((event) => event.kind === 'alert-ignored')
    const answer = answers[0]
    const started = about.find((event) => event.kind === 'call-started' && event.callId)
    const end = started?.callId ? ended.get(started.callId) : undefined

    const ageSeconds = Math.max(0, Math.round((now - row.createdAt.getTime()) / 1000))
    const answeredSeconds = answer
      ? Math.max(
          0,
          Math.round(
            (typeof answer.latencyMs === 'number'
              ? answer.latencyMs
              : answer.at.getTime() - row.createdAt.getTime()) / 1000,
          ),
        )
      : undefined

    const action: AlertAction = answer
      ? 'answered'
      : ignores.length > 0
        ? 'ignored'
        : ageSeconds > maxAgeSeconds
          ? 'expired'
          : 'waiting'

    const mineAnswered = mine ? answers.some((event) => event.userId === mine.userId) : false
    const mineIgnored = mine ? ignores.some((event) => event.userId === mine.userId) : false

    return {
      notificationId: row._id,
      title: row.title,
      body: row.body,
      priority: row.priority,
      ...(row.qrCodeId ? { qrCodeId: row.qrCodeId } : {}),
      ...(row.qrCodeName ? { qrCodeName: row.qrCodeName } : {}),
      ...(row.locationId ? { locationId: row.locationId } : {}),
      ...(row.locationName ? { locationName: row.locationName } : {}),
      tags: row.tags ?? [],
      createdAt: row.createdAt.toISOString(),
      ageSeconds,
      action,
      ...(answer
        ? {
            answeredBy: answeredNames.get(answer.userId)?.name ?? 'Former account',
            answeredById: answer.userId,
            answerSeconds: answeredSeconds,
          }
        : {}),
      offered: about.filter((event) => event.kind === 'alert-offered').length,
      held: about.filter((event) => event.kind === 'alert-held').length,
      ...(started
        ? {
            call: {
              seconds:
                end && typeof end.durationMs === 'number'
                  ? Math.round(end.durationMs / 1000)
                  : null,
              startedAt: started.at.toISOString(),
            },
          }
        : {}),
      mine: mineAnswered ? 'answered' : mineIgnored ? 'ignored' : null,
      canAccept:
        Boolean(mine) &&
        !answer &&
        !mineAnswered &&
        !mineIgnored &&
        ageSeconds <= maxAgeSeconds,
    }
  })

  // The person filter is about who answered, so its options are the people who
  // answered under the current search rather than every account in the building.
  const byPerson = new Map<string, { userId: string; name: string; answered: number }>()
  for (const row of shaped) {
    if (!row.answeredById) continue
    const entry = byPerson.get(row.answeredById) ?? {
      userId: row.answeredById,
      name: row.answeredBy ?? 'Former account',
      answered: 0,
    }
    entry.answered += 1
    byPerson.set(row.answeredById, entry)
  }

  const byPersonFiltered = answeredBy
    ? shaped.filter((row) => row.answeredById === answeredBy)
    : shaped

  const counts: Record<AlertActionFilter, number> = {
    all: byPersonFiltered.length,
    answered: byPersonFiltered.filter((row) => row.action === 'answered').length,
    ignored: byPersonFiltered.filter((row) => row.action === 'ignored').length,
    expired: byPersonFiltered.filter((row) => row.action === 'expired').length,
    waiting: byPersonFiltered.filter((row) => row.action === 'waiting').length,
  }

  const matched = action === 'all' ? byPersonFiltered : byPersonFiltered.filter((row) => row.action === action)
  const lastPage = Math.max(1, Math.ceil(matched.length / size))
  const current = Math.min(Math.max(Math.round(page), 1), lastPage)
  const start = (current - 1) * size

  return {
    alerts: matched.slice(start, start + size),
    total: matched.length,
    page: current,
    pageSize: size,
    people: [...byPerson.values()].sort(
      (left, right) =>
        right.answered - left.answered || left.name.localeCompare(right.name, 'en'),
    ),
    counts,
  }
}
