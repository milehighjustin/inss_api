import { db } from '../db.ts'

/**
 * Which PDK system each property belongs to.
 *
 * A dealer's API client can reach several customer systems, and PDK systems are
 * per site: two storage facilities are two systems. So the association is per
 * property, not one choice for the whole app — a properties page links each of
 * its sites to the system that controls its gates, and the Access Management
 * screens read that link to know which system a door belongs to.
 *
 * One document per property, keyed by the property id, in the same `global`
 * database the integrations live in. No credentials are stored: the client id
 * and secret stay in the environment, and a system id is an identifier, not a
 * secret.
 */

const COLLECTION = 'pdkLocationSystems'

interface LinkDocument {
  _id: string
  locationId?: string
  systemId?: string
  systemName?: string | null
  organizationId?: string | null
  linkedBy?: string
  linkedAt?: Date | string
}

export interface LocationSystem {
  locationId: string
  systemId: string
  systemName: string | null
  organizationId: string | null
  /** The administrator who made the link. */
  linkedBy: string | null
  linkedAt: string | null
}

function toLink(document: LinkDocument): LocationSystem | null {
  if (!document.systemId) return null

  const at = document.linkedAt ? new Date(document.linkedAt) : null
  return {
    locationId: document.locationId ?? document._id,
    systemId: document.systemId,
    systemName: document.systemName ?? null,
    organizationId: document.organizationId ?? null,
    linkedBy: document.linkedBy ?? null,
    linkedAt: at && !Number.isNaN(at.getTime()) ? at.toISOString() : null,
  }
}

async function links() {
  const global = await db('global')
  return global.collection<LinkDocument>(COLLECTION)
}

/** Every property that has a system, by property id. */
export async function listLocationSystems(): Promise<LocationSystem[]> {
  const documents = await (await links()).find({}).toArray()

  return documents
    .map(toLink)
    .filter((link): link is LocationSystem => link !== null)
    .sort((left, right) => left.locationId.localeCompare(right.locationId))
}

/** The system for one property, or null when it has none. */
export async function readLocationSystem(locationId: string): Promise<LocationSystem | null> {
  const document = await (await links()).findOne({ _id: locationId })
  return document ? toLink(document) : null
}

/** Records the link. A property has one system, so a second link replaces it. */
export async function saveLocationSystem(choice: {
  locationId: string
  systemId: string
  systemName: string | null
  organizationId: string | null
  linkedBy: string
}): Promise<LocationSystem> {
  await (await links()).updateOne(
    { _id: choice.locationId },
    {
      $set: {
        _id: choice.locationId,
        locationId: choice.locationId,
        systemId: choice.systemId,
        systemName: choice.systemName,
        organizationId: choice.organizationId,
        linkedBy: choice.linkedBy,
        linkedAt: new Date(),
        updatedAt: new Date(),
      },
    },
    { upsert: true },
  )

  const saved = await readLocationSystem(choice.locationId)
  if (!saved) throw new Error('The property link could not be saved')
  return saved
}

/** Unlinks a property. The PDK system itself is untouched. */
export async function clearLocationSystem(locationId: string): Promise<void> {
  await (await links()).deleteOne({ _id: locationId })
}
