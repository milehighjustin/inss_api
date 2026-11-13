import { pdkGet } from './api.ts'
import { selectedSystemId } from './doors.ts'

/**
 * Holders — the people PDK lets through doors.
 *
 * The app never writes holders from this panel: a person's access is granted in
 * pdk.io by whoever manages the site, and duplicating that here would mean two
 * places to remove someone from. What the panel needs is the read side — who is
 * on the system, whether they are enabled, and when their access expires.
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
 * A page of holders on the chosen system, optionally searched.
 *
 * PDK's search matches first name, last name and email by default, which is what
 * an administrator typing a name expects. Disabled holders are included: someone
 * whose access was switched off is exactly who a supervisor is checking for.
 */
export async function listHolders(
  search = '',
): Promise<{ holders: Holder[]; total: number | null }> {
  const systemId = await selectedSystemId()
  const params = new URLSearchParams({ per_page: '100', include: 'groups,credentials' })
  const clean = search.trim()
  if (clean) params.set('search', clean)

  const result = await pdkGet<PdkHolder[]>(systemId, `/holders?${params.toString()}`)
  const rows = Array.isArray(result.data) ? result.data : []

  return { holders: rows.map(toHolder), total: result.total ?? rows.length }
}
