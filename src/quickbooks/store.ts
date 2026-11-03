import { db } from '../db.ts'
import { seal, unseal, type Sealed } from './crypto.ts'

/**
 * The QuickBooks connection, where v1 keeps it.
 *
 * One document in `global.integrations` with `integrationId: 'quickbooks'`,
 * holding the access token, refresh token and company (`realmId`) sealed
 * individually, plus their expiry dates. Same document, same field names, same
 * encryption as the website — so an existing connection carries over untouched
 * and the website could still read a connection made here.
 */

const COLLECTION = 'integrations'
const DOCUMENT = 'quickbooks'

interface IntegrationDoc {
  integrationId: string
  encryptedAccessToken?: Sealed
  encryptedRefreshToken?: Sealed
  encryptedRealmId?: Sealed
  accessTokenExpire?: Date | string
  refreshTokenExpire?: Date | string
  connectedAt?: Date | string
  connectedBy?: string
}

export interface StoredTokens {
  accessToken: string
  refreshToken: string | null
  realmId: string
  accessTokenExpiresAt: Date | null
  refreshTokenExpiresAt: Date | null
  connectedAt: Date | null
  connectedBy: string | null
}

function date(value: Date | string | undefined): Date | null {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

async function integrations() {
  const global = await db('global')
  return global.collection<IntegrationDoc>(COLLECTION)
}

/** The stored connection, or null when QuickBooks has never been connected. */
export async function readTokens(): Promise<StoredTokens | null> {
  const doc = await (await integrations()).findOne({ integrationId: DOCUMENT })
  if (!doc) return null

  const accessToken = unseal(doc.encryptedAccessToken)
  const realmId = unseal(doc.encryptedRealmId)
  if (!accessToken || !realmId) return null

  return {
    accessToken,
    refreshToken: unseal(doc.encryptedRefreshToken),
    realmId,
    accessTokenExpiresAt: date(doc.accessTokenExpire),
    refreshTokenExpiresAt: date(doc.refreshTokenExpire),
    connectedAt: date(doc.connectedAt),
    connectedBy: doc.connectedBy ?? null,
  }
}

export interface TokenUpdate {
  accessToken?: string
  refreshToken?: string
  realmId?: string
  accessTokenExpiresAt?: Date
  refreshTokenExpiresAt?: Date
  /** The administrator who completed the connection. */
  connectedBy?: string
}

/**
 * Writes whichever tokens were issued and returns the stored connection.
 *
 * Only the fields present are touched: a refresh rotates the access token, and
 * usually the refresh token too, without losing the company id.
 */
export async function saveTokens(update: TokenUpdate): Promise<StoredTokens | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() }

  if (update.accessToken) {
    set.encryptedAccessToken = seal(update.accessToken)
    set.accessTokenExpire =
      update.accessTokenExpiresAt ?? new Date(Date.now() + 60 * 60 * 1000)
  }

  if (update.refreshToken) {
    set.encryptedRefreshToken = seal(update.refreshToken)
    if (update.refreshTokenExpiresAt) set.refreshTokenExpire = update.refreshTokenExpiresAt
  }

  if (update.realmId) {
    set.encryptedRealmId = seal(update.realmId)
  }

  if (update.connectedBy) {
    set.connectedBy = update.connectedBy
    set.connectedAt = new Date()
  }

  await (await integrations()).updateOne(
    { integrationId: DOCUMENT },
    { $set: set },
    { upsert: true },
  )

  return readTokens()
}
