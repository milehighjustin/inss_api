import { requireEnv } from '../env.ts'

/**
 * The PDK v2 API.
 *
 * PDK's authentication is two hops, and neither hop belongs to a signed-in
 * person: an API client registered with PDK turns its id and secret into an ID
 * token (`client_credentials`), and that ID token buys a token for one system.
 * The system token is what every door, holder and command call carries.
 *
 * **Which system is a per-property link, not deployment config.** A dealer's API
 * client can reach several customers, and a PDK system is a site, so each
 * property is linked to its own system (`pdk/links.ts`). Only the client id and
 * secret — the identity of this application to PDK — stay in the environment.
 *
 * Tokens are short-lived, so they are cached per system and minted again when
 * they are nearly out: a door list should not cost two round trips per row.
 * Concurrent callers share one mint, the same way the QuickBooks client shares
 * one refresh — two administrators opening the page at once must not both spend
 * the credentials.
 */

export const PDK_ACCOUNTS = 'https://accounts.pdk.io'
export const PDK_SYSTEMS = 'https://systems.pdk.io'

/** Mint again this long before the stated expiry, to survive clock skew. */
const EXPIRY_SKEW_MS = 60 * 1000
/** PDK does not always state a lifetime; a system token is minutes, not days. */
const DEFAULT_TOKEN_MS = 20 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15 * 1000

export type PdkErrorCode = 'not_configured' | 'no_system' | 'refused' | 'unavailable' | 'not_found'

export class PdkError extends Error {
  code: PdkErrorCode
  /** What the API should answer with. */
  status: 404 | 409 | 502

  constructor(message: string, code: PdkErrorCode) {
    super(message)
    this.name = 'PdkError'
    this.code = code
    this.status = code === 'not_found' ? 404 : code === 'no_system' ? 409 : code === 'not_configured' ? 409 : 502
  }
}

interface CachedToken {
  value: string
  expiresAt: number
}

let idToken: CachedToken | null = null
let idInFlight: Promise<string> | null = null
const systemTokens = new Map<string, CachedToken>()
const systemInFlight = new Map<string, Promise<string>>()

/** The two variables a deployment needs before PDK can be used at all. */
export function pdkConfig(): { clientId: string; clientSecret: string } | null {
  const clientId = process.env.PDK_CLIENT_ID
  const clientSecret = process.env.PDK_CLIENT_SECRET
  if (!clientId || !clientSecret) return null
  return { clientId, clientSecret }
}

export function pdkConfigured(): boolean {
  return pdkConfig() !== null
}

function config() {
  const value = pdkConfig()
  if (!value) {
    throw new PdkError(
      'PDK is not configured on the server. Add PDK_CLIENT_ID and PDK_CLIENT_SECRET.',
      'not_configured',
    )
  }
  return value
}

async function call(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (cause) {
    console.error('[pdk] transport failed', {
      url,
      message: cause instanceof Error ? cause.message : String(cause),
    })
    throw new PdkError('PDK could not be reached. Try again in a moment.', 'unavailable')
  }
}

/** One value out of a token response, whatever PDK calls it. */
function tokenValue(payload: unknown, keys: string[]): string | null {
  if (typeof payload === 'string' && payload) return payload
  if (!payload || typeof payload !== 'object') return null

  for (const key of keys) {
    const value = (payload as Record<string, unknown>)[key]
    if (typeof value === 'string' && value) return value
  }
  return null
}

function tokenLifetime(payload: unknown): number {
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>
    const seconds = record.expires_in ?? record.expiresIn
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000
    }
  }
  return DEFAULT_TOKEN_MS
}

/** client_id + client_secret → ID token, cached until it is nearly out. */
async function idTokenValue(): Promise<string> {
  const cached = idToken
  if (cached && cached.expiresAt - Date.now() > EXPIRY_SKEW_MS) return cached.value

  idInFlight ??= (async () => {
    const { clientId, clientSecret } = config()
    const response = await call(`${PDK_ACCOUNTS}/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials',
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      console.error('[pdk] id token refused', { status: response.status })
      throw new PdkError(
        'PDK refused the API client credentials. Check PDK_CLIENT_ID and PDK_CLIENT_SECRET.',
        'refused',
      )
    }

    const value = tokenValue(payload, ['id_token', 'access_token', 'token'])
    if (!value) {
      console.error('[pdk] id token response had no token', { keys: Object.keys(payload ?? {}) })
      throw new PdkError('PDK answered without an ID token.', 'refused')
    }

    idToken = { value, expiresAt: Date.now() + tokenLifetime(payload) }
    return value
  })().finally(() => {
    idInFlight = null
  })

  return idInFlight
}

/** ID token + system id → system token, cached per system. */
async function systemTokenValue(systemId: string): Promise<string> {
  const cached = systemTokens.get(systemId)
  if (cached && cached.expiresAt - Date.now() > EXPIRY_SKEW_MS) return cached.value

  const inFlight = systemInFlight.get(systemId)
  if (inFlight) return inFlight

  const mint = (async () => {
    const id = await idTokenValue()
    const response = await call(`${PDK_ACCOUNTS}/api/systems/${systemId}/token`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${id}`, Accept: 'application/json' },
    })

    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      console.error('[pdk] system token refused', { status: response.status })
      throw new PdkError(
        'PDK would not issue a token for this system. Check that the API client can reach it.',
        'refused',
      )
    }

    const value = tokenValue(payload, ['system_token', 'systemToken', 'token', 'access_token'])
    if (!value) {
      console.error('[pdk] system token response had no token', {
        keys: Object.keys(payload ?? {}),
      })
      throw new PdkError('PDK answered without a system token.', 'refused')
    }

    systemTokens.set(systemId, { value, expiresAt: Date.now() + tokenLifetime(payload) })
    return value
  })().finally(() => {
    systemInFlight.delete(systemId)
  })

  systemInFlight.set(systemId, mint)
  return mint
}

export interface PdkResult<T> {
  data: T
  /** PDK's `X-Total-Count`, when it sent one: the size of the whole collection. */
  total: number | null
}

async function systemRequest<T>(
  systemId: string,
  path: string,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown } = {},
  retry = true,
): Promise<PdkResult<T>> {
  const token = await systemTokenValue(systemId)

  const response = await call(`${PDK_SYSTEMS}/${systemId}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })

  // A token our cache thought was good was refused: drop it and try once more.
  if (response.status === 401 && retry) {
    systemTokens.delete(systemId)
    return systemRequest<T>(systemId, path, init, false)
  }

  const totalHeader = response.headers.get('x-total-count')
  const total = totalHeader && Number.isFinite(Number(totalHeader)) ? Number(totalHeader) : null

  if (response.status === 404) {
    throw new PdkError('PDK could not find that record.', 'not_found')
  }

  if (response.status === 204) {
    return { data: null as T, total }
  }

  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    console.error('[pdk] request failed', { path, status: response.status })
    throw new PdkError('PDK could not answer that request just now.', 'unavailable')
  }

  return { data: payload as T, total }
}

export function pdkGet<T>(systemId: string, path: string): Promise<PdkResult<T>> {
  return systemRequest<T>(systemId, path)
}

export function pdkPost<T>(systemId: string, path: string, body?: unknown): Promise<PdkResult<T>> {
  return systemRequest<T>(systemId, path, { method: 'POST', body })
}

export interface PdkCloudNode {
  id: string
  name?: string
  serialNumber?: string
  [key: string]: unknown
}

export function pdkCloudNodes(systemId: string): Promise<PdkResult<PdkCloudNode[]>> {
  return systemRequest<PdkCloudNode[]>(systemId, '/cloud-nodes?per_page=100')
}

/** One system an administrator can choose, as PDK describes it. */
export interface PdkSystemChoice {
  systemId: string
  /** The customer's name — what an administrator recognises. */
  name: string
  organizationId: string | null
  /** Cloud nodes PDK lists against the organization, when it sends them. */
  cloudNodes: number
}

interface PdkOrganization {
  id?: string
  _id?: string
  name?: string
  systemId?: string
  children?: PdkOrganization[]
  panels?: unknown[]
  [key: string]: unknown
}

/**
 * Every system this API client can reach.
 *
 * PDK's own answer to "which systems?" is the organizations the client belongs
 * to: a dealer organization is the client's own, and each customer under it
 * carries the `systemId` that door and holder calls need. A dealer that *is* a
 * customer carries one itself, which is why both levels are collected.
 *
 * Two organizations pointing at one system are one choice, so the list is
 * de-duplicated by system id: picking a system twice would only confuse.
 */
export async function listSystems(): Promise<PdkSystemChoice[]> {
  const token = await idTokenValue()
  const response = await call(`${PDK_ACCOUNTS}/api/organizations/mine`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  })

  if (!response.ok) {
    console.error('[pdk] organizations refused', { status: response.status })
    throw new PdkError(
      'PDK would not list this client\'s organizations. Check the API client permissions.',
      'refused',
    )
  }

  const payload = (await response.json().catch(() => null)) as PdkOrganization[] | null
  const organizations = Array.isArray(payload) ? payload : []
  const choices = new Map<string, PdkSystemChoice>()

  const collect = (organization: PdkOrganization) => {
    const systemId = typeof organization.systemId === 'string' ? organization.systemId : null
    if (systemId && !choices.has(systemId)) {
      choices.set(systemId, {
        systemId,
        name: organization.name ?? 'Unnamed system',
        organizationId: organization.id ?? organization._id ?? null,
        cloudNodes: Array.isArray(organization.panels) ? organization.panels.length : 0,
      })
    }
    for (const child of organization.children ?? []) collect(child)
  }

  for (const organization of organizations) collect(organization)

  return [...choices.values()].sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * A chosen system, confirmed against PDK before it is stored.
 *
 * The confirmation is a lookup in the list the picker was filled from, not a
 * separate "get system" call: PDK v2 has no endpoint for one system, and asking
 * for one answered 404 — which the panel then reported as "PDK could not find
 * that record" while every other call for that same system worked. Checking the
 * list is also the stronger test, because it proves the client can *see* the
 * system, which is what every door and holder call will need.
 */
export async function confirmSystem(systemId: string): Promise<{
  systemId: string
  systemName: string
  organizationId: string | null
}> {
  const systems = await listSystems()
  const match = systems.find((system) => system.systemId === systemId)

  if (!match) {
    throw new PdkError(
      'PDK does not list that system for this API client. Check the client’s organizations in pdk.io, then reload this page.',
      'not_found',
    )
  }

  return {
    systemId: match.systemId,
    systemName: match.name,
    organizationId: match.organizationId,
  }
}
