import { randomUUID } from 'node:crypto'

import jwt from 'jsonwebtoken'
import type { Collection, Document } from 'mongodb'

import { db } from '../db.ts'

/**
 * The Cubby half of the refresh, in v1's two stages.
 *
 * `refreshCubbyData` pulls the Cubby warehouse and API into three staging
 * collections plus the facility list; `processCubbyData` turns those into one
 * `statistics` block per facility. They are separate endpoints because they have
 * separate schedules and very different work: the first is a handful of large
 * reads, the second is arithmetic over every unit in the portfolio plus four API
 * calls per facility. v1 split them for Vercel's 300-second limit; the split is
 * kept because the two reads can fail independently of the arithmetic.
 *
 * Wire formats are Cubby's own — amounts in cents, dates as ISO strings — and
 * they are stored as they arrive in `cubbyRentRoll`, `cubbyPricingGroups` and
 * `cubbyAgedReceivables`, exactly as v1 left them.
 *
 * Google is spoken to directly with a signed JWT rather than through
 * `@google-cloud/bigquery`: one query against one table does not justify the
 * client, and the project already talks to Google this way for photo uploads.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/bigquery'
const CUBBY_API = 'https://api.cubbystorage.com/v1/'
/** v1's Cubby organization. */
const CUBBY_ORGANIZATION_ID = 'org_Ps39HPMgHAf'
const FACILITIES_SQL = 'select * from `cubby-partner-data.analytics.facilities` limit 100'

interface ServiceAccount {
  projectId: string
  clientEmail: string
  privateKey: string
}

interface BigQueryField {
  name?: string
  type?: string
}

interface BigQueryResponse {
  jobComplete?: boolean
  jobReference?: { jobId?: string }
  schema?: { fields?: BigQueryField[] }
  rows?: { f?: ({ v?: unknown } | undefined)[] }[]
  errors?: { message?: string }[]
  error?: { message?: string }
}

interface FacilityRow {
  facility_id?: unknown
  internal_name?: unknown
}

interface LocationRow {
  _id: string
  name?: string
  active?: boolean
  kpiActive?: boolean
  cubbyFacilityId?: unknown
}

export interface RentRollEntry {
  facilityId?: unknown
  status?: unknown
  standardRate?: unknown
  monthlyRentalAmount?: unknown
  width?: unknown
  depth?: unknown
  autoPayEnabled?: unknown
  overlockApplied?: unknown
  pricingGroupId?: unknown
}

export interface PricingGroup {
  pricingGroupId?: unknown
  parking?: unknown
  vehicleStorage?: unknown
}

export interface AgedReceivable {
  facilityId?: unknown
  ranges?: ({ range?: unknown; amount?: unknown } | undefined)[]
}

/** The `statistics` block a facility carries after processing. */
export type FacilityStatistics = Record<string, number>

function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function round(value: number): number {
  return Number(value.toFixed(2))
}

function id(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

// ---------------------------------------------------------------------------
// Cubby's warehouse (BigQuery)
// ---------------------------------------------------------------------------

let cachedToken: { value: string; expiresAt: number } | null = null

function serviceAccount(): ServiceAccount {
  const encoded = process.env.CUBBY_BQ_KEY
  if (!encoded) {
    throw new Error('The Cubby warehouse needs CUBBY_BQ_KEY in the environment')
  }

  let parsed: { project_id?: string; client_email?: string; private_key?: string }
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch {
    throw new Error('CUBBY_BQ_KEY is not base64-encoded service account JSON')
  }

  const projectId = parsed.project_id
  const clientEmail = parsed.client_email
  // The key arrives with its newlines escaped into the JSON string.
  const privateKey = (parsed.private_key ?? '').replace(/\\n/g, '\n')

  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('CUBBY_BQ_KEY is missing project_id, client_email or private_key')
  }

  return { projectId, clientEmail, privateKey }
}

async function accessToken(account: ServiceAccount): Promise<string> {
  if (cachedToken && cachedToken.expiresAt - Date.now() > 60_000) return cachedToken.value

  const assertion = jwt.sign({ scope: BIGQUERY_SCOPE }, account.privateKey, {
    algorithm: 'RS256',
    expiresIn: 3600,
    issuer: account.clientEmail,
    audience: TOKEN_URL,
  })

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  })

  const payload = (await response.json().catch(() => null)) as {
    access_token?: unknown
    expires_in?: unknown
  } | null

  if (!response.ok || typeof payload?.access_token !== 'string') {
    throw new Error('Google refused the Cubby warehouse credentials')
  }

  cachedToken = {
    value: payload.access_token,
    expiresAt: Date.now() + (num(payload.expires_in) || 3600) * 1000,
  }
  return cachedToken.value
}

async function bigQueryRequest(
  url: string,
  token: string,
  body?: unknown,
): Promise<BigQueryResponse> {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

  const payload = (await response.json().catch(() => null)) as BigQueryResponse | null
  const reason =
    payload?.error?.message ?? payload?.errors?.[0]?.message ?? response.statusText ?? ''

  if (!response.ok || !payload) {
    throw new Error(`The Cubby warehouse refused the query${reason ? ` (${reason})` : ''}`)
  }
  if (payload.errors?.length) {
    throw new Error(`The Cubby warehouse query failed${reason ? ` (${reason})` : ''}`)
  }

  return payload
}

/** One cell, narrowed by the column's declared type. */
function cellValue(field: BigQueryField, cell: { v?: unknown } | undefined): unknown {
  const value = cell?.v
  if (value === undefined || value === null) return null

  switch (field.type) {
    case 'INTEGER':
    case 'INT64':
    case 'FLOAT':
    case 'FLOAT64':
      return Number(value)
    case 'BOOLEAN':
    case 'BOOL':
      return value === true || value === 'true'
    default:
      return value
  }
}

function rowsOf(payload: BigQueryResponse): Record<string, unknown>[] {
  const fields = payload.schema?.fields ?? []

  return (payload.rows ?? []).map((row) => {
    const record: Record<string, unknown> = {}
    fields.forEach((field, index) => {
      record[field.name ?? `column_${index}`] = cellValue(field, row.f?.[index])
    })
    return record
  })
}

async function bigQuery(sql: string): Promise<Record<string, unknown>[]> {
  const account = serviceAccount()
  const token = await accessToken(account)
  const project = encodeURIComponent(account.projectId)

  let payload = await bigQueryRequest(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`,
    token,
    { query: sql, useLegacySql: false, timeoutMs: 60_000 },
  )

  // A query that outlives the wait comes back as a job to poll instead.
  for (let attempt = 0; payload.jobComplete === false && attempt < 30; attempt += 1) {
    const jobId = payload.jobReference?.jobId
    if (!jobId) break

    await new Promise((resolve) => setTimeout(resolve, 1000))
    payload = await bigQueryRequest(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries/${encodeURIComponent(jobId)}?timeoutMs=10000`,
      token,
    )
  }

  if (payload.jobComplete === false) {
    throw new Error('The Cubby warehouse query did not finish in time')
  }

  return rowsOf(payload)
}

// ---------------------------------------------------------------------------
// Cubby's API
// ---------------------------------------------------------------------------

/** One POST, answered with the payload inside `data`. */
async function cubbyPost<T>(route: string, body: unknown): Promise<T> {
  const key = process.env.CUBBY_API_KEY
  if (!key) throw new Error('Cubby reads need CUBBY_API_KEY in the environment')

  const response = await fetch(`${CUBBY_API}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  })

  const payload = (await response.json().catch(() => null)) as {
    data?: T
    error?: unknown
    message?: unknown
  } | null

  if (!response.ok || !payload) {
    throw new Error(`Cubby refused ${route} (HTTP ${response.status})`)
  }

  if (payload.error) {
    const detail =
      typeof payload.error === 'object' && payload.error !== null && 'message' in payload.error
        ? String((payload.error as { message?: unknown }).message)
        : String(payload.error)
    throw new Error(`Cubby refused ${route} (${detail})`)
  }

  if (!payload.data) throw new Error(`Cubby returned nothing for ${route}`)

  return payload.data
}

// ---------------------------------------------------------------------------
// Stage one: pull
// ---------------------------------------------------------------------------

export interface CubbyIngestResult {
  facilities: number
  createdLocations: number
  linkedFacilities: number
  rentRoll: number
  pricingGroups: number
  agedReceivables: number
}

/**
 * Refills the staging collections and links any facility that is new.
 *
 * A facility the warehouse reports but no location claims is created, active
 * and on the KPI board — that is how a new property first appears, and v1 did
 * the same.
 */
export async function refreshCubbyData(): Promise<CubbyIngestResult> {
  const loglady = await db('loglady')
  const locations = loglady.collection<LocationRow>('locations')

  const facilities = await bigQuery(FACILITIES_SQL)
  const existing = await locations.find({}).project({ cubbyFacilityId: 1 }).toArray()
  const linked = new Set(existing.map((location) => id(location.cubbyFacilityId)).filter(Boolean))

  let createdLocations = 0

  for (const facility of facilities as FacilityRow[]) {
    const cubbyFacilityId = id(facility.facility_id)
    if (!cubbyFacilityId || linked.has(cubbyFacilityId)) continue

    await locations.insertOne({
      _id: randomUUID(),
      active: true,
      kpiActive: true,
      cubbyFacilityId,
      name: id(facility.internal_name),
    })
    linked.add(cubbyFacilityId)
    createdLocations += 1
  }

  const facilityIds = [...linked]
  if (facilityIds.length === 0) {
    throw new Error(
      'No facility is linked to a Cubby facility id, so there is nothing to pull. Check CUBBY_BQ_KEY.',
    )
  }

  // Today's date, which is what a rent roll is read as of.
  const throughDate = new Date().toISOString().slice(0, 10)

  const rentRoll = await cubbyPost<{ entries?: RentRollEntry[] }>('reports/rent-roll', {
    where: { facilityIds, throughDate },
  })
  const pricingGroups = await cubbyPost<{ pricingGroups?: PricingGroup[] }>(
    'pricing-groups/search',
    { where: { organizationId: CUBBY_ORGANIZATION_ID } },
  )
  const agedReceivables = await cubbyPost<{ entries?: AgedReceivable[] }>(
    'reports/aged-receivables',
    { where: { facilityIds } },
  )

  const counts = {
    rentRoll: await replace(loglady.collection('cubbyRentRoll'), rentRoll.entries),
    pricingGroups: await replace(
      loglady.collection('cubbyPricingGroups'),
      pricingGroups.pricingGroups,
    ),
    agedReceivables: await replace(
      loglady.collection('cubbyAgedReceivables'),
      agedReceivables.entries,
    ),
  }

  return {
    facilities: facilities.length,
    createdLocations,
    linkedFacilities: facilityIds.length,
    ...counts,
  }
}

/**
 * Replaces a staging collection with what was just read.
 *
 * An empty answer keeps what is stored: v1 replaced on any truthy value, so a
 * quiet day at one facility could empty a table and zero every metric derived
 * from it. The refreshed data is what a stale-but-real number should give way
 * to, not an absence of data.
 */
async function replace(collection: Collection, rows: unknown[] | undefined): Promise<number> {
  if (!rows || rows.length === 0) return 0

  await collection.deleteMany({})
  // Cubby's rows are stored as they arrived; the collections are read back
  // through the interfaces above.
  await collection.insertMany(rows as Document[])
  return rows.length
}

// ---------------------------------------------------------------------------
// Stage two: process
// ---------------------------------------------------------------------------

export interface CubbyProcessResult {
  facilities: number
  updated: number
  failures: { locationId: string; name: string; error: string }[]
}

/**
 * Turns the staging collections into each facility's `statistics`.
 *
 * Every field here is one the KPI board or the investor portal reads, with the
 * names v1 wrote (`src/kpi.ts` and `src/investor.ts` map them).
 */
export async function processCubbyData(): Promise<CubbyProcessResult> {
  const loglady = await db('loglady')

  const [rentRoll, pricingGroups, agedReceivables, locations] = await Promise.all([
    loglady.collection<RentRollEntry>('cubbyRentRoll').find({}).toArray(),
    loglady.collection<PricingGroup>('cubbyPricingGroups').find({}).toArray(),
    loglady.collection<AgedReceivable>('cubbyAgedReceivables').find({}).toArray(),
    loglady
      .collection<LocationRow>('locations')
      .find({ cubbyFacilityId: { $exists: true } })
      .toArray(),
  ])

  // Without a rent roll every metric would come out as zero, and writing that
  // would look like a portfolio that emptied overnight.
  if (rentRoll.length === 0) {
    throw new Error('The staging tables are empty. Run /api/cron/cubby first.')
  }

  const rentRollByFacility = new Map<string, RentRollEntry[]>()
  for (const unit of rentRoll) {
    const key = id(unit.facilityId)
    if (!key) continue
    const group = rentRollByFacility.get(key)
    if (group) group.push(unit)
    else rentRollByFacility.set(key, [unit])
  }

  const receivablesByFacility = new Map<string, AgedReceivable[]>()
  for (const receivable of agedReceivables) {
    const key = id(receivable.facilityId)
    if (!key) continue
    const group = receivablesByFacility.get(key)
    if (group) group.push(receivable)
    else receivablesByFacility.set(key, [receivable])
  }

  const pricingGroupById = new Map(pricingGroups.map((group) => [id(group.pricingGroupId), group]))

  const now = new Date()
  const windowStart = new Date(now)
  windowStart.setDate(windowStart.getDate() - 30)
  const window = { now, start: windowStart }

  const failures: CubbyProcessResult['failures'] = []
  let updated = 0

  for (const location of locations) {
    const cubbyFacilityId = id(location.cubbyFacilityId)
    if (!cubbyFacilityId) continue

    try {
      const statistics = await statisticsFor({
        facilityId: cubbyFacilityId,
        rentRoll: rentRollByFacility.get(cubbyFacilityId) ?? [],
        agedReceivables: receivablesByFacility.get(cubbyFacilityId) ?? [],
        pricingGroupById,
        window,
      })

      await loglady
        .collection<LocationRow>('locations')
        .updateOne({ _id: location._id }, { $set: { statistics } })
      updated += 1
    } catch (cause) {
      // One facility's API trouble must not cost the other twenty-two their
      // numbers, and must not blank this one's either.
      failures.push({
        locationId: String(location._id),
        name: id(location.name),
        error: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  return { facilities: locations.length, updated, failures }
}

interface StatisticsInput {
  facilityId: string
  rentRoll: RentRollEntry[]
  agedReceivables: AgedReceivable[]
  pricingGroupById: Map<string, PricingGroup>
  window: { now: Date; start: Date }
}

function dateOf(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null
  const parsed = new Date(String(value))
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function atOrBefore(value: unknown, limit: Date): boolean {
  const date = dateOf(value)
  return Boolean(date && date <= limit)
}

function atOrAfter(value: unknown, floor: Date): boolean {
  const date = dateOf(value)
  return Boolean(date && date >= floor)
}

function between(value: unknown, from: Date, to: Date): boolean {
  const date = dateOf(value)
  return Boolean(date && date >= from && date <= to)
}

interface UnitInput {
  rentRoll: RentRollEntry[]
  agedReceivables: AgedReceivable[]
  pricingGroupById: Map<string, PricingGroup>
}

/**
 * What a rent roll and the aged receivables alone say about a facility.
 *
 * Kept apart from the activity calls below: this is the arithmetic, it is the
 * same arithmetic v1 does, and it can be checked without asking Cubby anything.
 */
export function unitStatistics(input: UnitInput): FacilityStatistics {
  const { rentRoll, agedReceivables, pricingGroupById } = input

  const isRented = (unit: RentRollEntry) => unit.status === 'RENTED'
  const isRentable = (unit: RentRollEntry) => unit.status !== 'UNAVAILABLE'
  const area = (unit: RentRollEntry) => num(unit.width) * num(unit.depth)
  const total = (units: RentRollEntry[], pick: (unit: RentRollEntry) => number) =>
    units.reduce((sum, unit) => sum + pick(unit), 0)
  const pct = (part: number, whole: number) => (whole ? round((part / whole) * 100) : 0)

  // Occupancy, in units and in square feet, recorded twice: against everything
  // the facility has and against what is actually rentable.
  const occupancyOf = (units: RentRollEntry[]) => {
    const rentable = units.filter(isRentable)
    const rented = units.filter(isRented)
    return {
      units: units.length,
      rented: rented.length,
      rentable: rentable.length,
      sf: total(units, area),
      rentableSf: total(rentable, area),
      rentedSf: total(rented, area),
      unitOccupancy: pct(rented.length, units.length),
      availableUnitOccupancy: pct(rented.length, rentable.length),
      sfOccupancy: pct(total(rented, area), total(units, area)),
      sfAvailableOccupancy: pct(total(rented, area), total(rentable, area)),
    }
  }

  const facility = occupancyOf(rentRoll)
  const unavailable = rentRoll.filter((unit) => unit.status === 'UNAVAILABLE')
  const rented = rentRoll.filter(isRented)

  // A unit belongs to whichever kind its pricing group says. v1 treats every
  // group that is not parking as storage — vehicle storage included — and every
  // parking group as parking; a unit whose group is missing counts as neither.
  const groupOf = (unit: RentRollEntry) => pricingGroupById.get(id(unit.pricingGroupId))
  const storage = occupancyOf(
    rentRoll.filter((unit) => {
      const group = groupOf(unit)
      return Boolean(group) && !group?.parking
    }),
  )
  const parking = occupancyOf(
    rentRoll.filter((unit) => {
      const group = groupOf(unit)
      return Boolean(group) && Boolean(group?.parking)
    }),
  )

  // Aged receivables, in dollars. Ranges are the buckets Cubby reports.
  const rangeAmount = (receivable: AgedReceivable, range: string) =>
    num((receivable.ranges ?? []).find((entry) => entry?.range === range)?.amount)
  const bucket = (range: string) =>
    agedReceivables.reduce((sum, receivable) => sum + rangeAmount(receivable, range), 0) / 100

  const owes = (receivable: AgedReceivable, ranges: string[]) =>
    ranges.some((range) => rangeAmount(receivable, range) > 0)

  const delinquentUnitsLt30 = agedReceivables.filter(
    (receivable) =>
      rangeAmount(receivable, 'RANGE_0_30') > 0 &&
      !owes(receivable, ['RANGE_30_60', 'RANGE_60_90', 'RANGE_90_120', 'RANGE_120_PLUS']),
  ).length
  const delinquentUnitsGt30 = agedReceivables.filter((receivable) =>
    owes(receivable, ['RANGE_30_60', 'RANGE_60_90', 'RANGE_90_120', 'RANGE_120_PLUS']),
  ).length
  const delinquentUnitsGt60 = agedReceivables.filter((receivable) =>
    owes(receivable, ['RANGE_60_90', 'RANGE_90_120', 'RANGE_120_PLUS']),
  ).length
  const delinquentUnitsGt90 = agedReceivables.filter((receivable) =>
    owes(receivable, ['RANGE_90_120', 'RANGE_120_PLUS']),
  ).length
  const delinquentUnitsGt120 = agedReceivables.filter((receivable) =>
    owes(receivable, ['RANGE_120_PLUS']),
  ).length

  const autoPayUnits = rentRoll.filter((unit) => Boolean(unit.autoPayEnabled)).length
  const overlocks = rentRoll.filter((unit) => Boolean(unit.overlockApplied)).length

  const totalRentableUnitsValue =
    total(rentRoll.filter(isRentable), (unit) => num(unit.standardRate)) / 100
  const totalRentedUnitsValue = total(rented, (unit) => num(unit.monthlyRentalAmount)) / 100

  return {
    delinquentUnitsLt30,
    delinquentUnitsGt30,
    delinquentUnitsGt60,
    delinquentUnitsGt90,
    delinquentUnitsGt120,

    totalUnits: facility.units,
    totalRentableUnits: facility.rentable,
    totalRentedUnits: facility.rented,
    totalRentedUnitsStandardValue: total(rented, (unit) => num(unit.standardRate)) / 100,
    totalRentableUnitsValue,
    totalUnavailableUnits: unavailable.length,
    totalUnavailableValue: total(unavailable, (unit) => num(unit.standardRate)) / 100,

    totalFacilitySf: facility.sf,
    facilityRentableSf: facility.rentableSf,
    totalRentedUnitsValue,

    totalStorageUnits: storage.units,
    totalRentedStorageUnits: storage.rented,
    totalStorageSf: storage.sf,
    totalRentableStorageSf: storage.rentableSf,
    rentedStorageSf: storage.rentedSf,

    totalParkingUnits: parking.units,
    totalRentedParkingUnits: parking.rented,
    totalParkingSf: parking.sf,
    totalRentableParkingSf: parking.rentableSf,
    rentedParkingSf: parking.rentedSf,

    facilityOccupancy: facility.unitOccupancy,
    facilitySfOccupancy: facility.sfOccupancy,
    facilitySfAvailableOccupancy: facility.sfAvailableOccupancy,
    facilityAvailableUnitOccupancy: facility.availableUnitOccupancy,

    storageUnitOccupancy: storage.unitOccupancy,
    storageAvailableUnitOccupancy: storage.availableUnitOccupancy,
    storageSfOccupancy: storage.sfOccupancy,
    storageSfAvailableOccupancy: storage.sfAvailableOccupancy,

    parkingUnitOccupancy: parking.unitOccupancy,
    parkingAvailableUnitOccupancy: parking.availableUnitOccupancy,
    parkingSfOccupancy: parking.sfOccupancy,
    parkingSfAvailableOccupancy: parking.sfAvailableOccupancy,

    ar30days: bucket('RANGE_0_30'),
    ar3060days: bucket('RANGE_30_60'),
    ar6090days: bucket('RANGE_60_90'),
    ar90120days: bucket('RANGE_90_120'),
    ar120plusdays: bucket('RANGE_120_PLUS'),

    economicOccupancy: pct(totalRentedUnitsValue, totalRentableUnitsValue),
    overlocks,
    autoPayUnits,
    autopayOccupancy: pct(autoPayUnits, facility.rentable),
  }
}

interface ActivityInput {
  facilityId: string
  /** The rentable unit count, which the insurance and autopay rates are against. */
  rentableUnits: number
  window: { now: Date; start: Date }
}

/** The last thirty days, from Cubby's activity endpoints. */
async function activityStatistics(input: ActivityInput): Promise<FacilityStatistics> {
  const { facilityId, rentableUnits, window } = input
  const pct = (part: number, whole: number) => (whole ? round((part / whole) * 100) : 0)

  const leases = (
    await cubbyPost<{ leases?: Record<string, unknown>[] }>('leases/search', {
      where: {
        facilityId,
        updatedBefore: window.now.toISOString(),
        updatedAfter: window.start.toISOString(),
      },
    })
  ).leases ?? []

  const coverages = (
    await cubbyPost<{ coverages?: Record<string, unknown>[] }>('coverage/search', {
      where: {
        facilityId,
        activeOnOrBefore: window.now.toISOString(),
        activeOnOrAfter: window.start.toISOString(),
      },
    })
  ).coverages ?? []

  const ledger = (
    await cubbyPost<{ entries?: Record<string, unknown>[] }>('reports/general-ledger/accrual', {
      where: {
        facilityId,
        startDate: window.start.toISOString(),
        reportRelativeDuration: 'M',
      },
    })
  ).entries ?? []

  const leads = (
    await cubbyPost<{ leads?: Record<string, unknown>[] }>('leads/search', {
      where: {
        facilityId,
        updatedBefore: window.now.toISOString(),
        updatedAfter: window.start.toISOString(),
      },
    })
  ).leads ?? []

  const activePolicies = coverages.filter(
    (policy) => atOrBefore(policy.startDate, window.now) && atOrAfter(policy.endDate, window.start),
  )
  const soldPolicies = coverages.filter(
    (policy) =>
      atOrAfter(policy.startDate, window.start) &&
      atOrBefore(policy.startDate, window.now) &&
      !policy.endDate,
  )
  const canceledPolicies = coverages.filter(
    (policy) => atOrAfter(policy.endDate, window.start) && atOrBefore(policy.endDate, window.now),
  )

  const signed = (accounts: string[]) =>
    ledger
      .filter((entry) => accounts.includes(id(entry.account)))
      .reduce((sum, entry) => sum + (num(entry.debit) - num(entry.credit)), 0) / 100
  const waivedRent = signed(['WAIVED_RENT'])
  const waivedFees = signed(['WAIVED_FEES', 'WAIVED_DAMAGE'])

  return {
    moveInPrevious30Days: leases.filter((lease) =>
      between(lease.moveInDate, window.start, window.now),
    ).length,
    moveOutPrevious30Days: leases.filter((lease) =>
      between(lease.moveOutDate, window.start, window.now),
    ).length,

    concessionsLast30Days: signed(['DISCOUNTS']),
    waivedRentLast30Days: waivedRent,
    waivedFeesLast30Days: waivedFees,
    waivedAmountTotalLast30Days: waivedRent + waivedFees,

    reservationsLast30Days: leads.filter(
      (lead) => between(lead.createdAt, window.start, window.now) && lead.status === 'RESERVATION',
    ).length,
    inquiriesLast30Days: leads.filter((lead) => between(lead.createdAt, window.start, window.now))
      .length,
    convertedLast30Days: leads.filter((lead) => between(lead.convertedAt, window.start, window.now))
      .length,

    insuredOccupancy: pct(activePolicies.length, rentableUnits),
    insuranceSoldLast30Days: soldPolicies.length,
    insuranceCanceledLast30Days: canceledPolicies.length,
  }
}

async function statisticsFor(input: StatisticsInput): Promise<FacilityStatistics> {
  const units = unitStatistics({
    rentRoll: input.rentRoll,
    agedReceivables: input.agedReceivables,
    pricingGroupById: input.pricingGroupById,
  })

  return {
    ...units,
    ...(await activityStatistics({
      facilityId: input.facilityId,
      rentableUnits: units.totalRentableUnits,
      window: input.window,
    })),
  }
}
