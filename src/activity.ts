import { randomUUID } from 'node:crypto'

import { db } from './db.ts'

/**
 * What happened to an alert, and what happened on the call after it.
 *
 * Every other collection here answers "what is true now". This one answers "what
 * did people do": an alert was offered to six operators, four answered, the
 * median answer took nine seconds, one of those answers turned into a two-minute
 * video call. Those are the numbers a supervisor actually needs — whether a sign
 * is covered, and whether the person covering it is quick — and none of them can
 * be reconstructed from the notification rows, which only say what was sent.
 *
 * Events are appended, never updated, except that a call's end is written as its
 * own event so a dropped connection still closes the interval.
 *
 * `at` is the only thing read by a query; the rest is aggregated in memory. That
 * is honest for the volume this will see (an alert per scan, a handful of calls a
 * day) and keeps the report readable instead of a pipeline of `$group` stages.
 */

export type ActivityKind =
  | 'alert-offered'
  | 'alert-held'
  | 'alert-answered'
  | 'alert-ignored'
  | 'call-started'
  | 'call-ended'

export interface ActivityEvent {
  _id: string
  kind: ActivityKind
  /** The person this is about — the one who was rung, answered, or called. */
  userId: string
  at: Date
  notificationId?: string
  qrCodeId?: string
  qrCodeName?: string
  locationId?: string
  locationName?: string
  rtcDeviceId?: string
  rtcDeviceName?: string
  /** Groups a `call-started` with its `call-ended`, even across restarts. */
  callId?: string
  /** Offer to answer/ignore, in milliseconds. On the answering event. */
  latencyMs?: number
  /** The call's length, in milliseconds. On the ending event. */
  durationMs?: number
}

export type NewActivity = Omit<ActivityEvent, '_id'>

async function activity() {
  return (await db('global')).collection<ActivityEvent>('activity')
}

export async function recordActivity(events: NewActivity[]): Promise<void> {
  if (events.length === 0) return
  await (await activity()).insertMany(events.map((event) => ({ _id: randomUUID(), ...event })))
}

/** The parts of an alert an event carries, so this module need not import them. */
export interface AlertRef {
  notificationId: string
  qrCodeId?: string
  qrCodeName?: string
  locationId?: string
  locationName?: string
  rtcDeviceId?: string
  rtcDeviceName?: string
}

function alertEvent(ref: AlertRef, userId: string, kind: ActivityKind, at: Date): NewActivity {
  return {
    kind,
    userId,
    at,
    notificationId: ref.notificationId,
    ...(ref.qrCodeId ? { qrCodeId: ref.qrCodeId } : {}),
    ...(ref.qrCodeName ? { qrCodeName: ref.qrCodeName } : {}),
    ...(ref.locationId ? { locationId: ref.locationId } : {}),
    ...(ref.locationName ? { locationName: ref.locationName } : {}),
    ...(ref.rtcDeviceId ? { rtcDeviceId: ref.rtcDeviceId } : {}),
    ...(ref.rtcDeviceName ? { rtcDeviceName: ref.rtcDeviceName } : {}),
  }
}

/**
 * One row per person the alert reached — offered, or held because they were
 * already on a call.
 *
 * Held is its own kind rather than a missing offer: "nobody answered" and "nobody
 * was free to answer" are different problems, and a supervisor should be able to
 * tell them apart.
 */
export async function recordOffers(
  ref: AlertRef,
  userIds: readonly string[],
  held: boolean,
  at = new Date(),
): Promise<void> {
  await recordActivity(
    [...new Set(userIds)].map((userId) => alertEvent(ref, userId, held ? 'alert-held' : 'alert-offered', at)),
  )
}

/**
 * The click: answered or ignored, with how long it took.
 *
 * Only recorded for someone who was actually offered that alert — a stray or
 * replayed click must not invent a response time, and the offer row is what
 * carries the clock. Answering twice is not an error and not a second row.
 */
export async function acknowledgeAlert(
  notificationId: string,
  userId: string,
  outcome: 'answered' | 'ignored',
): Promise<boolean> {
  const events = await activity()

  const offer = await events.findOne({ notificationId, userId, kind: 'alert-offered' })
  if (!offer) return false

  const settled = await events.findOne({
    notificationId,
    userId,
    kind: { $in: ['alert-answered', 'alert-ignored'] },
  })
  if (settled) return true

  const ref: AlertRef = {
    notificationId,
    ...(offer.qrCodeId ? { qrCodeId: offer.qrCodeId } : {}),
    ...(offer.qrCodeName ? { qrCodeName: offer.qrCodeName } : {}),
    ...(offer.locationId ? { locationId: offer.locationId } : {}),
    ...(offer.locationName ? { locationName: offer.locationName } : {}),
    ...(offer.rtcDeviceId ? { rtcDeviceId: offer.rtcDeviceId } : {}),
    ...(offer.rtcDeviceName ? { rtcDeviceName: offer.rtcDeviceName } : {}),
  }

  await events.insertOne({
    _id: randomUUID(),
    ...alertEvent(ref, userId, outcome === 'answered' ? 'alert-answered' : 'alert-ignored', new Date()),
    latencyMs: Math.max(0, Date.now() - offer.at.getTime()),
  })

  return true
}

/** A call starting: this person is now unavailable, and that is worth counting. */
export async function recordCallStart(
  userId: string,
  ref: Partial<AlertRef> & { rtcDeviceId?: string; rtcDeviceName?: string },
): Promise<string> {
  const callId = randomUUID()
  const at = new Date()

  await recordActivity([
    {
      kind: 'call-started',
      userId,
      at,
      callId,
      ...(ref.notificationId ? { notificationId: ref.notificationId } : {}),
      ...(ref.qrCodeId ? { qrCodeId: ref.qrCodeId } : {}),
      ...(ref.qrCodeName ? { qrCodeName: ref.qrCodeName } : {}),
      ...(ref.locationId ? { locationId: ref.locationId } : {}),
      ...(ref.locationName ? { locationName: ref.locationName } : {}),
      ...(ref.rtcDeviceId ? { rtcDeviceId: ref.rtcDeviceId } : {}),
      ...(ref.rtcDeviceName ? { rtcDeviceName: ref.rtcDeviceName } : {}),
    },
  ])

  return callId
}

/** A call ending, however it ended — including a socket that simply vanished. */
export async function recordCallEnd(call: {
  callId: string
  userId: string
  startedAt: Date
}): Promise<void> {
  await recordActivity([
    {
      kind: 'call-ended',
      userId: call.userId,
      at: new Date(),
      callId: call.callId,
      durationMs: Math.max(0, Date.now() - call.startedAt.getTime()),
    },
  ])
}

export interface PersonPerformance {
  userId: string
  name: string
  roles: string[]
  offered: number
  held: number
  answered: number
  ignored: number
  /** Offered but never answered or ignored — the alert nobody picked up. */
  missed: number
  /** Answered ÷ offered, or null when they were never offered one. */
  answerRate: number | null
  medianAnswerSeconds: number | null
  averageAnswerSeconds: number | null
  calls: number
  talkSeconds: number
  lastActivityAt: string | null
}

export interface LocationPerformance {
  locationId: string
  name: string
  offered: number
  answered: number
}

export interface PerformanceReport {
  from: string
  to: string
  totals: {
    offered: number
    held: number
    answered: number
    ignored: number
    missed: number
    answerRate: number | null
    medianAnswerSeconds: number | null
    calls: number
    talkSeconds: number
  }
  people: PersonPerformance[]
  locations: LocationPerformance[]
}

/** How many events one report will read. Past this, shorten the range. */
const MAX_EVENTS = 50_000

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function average(values: number[]): number | null {
  if (values.length === 0) return null
  return values.reduce((total, value) => total + value, 0) / values.length
}

function rate(answered: number, offered: number): number | null {
  return offered === 0 ? null : answered / offered
}

/** Per-person and per-property totals over one window. */
export async function performance(from: Date, to: Date): Promise<PerformanceReport> {
  const events = await (await activity())
    .find({ at: { $gte: from, $lt: to } })
    .sort({ at: 1 })
    .limit(MAX_EVENTS)
    .toArray()

  interface Tally {
    offered: number
    held: number
    answered: number
    ignored: number
    calls: number
    talkMs: number
    latencies: number[]
    lastAt: Date | null
  }

  const blank = (): Tally => ({
    offered: 0,
    held: 0,
    answered: 0,
    ignored: 0,
    calls: 0,
    talkMs: 0,
    latencies: [],
    lastAt: null,
  })

  const people = new Map<string, Tally>()
  const places = new Map<string, { name: string; offered: number; answered: number }>()
  // Every answer in the window, for the overall median: a median of per-person
  // medians would weight a person who answered once the same as one who
  // answered fifty times.
  const latencies: number[] = []

  const tallyFor = (userId: string): Tally => {
    const existing = people.get(userId)
    if (existing) return existing
    const created = blank()
    people.set(userId, created)
    return created
  }

  const placeFor = (locationId: string, name: string) => {
    const existing = places.get(locationId)
    if (existing) return existing
    const created = { name, offered: 0, answered: 0 }
    places.set(locationId, created)
    return created
  }

  for (const event of events) {
    const tally = tallyFor(event.userId)
    if (!tally.lastAt || event.at > tally.lastAt) tally.lastAt = event.at

    switch (event.kind) {
      case 'alert-offered':
        tally.offered += 1
        if (event.locationId) placeFor(event.locationId, event.locationName || event.locationId).offered += 1
        break
      case 'alert-held':
        tally.held += 1
        break
      case 'alert-answered':
        tally.answered += 1
        if (event.locationId) placeFor(event.locationId, event.locationName || event.locationId).answered += 1
        if (typeof event.latencyMs === 'number') {
          tally.latencies.push(event.latencyMs)
          latencies.push(event.latencyMs)
        }
        break
      case 'alert-ignored':
        tally.ignored += 1
        break
      case 'call-started':
        tally.calls += 1
        break
      case 'call-ended':
        if (typeof event.durationMs === 'number') tally.talkMs += event.durationMs
        break
    }
  }

  // Names, from the accounts themselves: an event outlives a user's name change.
  const userIds = [...people.keys()]
  const users = userIds.length
    ? await (await db())
        .collection<{ _id: string; firstName?: unknown; lastName?: unknown; roles?: unknown }>('users')
        .find({ _id: { $in: userIds } })
        .toArray()
    : []

  const names = new Map(
    users.map((user) => {
      const name = [user.firstName, user.lastName]
        .map((part) => (typeof part === 'string' ? part.trim() : ''))
        .filter(Boolean)
        .join(' ')
      const roles = Array.isArray(user.roles)
        ? user.roles.filter((role): role is string => typeof role === 'string')
        : []
      return [user._id, { name, roles }] as const
    }),
  )

  const rows: PersonPerformance[] = userIds.map((userId) => {
    const tally = tallyFor(userId)
    const missed = Math.max(0, tally.offered - tally.answered - tally.ignored)

    return {
      userId,
      name: names.get(userId)?.name || 'Former account',
      roles: names.get(userId)?.roles ?? [],
      offered: tally.offered,
      held: tally.held,
      answered: tally.answered,
      ignored: tally.ignored,
      missed,
      answerRate: rate(tally.answered, tally.offered),
      medianAnswerSeconds: seconds(median(tally.latencies)),
      averageAnswerSeconds: seconds(average(tally.latencies)),
      calls: tally.calls,
      talkSeconds: Math.round(tally.talkMs / 1000),
      lastActivityAt: tally.lastAt ? tally.lastAt.toISOString() : null,
    }
  })

  rows.sort(
    (left, right) =>
      right.offered - left.offered ||
      right.answered - left.answered ||
      left.name.localeCompare(right.name, 'en', { numeric: true }),
  )

  const totals = rows.reduce(
    (sum, row) => ({
      offered: sum.offered + row.offered,
      held: sum.held + row.held,
      answered: sum.answered + row.answered,
      ignored: sum.ignored + row.ignored,
      missed: sum.missed + row.missed,
      calls: sum.calls + row.calls,
      talkSeconds: sum.talkSeconds + row.talkSeconds,
    }),
    { offered: 0, held: 0, answered: 0, ignored: 0, missed: 0, calls: 0, talkSeconds: 0 },
  )

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    totals: {
      ...totals,
      answerRate: rate(totals.answered, totals.offered),
      medianAnswerSeconds: seconds(median(latencies)),
    },
    people: rows,
    locations: [...places.entries()]
      .map(([locationId, value]) => ({
        locationId,
        name: value.name,
        offered: value.offered,
        answered: value.answered,
      }))
      .sort((left, right) => right.offered - left.offered),
  }
}

/** Milliseconds to seconds, rounded to one decimal, or null. */
function seconds(value: number | null): number | null {
  return value === null ? null : Math.round(value / 100) / 10
}

/**
 * What one person did in one window — the tally behind a support session.
 *
 * The same six kinds as the report, plus the two counts a supervisor asks for
 * about a single shift: how many alerts actually reached them, and how many of
 * those they clicked (answered or ignored — a tap is a tap, whatever came of it).
 */
export interface PersonActivity {
  userId: string
  offered: number
  held: number
  answered: number
  ignored: number
  /** Offered but never answered or ignored. */
  missed: number
  answerRate: number | null
  medianAnswerSeconds: number | null
  averageAnswerSeconds: number | null
  calls: number
  talkSeconds: number
  /** Distinct alerts that reached them, whether offered or held during a call. */
  notifications: number
  /** Alerts they clicked: answered plus ignored. */
  clicked: number
  firstActivityAt: string | null
  lastActivityAt: string | null
}

/**
 * One person's events in `[from, to)`, tallied.
 *
 * Narrowed in the query rather than filtered in memory, which is what makes this
 * cheap enough to run per session: a shift is a small slice of the log, and the
 * report's 50,000-event ceiling is for everyone at once.
 */
export async function personActivity(
  userId: string,
  from: Date,
  to: Date,
): Promise<PersonActivity> {
  const events = await (await activity())
    .find({ userId, at: { $gte: from, $lt: to } })
    .sort({ at: 1 })
    .limit(MAX_EVENTS)
    .toArray()

  let offered = 0
  let held = 0
  let answered = 0
  let ignored = 0
  let calls = 0
  let talkMs = 0
  const latencies: number[] = []
  const alerts = new Set<string>()

  for (const event of events) {
    switch (event.kind) {
      case 'alert-offered':
        offered += 1
        break
      case 'alert-held':
        held += 1
        break
      case 'alert-answered':
        answered += 1
        if (typeof event.latencyMs === 'number') latencies.push(event.latencyMs)
        break
      case 'alert-ignored':
        ignored += 1
        break
      case 'call-started':
        calls += 1
        break
      case 'call-ended':
        if (typeof event.durationMs === 'number') talkMs += event.durationMs
        break
    }

    // An alert is one row per person, so the offer is the row that says it
    // reached them; an answer without an offer in the window belongs to an alert
    // offered before the shift began and is not counted as one they were given.
    if (event.notificationId && (event.kind === 'alert-offered' || event.kind === 'alert-held')) {
      alerts.add(event.notificationId)
    }
  }

  const first = events[0]
  const last = events[events.length - 1]

  return {
    userId,
    offered,
    held,
    answered,
    ignored,
    missed: Math.max(0, offered - answered - ignored),
    answerRate: rate(answered, offered),
    medianAnswerSeconds: seconds(median(latencies)),
    averageAnswerSeconds: seconds(average(latencies)),
    calls,
    talkSeconds: Math.round(talkMs / 1000),
    notifications: alerts.size,
    clicked: answered + ignored,
    firstActivityAt: first ? first.at.toISOString() : null,
    lastActivityAt: last ? last.at.toISOString() : null,
  }
}
