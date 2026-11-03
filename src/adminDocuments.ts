import { randomUUID } from 'node:crypto'

import { blobReadSignature, blobUploadSignature, blobUrl, containerClient } from './azure.ts'
import { db } from './db.ts'

/**
 * The documents behind the investor portal's Files tab.
 *
 * Uploading is the same two-step dance as the user photos: this API signs one
 * write-only blob, the app PUTs the bytes to Azure with it, then the API checks
 * what landed before writing the document. Nothing in the portal changes until
 * the bytes are actually there.
 *
 * The container and folder are v1's (`8l2r6y7n`,
 * `externalApplications/logLady/`), so a file uploaded from either app shows up
 * in the same place for the same investor.
 */

const CONTAINER = '8l2r6y7n'
const FOLDER = 'externalApplications/logLady/'
/** v1's file picker: pictures, PDFs, Office documents and CSV exports. */
const ALLOWED_TYPES: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
}
const MAX_BYTES = 50 * 1024 * 1024

/** The three collections this module touches, with v1's string ids. */
interface FileDocument {
  _id: string
  [field: string]: unknown
}

interface UserDocument {
  _id: string
  roles?: string[]
  active?: boolean
}

interface LocatedDocument {
  _id: string
  qbDepartmentName?: string
  name?: string
}

export const DOCUMENT_AUDIENCES = ['allInvestors', 'investor', 'locationSpecific'] as const

export type DocumentAudience = (typeof DOCUMENT_AUDIENCES)[number]

export function isDocumentAudience(value: unknown): value is DocumentAudience {
  return typeof value === 'string' && (DOCUMENT_AUDIENCES as readonly string[]).includes(value)
}

export interface AdminDocument {
  id: string
  name: string
  folder: string
  audience: DocumentAudience
  investorId: string | null
  locationId: string | null
  container: string
  blobName: string
  size: number | null
  createdAt: string | null
}

function documentFromRow(row: Record<string, unknown>): AdminDocument {
  const audience = isDocumentAudience(row.audience) ? row.audience : 'allInvestors'
  return {
    id: String(row._id),
    name: String(row.name ?? row.fileName ?? ''),
    folder: String(row.folderName ?? 'Files'),
    audience,
    investorId: row.investorId ? String(row.investorId) : null,
    locationId: row.locationId ? String(row.locationId) : null,
    container: String(row.container ?? CONTAINER),
    blobName: String(row.blobName ?? ''),
    size: Number.isFinite(Number(row.size)) ? Number(row.size) : null,
    createdAt: row.createdAt ? new Date(row.createdAt as string).toISOString() : null,
  }
}

/** Every document, newest first, as the admin list shows them. */
export async function adminDocuments(): Promise<AdminDocument[]> {
  const loglady = await db('loglady')
  const rows = await loglady.collection<FileDocument>('files').find({}).toArray()

  return rows
    .map((row) => documentFromRow(row))
    .sort((left, right) => (right.createdAt ?? '').localeCompare(left.createdAt ?? ''))
}

export class DocumentError extends Error {
  status: 400 | 404 | 409 | 413

  constructor(message: string, status: 400 | 404 | 409 | 413 = 400) {
    super(message)
    this.name = 'DocumentError'
    this.status = status
  }
}

/** A write-only signature for one server-named blob in the documents folder. */
export function documentUploadSignature(contentType: string, fileName?: string) {
  const lowered = contentType.toLowerCase()
  const extension =
    ALLOWED_TYPES[lowered] ??
    // Browsers report unknown office files as octet-stream; fall back to the
    // name the picker had, which is still checked against the same list.
    (lowered === 'application/octet-stream' ? extensionForName(fileName) : null)

  if (!extension) throw new DocumentError('Upload a PDF, image, Office document or CSV file')

  const blobName = `${FOLDER}${randomUUID()}.${extension}`
  const signature = blobUploadSignature(CONTAINER, blobName)

  return {
    blobName,
    blobUrl: signature.blobUrl,
    uploadUrl: signature.uploadUrl,
    expiresOn: signature.expiresOn,
    headers: {
      'x-ms-blob-type': 'BlockBlob',
      'Content-Type': ALLOWED_TYPES[lowered] ? contentType : `application/${extension}`,
    },
  }
}

function extensionForName(fileName: string | undefined): string | null {
  const extension = (fileName ?? '').split('.').pop()?.toLowerCase()
  if (!extension) return null
  return Object.values(ALLOWED_TYPES).includes(extension) ? extension : null
}

export interface CreateDocumentInput {
  blobName: string
  name: string
  audience: DocumentAudience
  investorId?: string
  locationId?: string
  folderName?: string
}

/**
 * Records the document for a blob that is already in storage.
 *
 * The blob is read back first: its size proves the upload finished, and the
 * document is only written when it did.
 */
export async function createAdminDocument(input: CreateDocumentInput): Promise<AdminDocument> {
  if (!input.blobName.startsWith(FOLDER) || input.blobName.includes('..') || !/^[\w/.-]+$/.test(input.blobName)) {
    throw new DocumentError('Unknown upload')
  }

  const loglady = await db('loglady')

  let folder = 'Files'
  let storedFolder = input.folderName?.trim() ?? ''

  if (input.audience === 'investor') {
    const investorId = input.investorId?.trim()
    if (!investorId) throw new DocumentError('Choose the investor this file is for')
    const user = await (await db('global'))
      .collection<UserDocument>('users')
      .findOne({ _id: investorId, roles: 'investor' })
    if (!user) throw new DocumentError('That investor does not exist', 404)
    folder = storedFolder || 'Files'
  } else if (input.audience === 'locationSpecific') {
    const locationId = input.locationId?.trim()
    if (!locationId) throw new DocumentError('Choose the property this file is for')
    const location = await loglady.collection<LocatedDocument>('locations').findOne({ _id: locationId })
    if (!location) throw new DocumentError('That property does not exist', 404)
    // A location's folder is the property name, so its files read like the rest.
    folder = String(location.qbDepartmentName ?? location.name ?? 'Property')
    storedFolder = folder
  } else {
    folder = 'All Investors'
    storedFolder = folder
  }

  const blob = containerClient(CONTAINER).getBlockBlobClient(input.blobName)
  let size = 0
  try {
    const properties = await blob.getProperties()
    size = properties.contentLength ?? 0
  } catch {
    throw new DocumentError('The file had not finished uploading. Try again.', 409)
  }

  if (size <= 0) throw new DocumentError('The file was empty. Try again.', 409)
  if (size > MAX_BYTES) {
    await blob.deleteIfExists().catch(() => undefined)
    throw new DocumentError('Files must be 50 MB or smaller', 413)
  }

  const id = randomUUID()
  const now = new Date()

  await loglady.collection<FileDocument>('files').insertOne({
    _id: id,
    name: input.name,
    fileName: input.name,
    audience: input.audience,
    folderName: storedFolder,
    ...(input.audience === 'investor' ? { investorId: input.investorId } : {}),
    ...(input.audience === 'locationSpecific' ? { locationId: input.locationId } : {}),
    blobName: input.blobName,
    container: CONTAINER,
    url: blobUrl(CONTAINER, input.blobName),
    size,
    createdAt: now,
    updatedAt: now,
  })

  const row = await loglady.collection<FileDocument>('files').findOne({ _id: id })
  if (!row) throw new DocumentError('The file could not be saved')
  return documentFromRow(row)
}

/**
 * The accounts that will see a document, from the audience it is filed under.
 *
 * This is `investorFiles` run from the other side — the same three rules that
 * decide who may read a file decide who is told about it: every active investor,
 * one investor, or the investors whose portfolio holds the property. The upload
 * form shows the count before saving, and a post's notification goes to exactly
 * these people.
 *
 * An inactive account is left out, because it cannot sign in to read the file.
 */
export async function documentAudienceUserIds(input: {
  audience: DocumentAudience
  investorId?: string | null
  locationId?: string | null
}): Promise<string[]> {
  const global = await db('global')
  const users = global.collection<UserDocument>('users')

  if (input.audience === 'investor') {
    const investorId = (input.investorId ?? '').trim()
    if (!investorId) return []

    const user = await users.findOne({ _id: investorId, roles: 'investor', active: { $ne: false } })
    return user ? [investorId] : []
  }

  if (input.audience === 'allInvestors') {
    const rows = await users
      .find(
        { roles: 'investor', active: { $ne: false } },
        { projection: { _id: 1 } },
      )
      .toArray()

    return rows.map((row) => String(row._id))
  }

  const locationId = (input.locationId ?? '').trim()
  if (!locationId) return []

  const loglady = await db('loglady')

  // The equity accounts on that property, then the investors holding them: the
  // two joins `investorFiles` makes from the investor downwards.
  const holdings = await loglady
    .collection<{ account?: string }>('entitiesInvested')
    .find({ locationId }, { projection: { account: 1 } })
    .toArray()

  const accounts = [...new Set(holdings.map((row) => String(row.account ?? '')).filter(Boolean))]
  if (accounts.length === 0) return []

  const investors = await loglady
    .collection<{ userId?: string }>('investors')
    .find({ investments: { $in: accounts } }, { projection: { userId: 1 } })
    .toArray()

  const investorIds = investors
    .map((row) => String(row.userId ?? ''))
    .filter(Boolean)
    .slice(0, 2000)

  if (investorIds.length === 0) return []

  const matched = await users
    .find(
      { _id: { $in: investorIds }, roles: 'investor', active: { $ne: false } },
      { projection: { _id: 1 } },
    )
    .toArray()

  return matched.map((row) => String(row._id))
}

/** A short-lived read URL for one document. */
export async function documentUrl(documentId: string): Promise<{ url: string; expiresOn: string } | null> {
  const documents = await adminDocuments()
  const document = documents.find((entry) => entry.id === documentId)
  if (!document) return null
  return blobReadSignature(document.container, document.blobName)
}

/** Removes the document and the bytes it pointed at. */
export async function deleteAdminDocument(documentId: string): Promise<boolean> {
  const loglady = await db('loglady')
  const row = await loglady.collection<FileDocument>('files').findOne({ _id: documentId })
  if (!row) return false

  await loglady.collection<FileDocument>('files').deleteOne({ _id: documentId })

  const blobName = String(row.blobName ?? '')
  const container = String(row.container ?? CONTAINER)
  if (blobName) {
    await containerClient(container)
      .getBlockBlobClient(blobName)
      .deleteIfExists()
      .catch(() => undefined)
  }

  return true
}
