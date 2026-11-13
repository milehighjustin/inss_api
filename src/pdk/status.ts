import { PdkError, pdkConfigured, pdkSystem } from './api.ts'
import { listDoors } from './doors.ts'
import { listHolders } from './holders.ts'
import { readSelectedSystem } from './store.ts'

/**
 * What the Integrations panel says about PDK.
 *
 * Two separate questions, and the panel asks both because the answers need
 * different actions:
 *
 * - **configured** — the server has the API client credentials. Only a
 *   deployment can fix that.
 * - **system selected** — an administrator has picked which system to work on.
 *   That is a choice in the app, from the list PDK returns.
 *
 * Connected is read live: the chosen system is fetched, then counted. A panel
 * that says "connected" because a document exists is a panel that lies the first
 * time a credential is rotated.
 *
 * The counts are one page deep (PDK's own maximum of 100 per request) and come
 * with the real totals, so a site larger than one page can be described honestly
 * rather than implying the page is the system.
 */

export interface PdkStatus {
  id: 'pdk'
  name: string
  /** The deployment variables are present. */
  configured: boolean
  /** A system has been chosen in the app. */
  systemSelected: boolean
  /** PDK answered for the chosen system. */
  connected: boolean
  systemId: string | null
  systemName: string | null
  organizationId: string | null
  selectedBy: string | null
  selectedAt: string | null
  doors: { shown: number; total: number | null }
  holders: { shown: number; total: number | null }
  needsAttention: string | null
  checkedAt: string
}

export async function pdkStatus(): Promise<PdkStatus> {
  const checkedAt = new Date().toISOString()
  const configured = pdkConfigured()
  const selected = await readSelectedSystem()

  const status: PdkStatus = {
    id: 'pdk',
    name: 'PDK Access Control',
    configured,
    systemSelected: selected !== null,
    connected: false,
    systemId: selected?.systemId ?? null,
    systemName: selected?.systemName ?? null,
    organizationId: selected?.organizationId ?? null,
    selectedBy: selected?.selectedBy ?? null,
    selectedAt: selected?.selectedAt ? selected.selectedAt.toISOString() : null,
    doors: { shown: 0, total: null },
    holders: { shown: 0, total: null },
    needsAttention: !configured
      ? 'PDK is not configured on the server. Add PDK_CLIENT_ID and PDK_CLIENT_SECRET, then check again.'
      : selected
        ? null
        : 'No PDK system is selected yet. Choose the system this app should work on.',
    checkedAt,
  }

  if (!configured || !selected) return status

  try {
    const system = await pdkSystem(selected.systemId)
    const doors = await listDoors()
    const holders = await listHolders()

    return {
      ...status,
      connected: true,
      systemName: system.data.name ?? selected.systemName,
      organizationId:
        typeof system.data.ouId === 'string' ? system.data.ouId : selected.organizationId,
      doors: { shown: doors.doors.length, total: doors.total ?? doors.doors.length },
      holders: { shown: holders.holders.length, total: holders.total ?? holders.holders.length },
    }
  } catch (cause) {
    const message =
      cause instanceof PdkError ? cause.message : 'PDK could not be checked just now.'
    return { ...status, needsAttention: message }
  }
}
