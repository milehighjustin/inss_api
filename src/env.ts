import { existsSync } from 'node:fs'

/**
 * Environment.
 *
 * `npm run dev` reads the local .env with Node's own loader — no dotenv
 * dependency — while a deployed process gets its variables from the host, where
 * there is no file to read.
 */
export function loadEnv(path = '.env'): void {
  if (!existsSync(path)) return
  process.loadEnvFile(path)
}

/** A variable the process cannot work without. */
export function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) {
    throw new Error(`Missing ${name} in the environment. Add it to .env for local development.`)
  }
  return value
}

/**
 * The port to serve on: `PORT` when the host provides one, 3001 otherwise so a
 * local API can run alongside the website's dev server on 3000.
 *
 * A function, not a constant: `loadEnv()` has to run before this is read.
 */
export function serverPort(): number {
  return Number(process.env.PORT ?? 3001)
}

/**
 * The public origin this API is reached at, when it is not the request's own
 * origin (a proxy, or a link that must point somewhere stable). Used for the
 * magic-link URL, which has to be openable from an email.
 */
export function publicOrigin(requestUrl: string): string {
  const configured = process.env.API_URL ?? process.env.APP_URL
  if (configured) return configured.replace(/\/+$/, '')
  return new URL(requestUrl).origin
}
