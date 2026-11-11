import { randomUUID } from 'node:crypto'

import { db } from './db.ts'

/**
 * Saved KPI lists.
 *
 * These are v1's lists, in v1's collection (`loglady.savedKpiLists`) and its
 * shape: `{ _id, name, list: [facilityId] }`. The website's admin panel reads the
 * same documents, so a list saved in the app is the same list everywhere.
 *
 * Lists are not owned by anyone — v1 gives every viewer the same set.
 */

export interface SavedKpiList {
  id: string
  name: string
  facilityIds: string[]
}

interface SavedListDocument {
  _id: string
  name?: string
  list?: string[]
}

async function collection() {
  return (await db('loglady')).collection<SavedListDocument>('savedKpiLists')
}

function serialize(doc: SavedListDocument): SavedKpiList {
  return {
    id: String(doc._id),
    name: doc.name || 'Untitled list',
    facilityIds: doc.list ?? [],
  }
}

export async function savedKpiLists(): Promise<SavedKpiList[]> {
  const docs = await (await collection()).find({}).sort({ name: 1 }).toArray()
  return docs.map(serialize)
}

export async function createSavedKpiList(
  name: string,
  facilityIds: string[],
): Promise<SavedKpiList> {
  const list: SavedListDocument = { _id: randomUUID(), name, list: facilityIds }
  await (await collection()).insertOne(list)
  return serialize(list)
}

/**
 * Changes a list's name, its facilities, or both.
 *
 * A partial save stays partial: the admin panel can rename a list without
 * restating its membership, and re-pick membership without retyping the name.
 * Returns null when the list is gone, which the route answers as a 404 rather
 * than inventing one.
 */
export async function updateSavedKpiList(
  listId: string,
  patch: { name?: string; facilityIds?: string[] },
): Promise<SavedKpiList | null> {
  const collection_ = await collection()
  const update: Partial<SavedListDocument> = {}

  if (patch.name !== undefined) update.name = patch.name
  if (patch.facilityIds !== undefined) update.list = patch.facilityIds

  if (Object.keys(update).length > 0) {
    const result = await collection_.updateOne({ _id: listId }, { $set: update })
    if (result.matchedCount === 0) return null
  }

  const row = await collection_.findOne({ _id: listId })
  return row ? serialize(row) : null
}

/** True when a list was actually removed. */
export async function deleteSavedKpiList(listId: string): Promise<boolean> {
  const result = await (await collection()).deleteOne({ _id: listId })
  return result.deletedCount === 1
}
