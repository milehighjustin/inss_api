import { requireEnv } from '../env.ts'
import { readTokens, saveTokens } from './store.ts'

/**
 * The QuickBooks API, for one connected company.
 *
 * Intuit's tokens are short-lived and rotate: the access token lasts an hour and
 * the refresh token about a hundred days. Everything that reads from QuickBooks
 * goes through `session()`, which refreshes when the stored access token is
 * nearly out and shares one refresh between concurrent callers — two reports
 * opened at once must not both spend the refresh token.
 *
 * The company id comes from the stored connection, never from the caller, so a
 * request cannot be pointed at another company's books.
 */

export const QUICKBOOKS_API = 'https://quickbooks.api.intuit.com'

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer'
const REFRESH_WINDOW_MS = 5 * 60 * 1000
const DEFAULT_ACCESS_TOKEN_SECONDS = 60 * 60
const DEFAULT_REFRESH_TOKEN_SECONDS = 100 * 24 * 60 * 60
/** v1 sends this on every call; the report and query shapes depend on it. */
export const MINOR_VERSION = 4

export const EXPIRED_MESSAGE =
  'The QuickBooks connection has expired. Connect QuickBooks again to restore it.'

export type QuickBooksErrorCode = 'not_connected' | 'expired' | 'refused' | 'unavailable'

export class QuickBooksError extends Error {
  code: QuickBooksErrorCode
  /** What the API should answer with. */
  status: 401 | 409 | 502

  constructor(message: string, code: QuickBooksErrorCode) {
    super(message)
    this.name = 'QuickBooksError'
    this.code = code
    this.status = code === 'expired' ? 401 : code === 'not_connected' ? 409 : 502
  }
}

export interface IntuitTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in?: number
  x_refresh_token_expires_in?: number
}

interface IntuitTokenError {
  error?: string
  error_description?: string
}

function basicAuth(): string {
  const id = requireEnv('intuitClientId')
  const secret = requireEnv('intuitClientSecret')
  return Buffer.from(`${id}:${secret}`).toString('base64')
}

/**
 * One POST to Intuit's token endpoint.
 *
 * Intuit answers a bad or expired grant with `invalid_grant`, which for the app
 * means the connection needs re-authorising rather than that something broke.
 */
export async function requestTokens(form: URLSearchParams): Promise<IntuitTokenResponse> {
  let response: Response
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basicAuth()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: form.toString(),
    })
  } catch {
    throw new QuickBooksError('QuickBooks could not be reached. Try again in a moment.', 'unavailable')
  }

  const payload = (await response.json().catch(() => null)) as
    | (IntuitTokenResponse & IntuitTokenError)
    | null

  if (!response.ok || !payload?.access_token) {
    const reason = payload?.error ?? `HTTP ${response.status}`
    if (reason === 'invalid_grant') throw new QuickBooksError(EXPIRED_MESSAGE, 'expired')
    console.error('[quickbooks] token request refused', {
      status: response.status,
      reason,
      description: payload?.error_description,
    })
    throw new QuickBooksError(
      'Intuit refused the token request. Check the QuickBooks client id and secret.',
      'refused',
    )
  }

  return payload
}

/** Stores an issued token pair, keeping the company and the connecter. */
export async function persistTokens(
  tokens: IntuitTokenResponse,
  options: { realmId?: string; connectedBy?: string } = {},
) {
  return saveTokens({
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    accessTokenExpiresAt: new Date(
      Date.now() + (tokens.expires_in ?? DEFAULT_ACCESS_TOKEN_SECONDS) * 1000,
    ),
    ...(tokens.refresh_token && tokens.x_refresh_token_expires_in
      ? {
          refreshTokenExpiresAt: new Date(
            Date.now() +
              (tokens.x_refresh_token_expires_in ?? DEFAULT_REFRESH_TOKEN_SECONDS) * 1000,
          ),
        }
      : {}),
    ...options,
  })
}

let refreshInFlight: Promise<void> | null = null

/** Refreshes once, however many callers ask at the same time. */
function refreshOnce(): Promise<void> {
  refreshInFlight ??= (async () => {
    const stored = await readTokens()
    if (!stored) throw new QuickBooksError('QuickBooks is not connected', 'not_connected')
    if (!stored.refreshToken) throw new QuickBooksError(EXPIRED_MESSAGE, 'expired')

    const tokens = await requestTokens(
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: stored.refreshToken }),
    )
    await persistTokens(tokens)
  })().finally(() => {
    refreshInFlight = null
  })

  return refreshInFlight
}

export interface QuickBooksSession {
  accessToken: string
  realmId: string
}

/** A usable access token and the company it belongs to. */
export async function session(): Promise<QuickBooksSession> {
  const stored = await readTokens()
  if (!stored) throw new QuickBooksError('QuickBooks is not connected', 'not_connected')

  const expiresAt = stored.accessTokenExpiresAt?.getTime() ?? 0
  if (expiresAt - Date.now() > REFRESH_WINDOW_MS) {
    return { accessToken: stored.accessToken, realmId: stored.realmId }
  }

  await refreshOnce()

  const refreshed = await readTokens()
  if (!refreshed) throw new QuickBooksError('QuickBooks is not connected', 'not_connected')
  return { accessToken: refreshed.accessToken, realmId: refreshed.realmId }
}

async function get<T>(realmId: string, path: string, retry = true): Promise<T> {
  const { accessToken } = await session()

  let response: Response
  try {
    response = await fetch(`${QUICKBOOKS_API}/v3/company/${realmId}${path}`, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    })
  } catch {
    throw new QuickBooksError('QuickBooks could not be reached. Try again in a moment.', 'unavailable')
  }

  // Intuit rejected a token our expiry said was still good (clock skew, or a
  // refresh from another process): refresh once and try the call again.
  if (response.status === 401 && retry) {
    await refreshOnce()
    return get<T>(realmId, path, false)
  }

  const payload = await response.json().catch(() => null)
  if (!response.ok || payload === null) {
    console.error('[quickbooks] request failed', { path, status: response.status })
    throw new QuickBooksError('QuickBooks could not answer that request just now.', 'unavailable')
  }

  return payload as T
}

export interface QuickBooksCompany {
  name: string
  legalName: string | null
  country: string | null
}

interface CompanyInfoResponse {
  CompanyInfo?: { CompanyName?: string; LegalName?: string; Country?: string }
}

/** The company on the connected account — also the cheapest proof the tokens work. */
export async function companyInfo(): Promise<QuickBooksCompany> {
  const { realmId } = await session()
  const payload = await get<CompanyInfoResponse>(
    realmId,
    `/companyinfo/${realmId}?minorversion=${MINOR_VERSION}`,
  )
  const info = payload.CompanyInfo ?? {}

  return {
    name: info.CompanyName || info.LegalName || 'QuickBooks company',
    legalName: info.LegalName ?? null,
    country: info.Country ?? null,
  }
}

/**
 * A QuickBooks query. Rows come back under the entity's own collection name, so
 * the first array in `QueryResponse` is the answer.
 */
export async function query<T>(sql: string): Promise<T[]> {
  const { realmId } = await session()
  const payload = await get<{ QueryResponse?: Record<string, unknown> }>(
    realmId,
    `/query?query=${encodeURIComponent(sql)}&minorversion=${MINOR_VERSION}`,
  )
  const rows = Object.values(payload.QueryResponse ?? {}).find(Array.isArray)
  return (rows ?? []) as T[]
}

/**
 * A built-in report (`ProfitAndLoss`, `BudgetVsActuals`, …), as QuickBooks
 * shapes it. Parsing is the caller's job, because each report has its own rows.
 */
export async function report<T = unknown>(
  name: string,
  params: Record<string, string | number | undefined> = {},
): Promise<T> {
  const { realmId } = await session()
  const search = new URLSearchParams()

  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  search.set('minorversion', String(MINOR_VERSION))

  return get<T>(realmId, `/reports/${name}?${search.toString()}`)
}
