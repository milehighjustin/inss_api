import { randomUUID } from 'node:crypto'

import jwt from 'jsonwebtoken'

import { RtcError } from './rtc.ts'

/**
 * The console's photo tool: a frame captured from a kiosk's camera, filed in
 * the same Google Drive folder v1 used.
 *
 * v1 uploaded from a Next server action (`uploadPhotoToDrive`). The website is
 * not going to production, so the upload lives here instead — same service
 * account, same shared drive, same file name the operator typed. Google is
 * spoken to directly with a signed JWT and the multipart upload endpoint, so
 * the API does not need the whole `googleapis` client for one request.
 *
 * The credentials are v1's: `googleClientEmail` and `googlePrivateKey`, with a
 * subject to impersonate (domain-wide delegation). `GOOGLE_DRIVE_PHOTO_FOLDER`
 * points the upload somewhere else without a code change.
 */

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive'
const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'
const MAX_PHOTO_BYTES = 12 * 1024 * 1024

interface DriveCredentials {
  clientEmail: string
  privateKey: string
  subject: string
  folderId: string
}

function credentials(): DriveCredentials {
  const clientEmail = process.env.googleClientEmail ?? process.env.GOOGLE_CLIENT_EMAIL
  const privateKey = (
    process.env.googlePrivateKey ??
    process.env.GOOGLE_PRIVATE_KEY ??
    ''
  ).replace(/\\n/g, '\n')

  if (!clientEmail || !privateKey) {
    throw new Error('Photo uploads need googleClientEmail and googlePrivateKey in the environment')
  }

  return {
    clientEmail,
    privateKey,
    // v1 uploaded as this account; the folder is the shared drive's Photos root.
    subject: process.env.GOOGLE_DRIVE_SUBJECT ?? 'charles@inselfstorage.com',
    folderId: process.env.GOOGLE_DRIVE_PHOTO_FOLDER ?? '0AHgBg3TAzdBRUk9PVA',
  }
}

/** A short-lived access token for the service account, impersonating `subject`. */
async function accessToken(credentials: DriveCredentials): Promise<string> {
  const assertion = jwt.sign({ scope: DRIVE_SCOPE, sub: credentials.subject }, credentials.privateKey, {
    algorithm: 'RS256',
    expiresIn: 3600,
    issuer: credentials.clientEmail,
    audience: TOKEN_URL,
  })

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  })

  const payload = (await response.json().catch(() => null)) as {
    access_token?: unknown
  } | null

  if (!response.ok || typeof payload?.access_token !== 'string') {
    throw new Error('Google refused the photo upload credentials')
  }

  return payload.access_token
}

/** The PNG bytes of a `data:image/png;base64,…` string. */
export function decodePng(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl.trim())
  if (!match) throw new RtcError('Send the photo as a PNG data URL')

  const bytes = Buffer.from(match[1], 'base64')
  if (bytes.length === 0) throw new RtcError('The photo was empty')
  if (bytes.length > MAX_PHOTO_BYTES) throw new RtcError('The photo is too large', 413)
  return bytes
}

/** v1's naming, made safe for a file system that is not ours. */
export function photoFileName(raw: string): string {
  const cleaned = raw
    .replace(/[^\w\-. ]+/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 120)

  return cleaned || `inssfile_${Date.now()}`
}

async function upload(
  token: string,
  folderId: string,
  name: string,
  bytes: Buffer,
): Promise<{ id: string; name: string }> {
  const boundary = `inssphoto${randomUUID().replace(/-/g, '')}`
  const metadata = JSON.stringify({
    name: `${name}.png`,
    mimeType: 'image/png',
    parents: [folderId],
  })

  // multipart/related: metadata part, then the image bytes.
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: image/png\r\n\r\n`,
      'utf8',
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ])

  const response = await fetch(
    `${UPLOAD_URL}?uploadType=multipart&supportsAllDrives=true&fields=id,name`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: new Uint8Array(body),
    },
  )

  const payload = (await response.json().catch(() => null)) as {
    id?: unknown
    name?: unknown
    error?: { message?: unknown }
  } | null

  if (!response.ok || typeof payload?.id !== 'string') {
    const reason =
      typeof payload?.error?.message === 'string' ? payload.error.message : response.statusText
    throw new Error(`Google Drive did not accept the photo${reason ? ` (${reason})` : ''}`)
  }

  return { id: payload.id, name: typeof payload.name === 'string' ? payload.name : `${name}.png` }
}

/**
 * Files one captured photo. The caller has already checked the operator; this
 * only validates the bytes and the name.
 */
export async function uploadPhotoToDrive(input: {
  dataUrl: string
  fileName: string
}): Promise<{ id: string; name: string }> {
  const bytes = decodePng(input.dataUrl)
  const name = photoFileName(input.fileName)
  const settings = credentials()
  const token = await accessToken(settings)

  return upload(token, settings.folderId, name, bytes)
}
