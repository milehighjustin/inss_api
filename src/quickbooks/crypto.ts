import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from 'node:crypto'

import { requireEnv } from '../env.ts'

/**
 * Field encryption for the QuickBooks tokens, ported from v1 unchanged.
 *
 * The tokens already sitting in `global.integrations` were sealed by the website
 * (`inssapp/lib/data/encryption.ts`) with AES-256-CBC and a key derived from the
 * `encryptionKey` variable. Reproducing the derivation exactly — same cipher,
 * same salt, same iteration count — means this API can read the existing
 * connection instead of asking for it to be authorised again, and either side can
 * still read what the other writes.
 */

const ALGORITHM = 'aes-256-cbc'

export interface Sealed {
  iv: string
  content: string
}

let keyCache: Buffer | null = null

function key(): Buffer {
  if (!keyCache) {
    keyCache = pbkdf2Sync(requireEnv('encryptionKey'), 'salt', 100000, 32, 'sha512')
  }
  return keyCache
}

export function seal(text: string): Sealed {
  const iv = randomBytes(16)
  const cipher = createCipheriv(ALGORITHM, key(), iv)
  const content = Buffer.concat([cipher.update(text), cipher.final()])
  return { iv: iv.toString('hex'), content: content.toString('hex') }
}

/** Null when the value is missing, truncated or was sealed with another key. */
export function unseal(sealed: Sealed | undefined | null): string | null {
  if (!sealed?.iv || !sealed?.content) return null

  try {
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(sealed.iv, 'hex'))
    const text = Buffer.concat([
      decipher.update(Buffer.from(sealed.content, 'hex')),
      decipher.final(),
    ])
    return text.toString()
  } catch {
    return null
  }
}
