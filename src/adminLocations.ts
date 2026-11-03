import { db } from './db.ts'

/**
 * Locations, as the admin console edits them.
 *
 * One record feeds both admin areas: the KPI panel flips `kpiActive` and sets
 * the OER score, and the Investor Portal panel maintains the manual inputs that
 * the investor portal reports read (`propertyValue`, `loanBalance`, and so on),
 * the QuickBooks department link, the status and the notes.
 *
 * The documents are v1's `loglady.locations` and `loglady.ipLocationNotes`,
 * unchanged, so the website and this API edit the same rows.
 */

export const LOCATION_STATUSES = [
  'Stable',
  'Lease Up',
  'In Conversion',
  'In Development',
  'Value Add',
  'Other',
  'Inactive',
] as const

export type LocationStatus = (typeof LOCATION_STATUSES)[number]

export function isLocationStatus(value: unknown): value is LocationStatus {
  return typeof value === 'string' && (LOCATION_STATUSES as readonly string[]).includes(value)
}

/** The stored shapes. `_id` is a string in these collections, as v1 wrote it. */
interface LocationDocument {
  _id: string
  [field: string]: unknown
}

interface NoteDocument {
  _id: string
  locationId?: string
  content?: string
  createdAt?: string | Date
  createdByName?: string
}

interface DepartmentDocument {
  _id: string
  Id?: string
  Name?: string
}

export interface LocationNote {
  id: string
  content: string
  createdAt: string
  createdByName: string | null
}

export interface AdminLocation {
  id: string
  internalId: string
  name: string
  departmentName: string
  departmentId: string
  status: string
  /** The year's operational excellence review score, as v1 stores it. */
  oerScore: number | null
  /** On the KPI board and in the app's KPI section. */
  kpiActive: boolean
  propertyValue: number
  acquisitionDate: string
  valuationDate: string
  budgetOccupancy: number
  operatingCashReserves: number
  loanInterestRate: number
  loanMaturityDate: string
  issPromote: number
  projectedCapitalCalls: number
  closingCostPct: number
  notes: LocationNote[]
}

function num(value: unknown): number {
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : 0
}

function controlDate(value: unknown): string {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (value instanceof Date) return value.toISOString()
  return ''
}

function noteFromDocument(document: Record<string, unknown>): LocationNote {
  return {
    id: String(document._id),
    content: String(document.content ?? ''),
    createdAt: controlDate(document.createdAt) || new Date().toISOString(),
    createdByName: document.createdByName ? String(document.createdByName) : null,
  }
}

function locationFromDocument(document: Record<string, unknown>): AdminLocation {
  return {
    id: String(document._id),
    internalId: String(document.internalId ?? ''),
    name: String(document.name ?? ''),
    departmentName: String(document.qbDepartmentName ?? ''),
    departmentId: String(document.qbDepartmentId ?? ''),
    status: String(document.status ?? ''),
    oerScore:
      document.oerScore === undefined || document.oerScore === null || document.oerScore === ''
        ? null
        : num(document.oerScore),
    kpiActive: document.kpiActive === true,
    propertyValue: num(document.propertyValue),
    acquisitionDate: controlDate(document.acquisitionDate),
    valuationDate: controlDate(document.valuationDate),
    budgetOccupancy: num(document.budgetOccupancy),
    operatingCashReserves: num(document.operatingCashReserves),
    loanInterestRate: num(document.loanInterestRate),
    loanMaturityDate: controlDate(document.loanMaturityDate),
    issPromote: num(document.issPromote),
    projectedCapitalCalls: num(document.projectedCapitalCalls),
    closingCostPct: num(document.closingCostPct),
    notes: [],
  }
}

/** Every location, by property name — the order both admin lists show. */
export async function adminLocations(): Promise<AdminLocation[]> {
  const loglady = await db('loglady')
  const documents = await loglady.collection<LocationDocument>('locations').find({}).toArray()

  return documents
    .map((document) => locationFromDocument(document))
    .sort((left, right) =>
      (left.departmentName || left.name).localeCompare(
        right.departmentName || right.name,
        'en',
        { numeric: true },
      ),
    )
}

async function notesFor(locationId: string): Promise<LocationNote[]> {
  const loglady = await db('loglady')
  const documents = await loglady
    .collection<NoteDocument>('ipLocationNotes')
    .find({ locationId })
    .sort({ createdAt: -1 })
    .toArray()

  return documents.map((document) => noteFromDocument(document))
}

/** One location with its investor notes, newest first. */
export async function adminLocation(locationId: string): Promise<AdminLocation | null> {
  const loglady = await db('loglady')
  const document = await loglady.collection<LocationDocument>('locations').findOne({ _id: locationId })
  if (!document) return null

  return { ...locationFromDocument(document), notes: await notesFor(locationId) }
}

export class LocationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocationError'
  }
}

/** A field the admin console may change. Everything else is left alone. */
export type LocationPatch = Partial<
  Pick<
    AdminLocation,
    | 'internalId'
    | 'acquisitionDate'
    | 'valuationDate'
    | 'budgetOccupancy'
    | 'propertyValue'
    | 'operatingCashReserves'
    | 'loanInterestRate'
    | 'loanMaturityDate'
    | 'issPromote'
    | 'projectedCapitalCalls'
    | 'closingCostPct'
    | 'status'
    | 'kpiActive'
    | 'oerScore'
  >
> & {
  departmentId?: string
  departmentName?: string
}

const NUMERIC_FIELDS = [
  'budgetOccupancy',
  'propertyValue',
  'operatingCashReserves',
  'loanInterestRate',
  'issPromote',
  'projectedCapitalCalls',
  'closingCostPct',
] as const

const DATE_FIELDS = ['acquisitionDate', 'valuationDate', 'loanMaturityDate'] as const

const TEXT_FIELDS = ['internalId'] as const

/** Validates and applies a patch, returning the updated location. */
export async function updateAdminLocation(
  locationId: string,
  patch: LocationPatch,
): Promise<AdminLocation | null> {
  const loglady = await db('loglady')
  const collection = loglady.collection<LocationDocument>('locations')
  const existing = await collection.findOne({ _id: locationId })
  if (!existing) return null

  const update: Record<string, unknown> = {}

  for (const field of TEXT_FIELDS) {
    const value = patch[field]
    if (value === undefined) continue
    update[field] = String(value ?? '').trim()
  }

  for (const field of NUMERIC_FIELDS) {
    const value = patch[field]
    if (value === undefined) continue
    const amount = Number(value)
    if (!Number.isFinite(amount) || amount < 0) {
      throw new LocationError(`${field} must be a number of zero or more`)
    }
    update[field] = amount
  }

  for (const field of DATE_FIELDS) {
    const value = patch[field]
    if (value === undefined) continue
    const text = String(value ?? '').trim()
    if (text && Number.isNaN(new Date(text).getTime())) {
      throw new LocationError(`${field} must be a date`)
    }
    update[field] = text
  }

  if (patch.status !== undefined) {
    if (!isLocationStatus(patch.status)) throw new LocationError('Unknown status')
    update.status = patch.status
  }

  if (patch.kpiActive !== undefined) {
    if (typeof patch.kpiActive !== 'boolean') throw new LocationError('kpiActive must be true or false')
    update.kpiActive = patch.kpiActive
  }

  if (patch.oerScore !== undefined) {
    if (patch.oerScore === null) {
      update.oerScore = null
    } else {
      const score = Number(patch.oerScore)
      if (!Number.isFinite(score) || score < 0) throw new LocationError('OER score must be a number of zero or more')
      update.oerScore = score
    }
  }

  if (patch.departmentId !== undefined) {
    update.qbDepartmentId = String(patch.departmentId ?? '').trim()
    // The department name is what the app and the portal display, so it is
    // always written with the id: a link with only an id reads as unlinked.
    update.qbDepartmentName = String(patch.departmentName ?? '').trim()
  }

  if (Object.keys(update).length > 0) {
    await collection.updateOne({ _id: locationId }, { $set: update })
  }

  return adminLocation(locationId)
}

/** The QuickBooks departments the link picker offers. */
export async function quickBooksDepartments(): Promise<{ id: string; name: string }[]> {
  const loglady = await db('loglady')
  const documents = await loglady.collection<DepartmentDocument>('quickbooksDepartments').find({}).toArray()

  return documents
    .map((document) => ({
      id: String(document.Id ?? document._id ?? ''),
      name: String(document.Name ?? ''),
    }))
    .filter((department) => department.id && department.name)
    .sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true }))
}

/** A note shown on the investor portal's property page. */
export async function createLocationNote(
  locationId: string,
  content: string,
  createdByName: string,
): Promise<LocationNote | null> {
  const loglady = await db('loglady')
  const collection = loglady.collection<NoteDocument>('ipLocationNotes')
  const id = crypto.randomUUID()

  await collection.insertOne({
    _id: id,
    locationId,
    content,
    createdByName,
    createdAt: new Date().toISOString(),
  })

  const document = await collection.findOne({ _id: id })
  return document ? noteFromDocument(document) : null
}

/** Deletes a note, but only one that belongs to this location. */
export async function deleteLocationNote(locationId: string, noteId: string): Promise<boolean> {
  const loglady = await db('loglady')
  const result = await loglady
    .collection<NoteDocument>('ipLocationNotes')
    .deleteOne({ _id: noteId, locationId })
  return result.deletedCount === 1
}
