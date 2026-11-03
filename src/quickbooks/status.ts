import { QuickBooksError, companyInfo } from './api.ts'
import { readTokens } from './store.ts'

/**
 * What the admin panel shows about QuickBooks.
 *
 * The status is read live: the stored tokens are used to ask Intuit for the
 * company, which proves the connection works rather than just that a document
 * exists. When that fails the reason is returned as `needsAttention` so the panel
 * can say what to do about it instead of showing a green light over a dead link.
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** Refresh tokens last 100 days; warn with enough time to reconnect. */
const RENEW_WINDOW_DAYS = 10

export interface IntegrationStatus {
  id: 'quickbooks'
  name: string
  /** A stored connection exists. `needsAttention` says whether it still works. */
  connected: boolean
  realmId: string | null
  companyName: string | null
  connectedAt: string | null
  /** The administrator who completed the connection. */
  connectedBy: string | null
  accessTokenExpiresAt: string | null
  refreshTokenExpiresAt: string | null
  /** A sentence for the panel when something needs doing, otherwise null. */
  needsAttention: string | null
  /** When this was read. */
  checkedAt: string
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null
}

export async function quickBooksStatus(): Promise<IntegrationStatus> {
  const stored = await readTokens()

  const status: IntegrationStatus = {
    id: 'quickbooks',
    name: 'QuickBooks Online',
    connected: Boolean(stored),
    realmId: stored?.realmId ?? null,
    companyName: null,
    connectedAt: iso(stored?.connectedAt ?? null),
    connectedBy: stored?.connectedBy ?? null,
    accessTokenExpiresAt: iso(stored?.accessTokenExpiresAt ?? null),
    refreshTokenExpiresAt: iso(stored?.refreshTokenExpiresAt ?? null),
    needsAttention: null,
    checkedAt: new Date().toISOString(),
  }

  if (!stored) return status

  const refreshExpires = stored.refreshTokenExpiresAt?.getTime() ?? 0
  if (refreshExpires && refreshExpires <= Date.now()) {
    return {
      ...status,
      needsAttention: 'The QuickBooks connection expired. Connect QuickBooks again to restore it.',
    }
  }

  const daysLeft = refreshExpires ? (refreshExpires - Date.now()) / DAY_MS : null
  const renewSoon =
    daysLeft !== null && daysLeft < RENEW_WINDOW_DAYS
      ? `The QuickBooks connection must be renewed in ${Math.max(1, Math.ceil(daysLeft))} day${
          Math.ceil(daysLeft) === 1 ? '' : 's'
        }. Connect QuickBooks again to renew it.`
      : null

  try {
    const company = await companyInfo()
    return { ...status, companyName: company.name, needsAttention: renewSoon }
  } catch (cause) {
    const message =
      cause instanceof QuickBooksError
        ? cause.message
        : 'QuickBooks could not be checked just now.'
    return { ...status, needsAttention: message }
  }
}
