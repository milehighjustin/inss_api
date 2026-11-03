import jwt from 'jsonwebtoken'

import { publicOrigin, requireEnv } from '../env.ts'
import { requestTokens, type IntuitTokenResponse } from './api.ts'

/**
 * Connecting QuickBooks, in a browser.
 *
 * The app never sees the client id or secret: an administrator asks this API for
 * an authorize URL, the browser goes to Intuit, and Intuit comes back to the
 * callback below. The callback path is v1's, unchanged, so the redirect URI
 * already registered in the Intuit developer app is the same one.
 *
 * `state` is a short-lived signed token naming the administrator who started the
 * flow, not the `state=inss` literal v1 sent. It is what stops a stranger from
 * attaching their own QuickBooks company to this account.
 */

const DISCOVERY_URL = 'https://developer.api.intuit.com/.well-known/openid_configuration'
const SCOPE = 'com.intuit.quickbooks.accounting'
const STATE_PURPOSE = 'intuit-oauth'
const STATE_TTL_SECONDS = 15 * 60

/** v1's callback. Keep the path: the redirect URI in Intuit's app points here. */
export const CALLBACK_PATH = '/admin/integration/intuit/oauth'

interface Discovery {
  authorization_endpoint: string
}

let discovery: Promise<Discovery> | null = null

/** Intuit's own discovery document, so the authorize URL is never hardcoded. */
async function authorizationEndpoint(): Promise<string> {
  discovery ??= fetch(DISCOVERY_URL, { headers: { Accept: 'application/json' } })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Intuit discovery answered ${response.status}`)
      const document = (await response.json()) as Partial<Discovery>
      if (!document.authorization_endpoint) {
        throw new Error('Intuit discovery did not include an authorization endpoint')
      }
      return { authorization_endpoint: document.authorization_endpoint }
    })
    .catch((cause) => {
      // Do not cache a failure: the next attempt should try again.
      discovery = null
      throw cause
    })

  return (await discovery).authorization_endpoint
}

function stateSecret(): string {
  const secret =
    process.env.MOBILE_AUTH_SECRET ?? process.env.AUTH_SECRET ?? process.env.encryptionKey
  if (!secret) {
    throw new Error(
      'Please add AUTH_SECRET (or MOBILE_AUTH_SECRET) to the environment to sign QuickBooks connection links.',
    )
  }
  return secret
}

/** A one-use authorisation link, good for fifteen minutes. */
export function mintState(userId: string): string {
  return jwt.sign({ purpose: STATE_PURPOSE }, stateSecret(), {
    subject: userId,
    expiresIn: STATE_TTL_SECONDS,
  })
}

/** The administrator who started the flow, or null when the state is not ours. */
export function verifyState(state: string | undefined): string | null {
  if (!state) return null

  try {
    const payload = jwt.verify(state, stateSecret())
    if (typeof payload === 'object' && payload.purpose === STATE_PURPOSE && payload.sub) {
      return String(payload.sub)
    }
    return null
  } catch {
    return null
  }
}

/**
 * The redirect URI handed to Intuit.
 *
 * Defaults to the callback on this service's public origin. `INTUIT_REDIRECT_URI`
 * overrides it, for a deployment reached through a proxy or at the hostname
 * already registered with Intuit.
 */
export function redirectUri(requestUrl: string): string {
  const configured = process.env.INTUIT_REDIRECT_URI
  if (configured) return configured
  return `${publicOrigin(requestUrl)}${CALLBACK_PATH}`
}

/** Where to send the browser to start the connection. */
export async function authorizeUrl({
  requestUrl,
  state,
}: {
  requestUrl: string
  state: string
}): Promise<string> {
  const endpoint = await authorizationEndpoint()
  const params = new URLSearchParams({
    client_id: requireEnv('intuitClientId'),
    response_type: 'code',
    scope: SCOPE,
    state,
    redirect_uri: redirectUri(requestUrl),
  })

  return `${endpoint}?${params.toString()}`
}

/** Trades the code Intuit sent back for a token pair. */
export function exchangeCode(code: string, requestUrl: string): Promise<IntuitTokenResponse> {
  return requestTokens(
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(requestUrl),
    }),
  )
}

export const STATE_EXPIRES_SECONDS = STATE_TTL_SECONDS
