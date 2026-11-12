import type { SessionUser } from './auth/session.ts'
import { recordActivity } from './activity.ts'
import { db } from './db.ts'
import { peopleById } from './support.ts'

/**
 * The desk board: the alerts still worth picking up.
 *
 * An alert is addressed to tags, and delivery goes to whoever is on duty when it
 * is raised. That leaves a gap that matters at the change of a shift: a code
 * scanned at 07:58 belongs to the person who starts at 08:00 as much as to the
 * one who was on at the time — the visitor may still be standing at the sign.
 *
 * So this is not a second inbox and nothing is re-sent: it is a reading of the
 * alerts **already addressed to this person's tags** in the last couple of hours,
 * with what became of each. Claiming one records the answer against them — an
 * offer at the moment they took it, and an answer whose response time starts at
 * the alert, not at the claim, because that is how long the visitor waited.
 *
 * Documents are not here. A posted statement is addressed to investors and is not
 * a desk alert; the board only carries what a scan or a manual send raised.
 */

/** How far back the board looks. Two hours covers a shift change comfortably. */
export const ALERT_WINDOW_MINUTES = 120

/** How many rows the board will carry at once. */
export const MAX_DESK_ALERTS = 40

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
  /**
   * True when this person could still take it: nobody has answered, and they
   * have not settled it themselves. An alert somebody else ignored stays
   * claimable — they saw it and did nothing, which is not a decision about the
   * visitor standing at the sign.
   */
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

/**
 * The alerts addressed to this person in the window, newest first.
 *
 * "Addressed to" is the same rule delivery uses: a tag overlap, or a named
 * recipient from a code configured before tags existed. Nothing is filtered by
 * who was on duty — that is exactly the point of the board.
 */
export async function recentDeskAlerts(
  user: SessionUser,
  { minutes = ALERT_WINDOW_MINUTES, limit = MAX_DESK_ALERTS }: { minutes?: number; limit?: number } = {},
): Promise<DeskAlert[]> {
  const window = Math.min(Math.max(Math.round(minutes), 5), 24 * 60)
  const capped = Math.min(Math.max(Math.round(limit), 1), 100)
  const since = new Date(Date.now() - window * 60_000)

  const global = await db('global')

  const rows = await global
    .collection<NotificationRow>('notifications')
    .find({
      kind: { $ne: 'document' },
      createdAt: { $gte: since },
      $or: [
        ...(user.notificationTags.length > 0
          ? [{ tags: { $in: user.notificationTags } }]
          : []),
        // Always present, so the `$or` is never an empty array on an account
        // with no tags and no named sends.
        { recipients: user.userId },
      ],
    })
    .sort({ createdAt: -1 })
    .limit(capped)
    .toArray()

  return shapeAlerts(user, rows)
}

/** Rows in, board out — settled state read in one query per batch. */
async function shapeAlerts(user: SessionUser, rows: NotificationRow[]): Promise<DeskAlert[]> {
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

    return {
      notificationId: row._id,
      title: row.title,
      body: row.body,
      priority: row.priority,
      ...(row.qrCodeId ? { qrCodeId: row.qrCodeId } : {}),
      ...(row.qrCodeName ? { qrCodeName: row.qrCodeName } : {}),
      ...(row.locationName ? { locationName: row.locationName } : {}),
      createdAt: row.createdAt.toISOString(),
      ageSeconds: Math.max(0, Math.round((now - row.createdAt.getTime()) / 1000)),
      outcome,
      ...(entry?.answeredBy ? { answeredBy: entry.answeredBy } : {}),
      mine,
      canAccept: mine === null && outcome !== 'answered',
      tags: row.tags ?? [],
    }
  })
}

/**
 * Takes an alert from the board.
 *
 * Refusals are about ownership, not age: an alert older than the window is not
 * on the board to claim, and one somebody has already answered is theirs. One
 * this person already settled is returned as it stands rather than recorded twice.
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
  if (mine) return boardRow(user, row)

  const answered = await activity.findOne({ notificationId, kind: 'alert-answered' })
  if (answered) {
    throw new DeskAlertError('Somebody else has already answered that alert', 409)
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

  return boardRow(user, row)
}

/** One row of the board after the fact, shaped the same way the list is. */
async function boardRow(user: SessionUser, row: NotificationRow): Promise<DeskAlert> {
  const [shaped] = await shapeAlerts(user, [row])
  if (!shaped) throw new DeskAlertError('That alert is not there', 404)
  return shaped
}
