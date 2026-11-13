import type { SessionUser } from './auth/session.ts'
import { recordActivity } from './activity.ts'
import { db } from './db.ts'
import { peopleById } from './support.ts'

/**
 * Taking an alert from the desk.
 *
 * An alert is addressed to tags, and delivery goes to whoever is on duty when it
 * is raised. The list a person reads is `alertLog.ts`; this module is the part
 * that lets them take one — an offer at the moment they took it, and an answer
 * whose response time starts at the alert, not at the claim, because that is how
 * long the visitor waited.
 *
 * **Five minutes is the whole life of an alert.** Two hours read as a backlog: a
 * visitor at a sign is gone long before that, and an answer an hour late is not an
 * answer — it is a number moving in a report. Five minutes is long enough to walk
 * to the desk, short enough that an alert nobody took stops pretending to be
 * takeable.
 */

/**
 * How long an alert can still be answered. One number: the list stops offering it
 * and the server stops accepting a claim at the same instant.
 */
export const ALERT_ANSWER_MINUTES = 5

/** The bits of a notification this module reads. */
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

/** Only the two events that settle an alert. */
interface SettleRow {
  notificationId?: string
  userId: string
  kind: string
}

export type AlertOutcome = 'open' | 'answered' | 'ignored'

export interface DeskAlert {
  notificationId: string
  title: string
  body: string
  priority: 'loud' | 'quiet'
  qrCodeId?: string
  qrCodeName?: string
  locationName?: string
  createdAt: string
  ageSeconds: number
  /** What became of it, from the activity log. */
  outcome: AlertOutcome
  /** Who answered it, when somebody did. */
  answeredBy?: string
  /** What this person did, if anything. */
  mine: 'answered' | 'ignored' | null
  /** True when this person could still take it: unanswered, unsettled by them, in time. */
  canAccept: boolean
  tags: string[]
}

export class DeskAlertError extends Error {
  status: 403 | 404 | 409

  constructor(message: string, status: 403 | 404 | 409) {
    super(message)
    this.name = 'DeskAlertError'
    this.status = status
  }
}

/** What an activity event needs to point back at the alert it is about. */
function refOf(row: NotificationRow) {
  return {
    notificationId: row._id,
    ...(row.qrCodeId ? { qrCodeId: row.qrCodeId } : {}),
    ...(row.qrCodeName ? { qrCodeName: row.qrCodeName } : {}),
    ...(row.locationId ? { locationId: row.locationId } : {}),
    ...(row.locationName ? { locationName: row.locationName } : {}),
  }
}

/** Rows in, board out — settled state read in one query. */
async function shapeAlerts(
  user: SessionUser,
  rows: NotificationRow[],
  maxAgeSeconds: number,
): Promise<DeskAlert[]> {
  if (rows.length === 0) return []

  const global = await db('global')
  const events = await global
    .collection<SettleRow>('activity')
    .find({
      notificationId: { $in: rows.map((row) => row._id) },
      kind: { $in: ['alert-answered', 'alert-ignored'] },
    })
    .toArray()

  const names = await peopleById(events.map((event) => event.userId))

  interface Settled {
    answered: boolean
    ignored: boolean
    answeredBy?: string
    mine: 'answered' | 'ignored' | null
  }

  const settled = new Map<string, Settled>()
  for (const event of events) {
    const key = event.notificationId
    if (!key) continue

    const entry = settled.get(key) ?? { answered: false, ignored: false, mine: null }
    if (event.kind === 'alert-answered') {
      entry.answered = true
      entry.answeredBy = entry.answeredBy ?? names.get(event.userId)?.name ?? 'Someone'
    } else {
      entry.ignored = true
    }
    if (event.userId === user.userId) {
      entry.mine = event.kind === 'alert-answered' ? 'answered' : 'ignored'
    }
    settled.set(key, entry)
  }

  const now = Date.now()

  return rows.map((row) => {
    const entry = settled.get(row._id)
    const outcome: AlertOutcome = entry?.answered ? 'answered' : entry?.ignored ? 'ignored' : 'open'
    const mine = entry?.mine ?? null
    const ageSeconds = Math.max(0, Math.round((now - row.createdAt.getTime()) / 1000))

    return {
      notificationId: row._id,
      title: row.title,
      body: row.body,
      priority: row.priority,
      ...(row.qrCodeId ? { qrCodeId: row.qrCodeId } : {}),
      ...(row.qrCodeName ? { qrCodeName: row.qrCodeName } : {}),
      ...(row.locationName ? { locationName: row.locationName } : {}),
      createdAt: row.createdAt.toISOString(),
      ageSeconds,
      outcome,
      ...(entry?.answeredBy ? { answeredBy: entry.answeredBy } : {}),
      mine,
      canAccept: mine === null && outcome !== 'answered' && ageSeconds <= maxAgeSeconds,
      tags: row.tags ?? [],
    }
  })
}

/**
 * Takes an alert from the list.
 *
 * Refusals are about ownership and age: an alert nobody addressed to this person
 * is not theirs to take, one that is five minutes old can no longer be answered,
 * and one somebody answered is theirs. One this person already settled is
 * returned as it stands rather than recorded twice.
 */
export async function claimDeskAlert(
  user: SessionUser,
  notificationId: string,
): Promise<DeskAlert> {
  const global = await db('global')
  const row = await global
    .collection<NotificationRow>('notifications')
    .findOne({ _id: notificationId })

  if (!row || row.kind === 'document') throw new DeskAlertError('That alert is not there', 404)

  const addressed =
    (row.recipients ?? []).includes(user.userId) ||
    (row.tags ?? []).some((tag) => user.notificationTags.includes(tag))

  if (!addressed) throw new DeskAlertError('That alert was not addressed to you', 403)

  const activity = global.collection<SettleRow>('activity')

  const mine = await activity.findOne({
    notificationId,
    userId: user.userId,
    kind: { $in: ['alert-answered', 'alert-ignored'] },
  })

  // Already settled by this person: answer with the board row, which says so.
  if (mine) return boardRow(user, row, ALERT_ANSWER_MINUTES * 60)

  const answered = await activity.findOne({ notificationId, kind: 'alert-answered' })
  if (answered) {
    throw new DeskAlertError('Somebody else has already answered that alert', 409)
  }

  const ageSeconds = Math.max(0, Math.round((Date.now() - row.createdAt.getTime()) / 1000))
  if (ageSeconds > ALERT_ANSWER_MINUTES * 60) {
    throw new DeskAlertError(
      `That alert is more than ${ALERT_ANSWER_MINUTES} minutes old, so it can no longer be answered`,
      409,
    )
  }

  const now = new Date()
  const ref = refOf(row)

  await recordActivity([
    // The offer is written at the moment of the claim so that
    // answered ÷ offered stays a rate. Without it, picking up an alert raised
    // before the shift would count an answer that was never offered.
    { kind: 'alert-offered', userId: user.userId, at: now, ...ref },
    {
      kind: 'alert-answered',
      userId: user.userId,
      at: now,
      ...ref,
      // Measured from the alert, not the claim: that is how long the visitor
      // at the sign waited.
      latencyMs: Math.max(0, now.getTime() - row.createdAt.getTime()),
      claimed: true,
    },
  ])

  return boardRow(user, row, ALERT_ANSWER_MINUTES * 60)
}

/** One row of the list after the fact, shaped the same way the list is. */
async function boardRow(
  user: SessionUser,
  row: NotificationRow,
  maxAgeSeconds: number,
): Promise<DeskAlert> {
  const [shaped] = await shapeAlerts(user, [row], maxAgeSeconds)
  if (!shaped) throw new DeskAlertError('That alert is not there', 404)
  return shaped
}
