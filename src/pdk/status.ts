import { PdkError, pdkConfigured, pdkSystem } from './api.ts'
import { listLocationSystems } from './links.ts'

/**
 * What the Integrations panel says about PDK.
 *
 * Two separate questions, because they need different answers:
 *
 * - **configured** — the server has the API client credentials. Only a
 *   deployment can fix that.
 * - **linked** — how many properties have been pointed at a PDK system. That is
 *   a choice in the app, made per property.
 *
 * `reachable` is read live: each distinct system is fetched once, so a green
 * light means PDK actually answered for it. A panel that says "connected"
 * because a document exists is a panel that lies the first time a credential is
 * rotated.
 */

export interface PdkStatus {
  id: 'pdk'
  name: string
  /** The deployment variables are present. */
  configured: boolean
  /** Properties with a PDK system linked. */
  linked: number
  /** Of those, the properties whose system PDK answered for. */
  reachable: number
  needsAttention: string | null
  checkedAt: string
}

export async function pdkStatus(): Promise<PdkStatus> {
  const checkedAt = new Date().toISOString()
  const configured = pdkConfigured()
  const links = await listLocationSystems()

  const status: PdkStatus = {
    id: 'pdk',
    name: 'PDK Access Control',
    configured,
    linked: links.length,
    reachable: 0,
    needsAttention: null,
    checkedAt,
  }

  if (!configured) {
    return {
      ...status,
      needsAttention:
        'PDK is not configured on the server. Add PDK_CLIENT_ID and PDK_CLIENT_SECRET, then check again.',
    }
  }

  if (links.length === 0) {
    return {
      ...status,
      needsAttention: 'No property has a PDK system linked yet. Link one on this page.',
    }
  }

  // One check per system, however many properties share it.
  const systemIds = [...new Set(links.map((link) => link.systemId))]
  const answers = await Promise.all(
    systemIds.map(async (systemId) => {
      try {
        await pdkSystem(systemId)
        return { systemId, ok: true as const, message: null }
      } catch (cause) {
        return {
          systemId,
          ok: false as const,
          message:
            cause instanceof PdkError ? cause.message : 'PDK could not be reached just now.',
        }
      }
    }),
  )

  const reachable = links.filter((link) => answers.some((a) => a.systemId === link.systemId && a.ok)).length
  const failure = answers.find((answer) => !answer.ok)

  return {
    ...status,
    reachable,
    needsAttention: reachable === 0 ? (failure?.message ?? 'PDK did not answer.') : null,
  }
}
