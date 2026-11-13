import { db } from '../db.ts'

/**
 * Which PDK system this app is connected to.
 *
 * A dealer's API client can reach several customers, so the system is a choice
 * an administrator makes in the app, not a deployment variable. It is stored in
 * the same `global.integrations` collection the QuickBooks connection uses, one
 * document with `integrationId: 'pdk'` — no encryption, because a system id is an
 * identifier, not a credential: the client secret never leaves the environment.
 */

const COLLECTION = 'integrations'
const DOCUMENT = 'pdk'

interface PdkDoc {
  integrationId: string
  systemId?: string | null
  systemName?: string | null
  organizationId?: string | null
  selectedBy?: string
  selectedAt?: Date | string
}

export interface SelectedSystem {
  systemId: string
  systemName: string | null
  organizationId: string | null
  selectedBy: string | null
  selectedAt: Date | null
}

function date(value: Date | string | undefined): Date | null {
  if (!value) return null
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

async function integrations() {
  const global = await db('global')
  return global.collection<PdkDoc>(COLLECTION)
}

/** The chosen system, or null when none has been picked yet. */
export async function readSelectedSystem(): Promise<SelectedSystem | null> {
  const doc = await (await integrations()).findOne({ integrationId: DOCUMENT })
  if (!doc?.systemId) return null

  return {
    systemId: doc.systemId,
    systemName: doc.systemName ?? null,
    organizationId: doc.organizationId ?? null,
    selectedBy: doc.selectedBy ?? null,
    selectedAt: date(doc.selectedAt),
  }
}

/** Records the choice. `selectedBy` is the administrator who made it. */
export async function saveSelectedSystem(choice: {
  systemId: string
  systemName: string
  organizationId: string | null
  selectedBy: string
}): Promise<SelectedSystem | null> {
  await (await integrations()).updateOne(
    { integrationId: DOCUMENT },
    {
      $set: {
        integrationId: DOCUMENT,
        systemId: choice.systemId,
        systemName: choice.systemName,
        organizationId: choice.organizationId,
        selectedBy: choice.selectedBy,
        selectedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  )

  return readSelectedSystem()
}

/** Forgets the choice — the connection itself is untouched. */
export async function clearSelectedSystem(): Promise<void> {
  await (await integrations()).updateOne(
    { integrationId: DOCUMENT },
    { $set: { systemId: null, systemName: null, updatedAt: new Date() } },
  )
}
