import { PdkError, pdkGet, pdkPost, pdkPut } from './api.ts'
import { systemIdForLocation } from './doors.ts'

/**
 * Holders — the people PDK lets through doors.
 *
 * This is the whole of a holder that the app offers: read the list, open one,
 * add one, change one. A person's access is a set of facts PDK keeps — enabled,
 * a PIN, a window of dates, a partition, group memberships — and the desk that
 * hands someone a gate code needs to change any of them without signing in to
 * pdk.io. Removing people is the one thing still left to PDK: deleting is not
 * editing, and it is not undone by pressing save again.
 *
 * Groups are their own call. PDK replaces a holder's groups with
 * `PUT /holders/{id}/groups`, not as a field on the holder, so an edit that
 * changes groups is two requests and the second one only happens when the list
 * actually changed.
 */

export interface PdkHolder {
  id: string
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  enabled?: boolean
  activeDate?: string | null
  expireDate?: string | null
  pin?: string | null
  duressPin?: string | null
  /** A partition id, not an object, on a holder. */
  partition?: string | null
  groups?: { id: string; name?: string }[]
  credentials?: { id: string; types?: string[] }[]
  [key: string]: unknown
}

export interface Holder {
  id: string
  firstName: string
  lastName: string
  name: string
  email: string | null
  enabled: boolean
  /** As PDK sends it (`YYYY-MM-DDTHH:mm:ss`); the app formats it. */
  activeDate: string | null
  expireDate: string | null
  pin: string | null
  duressPin: string | null
  partitionId: string | null
  /** Group names, for a subtitle. */
  groups: string[]
  /** Group ids, for the editor's checkboxes. */
  groupIds: string[]
  credentials: number
}

export interface PdkPartition {
  id: string
  name?: string
  default?: boolean
}

export interface PdkGroup {
  id: string
  name?: string
  partition?: string
}

export function toHolder(holder: PdkHolder): Holder {
  const firstName = holder.firstName ?? ''
  const lastName = holder.lastName ?? ''
  const name = `${firstName} ${lastName}`.trim()

  return {
    id: holder.id,
    firstName,
    lastName,
    name: name || holder.email || 'Unnamed holder',
    email: holder.email ?? null,
    enabled: holder.enabled !== false,
    activeDate: holder.activeDate ?? null,
    expireDate: holder.expireDate ?? null,
    pin: holder.pin ?? null,
    duressPin: holder.duressPin ?? null,
    partitionId: holder.partition ?? null,
    groups: (holder.groups ?? [])
      .map((group) => group.name ?? '')
      .filter((value): value is string => Boolean(value)),
    groupIds: (holder.groups ?? []).map((group) => group.id).filter(Boolean),
    credentials: (holder.credentials ?? []).length,
  }
}

/**
 * A page of holders on one property's system, optionally searched.
 *
 * PDK searches first name, last name and email by default, which is what
 * someone typing a name expects. Groups and credentials come along because the
 * list shows them and the editor needs the group ids.
 */
export async function listHolders(
  locationId: string,
  search = '',
): Promise<{ holders: Holder[]; total: number | null }> {
  const systemId = await systemIdForLocation(locationId)
  const params = new URLSearchParams({ per_page: '100', include: 'groups,credentials' })
  const clean = search.trim()
  if (clean) params.set('search', clean)

  const result = await pdkGet<PdkHolder[]>(systemId, `/holders?${params.toString()}`)
  const rows = Array.isArray(result.data) ? result.data : []

  return { holders: rows.map(toHolder), total: result.total ?? rows.length }
}

/** One holder, for the editor. */
export async function getHolder(locationId: string, holderId: string): Promise<Holder> {
  const systemId = await systemIdForLocation(locationId)
  const result = await pdkGet<PdkHolder>(
    systemId,
    `/holders/${encodeURIComponent(holderId)}?include=groups,credentials`,
  )
  return toHolder(result.data)
}

/** The partitions a holder can be filed under; one of them is the default. */
export async function listPartitions(locationId: string): Promise<PdkPartition[]> {
  const systemId = await systemIdForLocation(locationId)
  const result = await pdkGet<PdkPartition[]>(systemId, '/partitions?per_page=100')
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.filter((row) => typeof row?.id === 'string')
}

/** The groups a holder can be put in. */
export async function listGroups(locationId: string): Promise<PdkGroup[]> {
  const systemId = await systemIdForLocation(locationId)
  const result = await pdkGet<PdkGroup[]>(systemId, '/groups?per_page=100')
  const rows = Array.isArray(result.data) ? result.data : []
  return rows.filter((row) => typeof row?.id === 'string')
}

/** What a new or edited holder carries. Dates are `YYYY-MM-DDTHH:mm:ss`. */
export interface HolderInput {
  firstName: string
  lastName: string
  email: string | null
  partitionId: string | null
  enabled: boolean
  activeDate: string | null
  expireDate: string | null
  pin: string | null
  duressPin: string | null
  groupIds: string[]
}

/** PDK wants a date-time, and an empty field means "no date". */
function pdkDate(value: string | null): string | null {
  if (!value) return null
  const clean = value.trim()
  if (!clean) return null
  return /^\d{4}-\d{2}-\d{2}$/.test(clean) ? `${clean}T00:00:00` : clean
}

/** The partition to file a holder under when the caller did not choose one. */
async function resolvePartition(systemId: string, partitionId: string | null): Promise<string> {
  if (partitionId) return partitionId

  const result = await pdkGet<PdkPartition[]>(systemId, '/partitions?per_page=100')
  const rows = Array.isArray(result.data) ? result.data : []
  const fallback = rows.find((row) => row.default === true) ?? rows[0]
  if (!fallback?.id) {
    throw new PdkError('This PDK system has no partition to file a holder under.', 'unavailable')
  }
  return fallback.id
}

/**
 * Adds a holder to one property's system.
 *
 * PDK's reply to a creation is an id and nothing else, so the person is read
 * back once by that id: the screen that just added someone wants to show them in
 * the list, and a row reading "Unnamed holder" would look like the save half
 * failed. If that read fails, the holder is described from what was sent — the
 * creation itself succeeded, and saying otherwise would invite a duplicate.
 */
export async function createHolder(locationId: string, input: HolderInput): Promise<Holder> {
  if (!input.firstName || !input.lastName) {
    throw new PdkError('A holder needs a first and a last name.', 'refused')
  }

  const systemId = await systemIdForLocation(locationId)
  const partition = await resolvePartition(systemId, input.partitionId)

  const created = await pdkPost<{ id?: string }>(systemId, '/holders', {
    firstName: input.firstName,
    lastName: input.lastName,
    ...(input.email ? { email: input.email } : {}),
    partition,
    enabled: input.enabled,
    activeDate: pdkDate(input.activeDate),
    expireDate: pdkDate(input.expireDate),
    pin: input.pin || null,
    duressPin: input.duressPin || null,
    ...(input.groupIds.length > 0 ? { groups: input.groupIds } : {}),
  })

  const id =
    created.data && typeof created.data === 'object' && typeof created.data.id === 'string'
      ? created.data.id
      : null

  if (id) {
    try {
      return await getHolder(locationId, id)
    } catch (cause) {
      console.error('[pdk] could not read back the new holder', {
        id,
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  return {
    id: id ?? '',
    firstName: input.firstName,
    lastName: input.lastName,
    name: `${input.firstName} ${input.lastName}`.trim(),
    email: input.email,
    enabled: input.enabled,
    activeDate: pdkDate(input.activeDate),
    expireDate: pdkDate(input.expireDate),
    pin: input.pin,
    duressPin: input.duressPin,
    partitionId: partition,
    groups: [],
    groupIds: input.groupIds,
    credentials: 0,
  }
}

/**
 * Changes a holder.
 *
 * PDK's update replaces the record, so every field the record keeps is sent even
 * when only one changed — a missing `pin` would clear it. Groups are the
 * exception: they are replaced by their own call, made only when the set
 * changed, because a needless PUT there is a write to someone's access.
 */
export async function updateHolder(
  locationId: string,
  holderId: string,
  input: HolderInput,
): Promise<Holder> {
  if (!input.firstName || !input.lastName) {
    throw new PdkError('A holder needs a first and a last name.', 'refused')
  }

  const systemId = await systemIdForLocation(locationId)
  const partition = await resolvePartition(systemId, input.partitionId)
  const before = await getHolder(locationId, holderId)

  await pdkPut(systemId, `/holders/${encodeURIComponent(holderId)}`, {
    firstName: input.firstName,
    lastName: input.lastName,
    email: input.email || null,
    partition,
    enabled: input.enabled,
    activeDate: pdkDate(input.activeDate),
    expireDate: pdkDate(input.expireDate),
    pin: input.pin || null,
    duressPin: input.duressPin || null,
  })

  const unchanged =
    before.groupIds.length === input.groupIds.length &&
    before.groupIds.every((id) => input.groupIds.includes(id))

  if (!unchanged) {
    await pdkPut(systemId, `/holders/${encodeURIComponent(holderId)}/groups`, {
      groups: input.groupIds,
    })
  }

  return getHolder(locationId, holderId)
}
