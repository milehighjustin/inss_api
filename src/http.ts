import type { Context } from 'hono'

/** A JSON body, or an empty object when there is none or it is not an object. */
export async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json()
    if (body && typeof body === 'object') return body as Record<string, unknown>
    return {}
  } catch {
    return {}
  }
}

/** A trimmed string field, or an empty string for anything else. */
export function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export interface ErrorBody {
  error: string
}

/** Every failure the app shows is `{ error }` with a status it can act on. */
export type FailureStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502

export function fail(c: Context, error: string, status: FailureStatus, headers?: Record<string, string>) {
  if (headers) {
    for (const [name, value] of Object.entries(headers)) c.header(name, value)
  }

  return c.json<ErrorBody>({ error }, status)
}
