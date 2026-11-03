import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  type ContainerClient,
  StorageSharedKeyCredential,
} from '@azure/storage-blob'

import { requireEnv } from './env.ts'

/**
 * Azure Blob Storage.
 *
 * The account key stays here: clients get a signed URL for one blob and upload
 * to Azure themselves, and this API reads the result back to check it.
 */

let credentialCache: StorageSharedKeyCredential | null = null

function credential(): StorageSharedKeyCredential {
  if (!credentialCache) {
    credentialCache = new StorageSharedKeyCredential(
      requireEnv('azureStorageAccountName'),
      requireEnv('azureStorageAccountKey'),
    )
  }
  return credentialCache
}

function host(): string {
  return `${requireEnv('azureStorageAccountName')}.blob.core.windows.net`
}

/** The public URL of a blob, without any signature. */
export function blobUrl(containerName: string, blobName: string): string {
  return `https://${host()}/${containerName}/${blobName}`
}

export interface BlobUploadSignature {
  /** Full URL the client PUTs its bytes to, including the SAS. */
  uploadUrl: string
  /** Public URL of the blob once it is uploaded. */
  blobUrl: string
  expiresOn: string
}

/**
 * A write-only SAS for exactly one blob.
 *
 * The app uploads straight to Azure, so it needs permission to write — but not
 * to read, list, overwrite anything else or delete. A container SAS would grant
 * all of that; this signs a single server-chosen blob name for a few minutes.
 */
export function blobUploadSignature(
  containerName: string,
  blobName: string,
  minutes = 10,
): BlobUploadSignature {
  const now = Date.now()
  const expiresOn = new Date(now + minutes * 60 * 1000)
  const startsOn = new Date(now - 60 * 1000)

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse('cw'),
      expiresOn,
      startsOn,
      protocol: SASProtocol.Https,
    },
    credential(),
  ).toString()

  const url = blobUrl(containerName, blobName)

  return {
    uploadUrl: `${url}?${sasToken}`,
    blobUrl: url,
    expiresOn: expiresOn.toISOString(),
  }
}

/**
 * A read-only SAS for one blob, valid for a few minutes.
 *
 * Investor documents live in containers the app must never be able to list or
 * write, so the URL carries `r` for this one blob only. The caller is
 * responsible for checking that the person asking is allowed to see it.
 */
export function blobReadSignature(
  containerName: string,
  blobName: string,
  minutes = 10,
): { url: string; expiresOn: string } {
  const now = Date.now()
  const expiresOn = new Date(now + minutes * 60 * 1000)
  const startsOn = new Date(now - 60 * 1000)

  const sasToken = generateBlobSASQueryParameters(
    {
      containerName,
      blobName,
      permissions: BlobSASPermissions.parse('r'),
      expiresOn,
      startsOn,
      protocol: SASProtocol.Https,
    },
    credential(),
  ).toString()

  return {
    url: `${blobUrl(containerName, blobName)}?${sasToken}`,
    expiresOn: expiresOn.toISOString(),
  }
}

/** A client for the container, authenticated with the account key. */
export function containerClient(containerName: string): ContainerClient {
  return new BlobServiceClient(`https://${host()}`, credential()).getContainerClient(containerName)
}
