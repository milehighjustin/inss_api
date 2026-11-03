/**
 * ICE servers for a call.
 *
 * A peer connection needs a STUN server at the very least, and a TURN relay when
 * the two ends cannot reach each other directly — two kiosks on different
 * networks usually cannot. v1 asked Twilio for a short-lived Network Traversal
 * Service token and handed the result to the page; the same credentials are
 * fetched here with a plain HTTP call, so no Twilio SDK ships in the API.
 *
 * Without Twilio credentials (or if Twilio is having a bad day) this falls back
 * to Google's public STUN server, which is what the pages already fall back to.
 */

export interface IceServer {
  urls: string[]
  username?: string
  credential?: string
}

const STUN_FALLBACK: IceServer[] = [{ urls: ['stun:stun.l.google.com:19302'] }]
const CACHE_MS = 5 * 60 * 1000

let cached: { servers: IceServer[]; expires: number } | null = null

interface TwilioTokenResponse {
  ice_servers?: { url?: string; urls?: string[]; username?: string; credential?: string }[]
}

export async function iceServers(): Promise<IceServer[]> {
  const accountSid = process.env.twilioAccountSid
  const authToken = process.env.twilioAuthToken
  if (!accountSid || !authToken) return STUN_FALLBACK

  if (cached && cached.expires > Date.now()) return cached.servers

  try {
    const response = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Tokens.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        },
      },
    )
    if (!response.ok) throw new Error(`Twilio answered ${response.status}`)

    const body = (await response.json()) as TwilioTokenResponse
    const servers = (body.ice_servers ?? [])
      .map((server): IceServer => {
        const urls = server.urls ?? (server.url ? [server.url] : [])
        return {
          urls,
          ...(server.username ? { username: server.username } : {}),
          ...(server.credential ? { credential: server.credential } : {}),
        }
      })
      .filter((server) => server.urls.length > 0)

    if (!servers.length) return STUN_FALLBACK

    cached = { servers, expires: Date.now() + CACHE_MS }
    return servers
  } catch (cause) {
    console.warn(
      '[rtc] Twilio TURN credentials unavailable, using STUN:',
      cause instanceof Error ? cause.message : cause,
    )
    return cached?.servers ?? STUN_FALLBACK
  }
}
