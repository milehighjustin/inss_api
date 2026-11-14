import { PdkError, pdkGet, pdkPost } from './api.ts'
import { systemIdForLocation } from './doors.ts'

/**
 * Holders — the people PDK lets through doors.
 *
 * The read side is the list an access manager works from: who is on the system,
 * whether they are enabled, and when their access expires. Adding someone is
 * the one write: a new tenant needs a holder before their gate opens, and going
 * to pdk.io for it meant leaving the app that someone was already using at the
 * desk. Removing or editing holders still belongs in pdk.io.
 */

export interface PdkHolder {
  id: string
  firstName?: string | null
  lastName?: string | null
  email?: string | null
  enabled?: boolean
  activeDate?: string | null
  expireDate?: string | null
  groups?: { id: string; name?: string }[]
  credentials?: { id: string; types?: string[] }[]
  [key: string]: unknown
}

export interface Holder {
  id: string
  name: string
  email: string | null
  enabled: boolean
  /** ISO-ish as PDK sends it; the app formats it. */
  expireDate: string | null
  groups: string[]
  credentials: number
}

export function toHolder(holder: PdkHolder): Holder {
  const name = [holder.firstName, holder.lastName].filter(Boolean).join(' ').trim()

  return {
    id: holder.id,
    name: name || holder.email || 'Unnamed holder',
    email: holder.email ?? null,
    enabled: holder.enabled !== false,
    expireDate: holder.expireDate ?? null,
    groups: (holder.groups ?? [])
      .map((group) => group.name ?? '')
      .filter((value): value is string => Boolean(value)),
    credentials: (holder.credentials ?? []).length,
  }
}

/**
 * A page of holders on one property's system, optionally searched.
 *
 * PDK's search matches first name, last name and email by default, which is what
 * someone typing a name expects. Disabled holders are included: a holder whose
 * access was switched off is exactly who a manager is checking for.
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

export interface NewHolder {
  firstName: string
  lastName: string
  email: string | null
  phone: string | null
}

/**
 * Adds a holder to one property's system.
 *
 * PDK answers a creation with the holder it made, but not every version does
 * (some answer 201 with an id, some with nothing), so a missing body falls back
 * to asking for the person back by email rather than reporting a failure that
 * did not happen.
 */
export async function createHolder(locationId: string, input: NewHolder): Promise<Holder> {
  if (!input.firstName || !input.lastName) {
    throw new PdkError('A holder needs a first and a last name.', 'refused')
  }

  const systemId = await systemIdForLocation(locationId)
  const created = await pdkPost<PdkHolder>(systemId, '/holders', {
    firstName: input.firstName,
    lastName: input.lastName,
    ...(input.email ? { email: input.email } : {}),
    ...(input.phone ? { phone: input.phone } : {}),
    enabled: true,
  })

  const payload = created.data
  if (payload && typeof payload === 'object' && typeof payload.id === 'string' && payload.id) {
    return toHolder(payload)
  }

  if (!input.email) {
    throw new PdkError('PDK added the holder but did not return it.', 'unavailable')
  }

  const search = encodeURIComponent(input.email)
  const found = await pdkGet<PdkHolder[]>(systemId, `/holders?per_page=10&search=${search}`)
  const match = (Array.isArray(found.data) ? found.data : []).find(
    (row) => (row.email ?? '').toLowerCase() === input.email?.toLowerCase(),
  )

  if (!match) throw new PdkError('PDK added the holder but did not return it.', 'unavailable')
  return toHolder(match)
}
