import {
  NotificationHubsClient,
  createAppleInstallation,
  createAppleNotification,
  createFcmV1Installation,
  createFcmV1Notification,
  createTagExpression,
  createWindowsInstallation,
  createWindowsToastNotification,
} from '@azure/notification-hubs'

import { type PushPriority } from './payload.ts'

/**
 * Push to the native apps, through Azure Notification Hubs.
 *
 * The hub holds the APNs and FCM v1 credentials, so this service never touches
 * a certificate or a service-account key: it registers an installation per app
 * install (the device token plus the tags to route by) and sends by tag
 * expression.
 *
 * Browsers are **not** here. They are pushed directly by `browser.ts`, because
 * their endpoint is already the delivery address — no device token, no hub
 * credentials, and no installation to keep in sync with a person's tags. That
 * split is the rule: the hub is for clients this service cannot reach on its
 * own, which means the native apps — iOS and macOS (APNs) and Windows (WNS).
 *
 * Two facts shape this file:
 *
 * 1. A send is **one platform per request**. Apple and FCM v1 are different
 *    messages, so an alert is one send each against the same expression. A
 *    platform that refuses cannot fail the other.
 * 2. Routing is by the **tags stored on the installation**, not by a query at
 *    send time. A user's tags only take effect once their installations have
 *    been rewritten — which is why `installationTags` exists and why a tag change
 *    re-registers every device that user has.
 *
 * Without the two environment variables nothing here runs and every caller gets
 * `skipped: 'not-configured'` instead of an exception: a scan still redirects,
 * and the notification row says why nobody was told.
 */

export interface HubMessage {
  title: string
  body: string
  priority: PushPriority
  /** Grouping key in the tray; a second alert replaces the first. */
  tag?: string
  /** Browser only: where a click on the notification goes. */
  url?: string
  data?: Record<string, string>
}

/**
 * Where the native app runs. Everything here is delivered by the hub, and each
 * one is a different platform as far as Azure is concerned.
 */
export type HubPlatform = 'ios' | 'android' | 'macos' | 'windows'

/** A native install: one opaque token — APNs, FCM or a WNS channel — and its tags. */
export interface HubInstallation {
  installationId: string
  userId: string
  tags: string[]
  platform: HubPlatform
  pushChannel: string
}

let client: NotificationHubsClient | null = null
let tried = false

function connection(): { connectionString: string; hubName: string } | null {
  const connectionString = process.env.AZURE_NOTIFICATION_HUB_CONNECTION_STRING?.trim() ?? ''
  const hubName = process.env.AZURE_NOTIFICATION_HUB_NAME?.trim() ?? ''
  if (!connectionString || !hubName) return null

  return { connectionString, hubName }
}

function hub(): NotificationHubsClient | null {
  if (client) return client
  if (tried) return null

  const settings = connection()
  if (!settings) {
    tried = true
    return null
  }

  try {
    client = new NotificationHubsClient(settings.connectionString, settings.hubName)
    return client
  } catch (cause) {
    console.error('[push] Notification Hubs client could not be built:', cause)
    tried = true
    return null
  }
}

/** Whether push can be attempted at all in this process. */
export function hubConfigured(): boolean {
  return connection() !== null
}

/**
 * Writes one installation to the hub, overwriting whatever was there.
 *
 * An installation is identified by an id the device generates once, so this is
 * idempotent: a reinstall keeps its id, a token rotation replaces the channel,
 * and a tag change replaces the tags.
 */
export async function registerInstallation(input: HubInstallation): Promise<void> {
  const notifications = hub()
  if (!notifications) throw new Error('Notifications are not configured on this server.')

  const installation = {
    installationId: input.installationId,
    userId: input.userId,
    tags: input.tags,
    pushChannel: input.pushChannel,
  }

  // macOS is an APNs token like an iPhone's, and Windows is a WNS channel URI.
  // Which one is used is decided by the platform the app reported, never by the
  // shape of the token: guessing from a token is how a WNS channel ends up being
  // registered as if it were an Apple device.
  await notifications.createOrUpdateInstallation(
    input.platform === 'android'
      ? createFcmV1Installation(installation)
      : input.platform === 'windows'
        ? createWindowsInstallation(installation)
        : createAppleInstallation(installation),
  )
}

export async function deleteInstallation(installationId: string): Promise<void> {
  const notifications = hub()
  if (!notifications) return

  try {
    await notifications.deleteInstallation(installationId)
  } catch (cause) {
    // A 404 is the state we wanted; anything else is worth knowing about but not
    // worth failing a sign-out over.
    const status = (cause as { statusCode?: number }).statusCode
    if (status !== 404) console.error('[push] installation delete failed:', cause)
  }
}

/** Loud is a sound and a screen that stays lit; quiet is neither. */
function appleBody(message: HubMessage) {
  const loud = message.priority === 'loud'

  // `time-sensitive` can break through Focus; `passive` never lights the screen.
  // Neither defeats the mute switch — that is Apple's Critical Alerts, which is
  // a separate approval.
  const interruption: 'time-sensitive' | 'passive' = loud ? 'time-sensitive' : 'passive'
  const sound: 'default' | undefined = loud ? 'default' : undefined

  return {
    aps: {
      alert: { title: message.title, body: message.body },
      sound,
      'interruption-level': interruption,
      'thread-id': message.tag ?? 'inss',
    },
    ...(message.data ?? {}),
  }
}

function fcmBody(message: HubMessage): string {
  const loud = message.priority === 'loud'
  const priority: 'high' | 'normal' = loud ? 'high' : 'normal'

  // The `message` envelope is FCM v1's, not Notification Hubs': the SDK's body
  // type names the inner message and would hand the push service a payload it
  // rejects, so the envelope is written out and passed as a string.
  return JSON.stringify({
    message: {
      notification: { title: message.title, body: message.body },
      android: {
        priority,
        notification: {
          // The channels are created by the app before it ever asks for
          // permission: Android 13 will not show the prompt without one, and a
          // channel's importance cannot be changed afterwards.
          channel_id: loud ? 'alerts-loud' : 'alerts-quiet',
          sound: loud ? 'default' : undefined,
        },
      },
      data: { ...(message.data ?? {}), priority: message.priority },
    },
  })
}

/** The scheme a Windows toast opens the app with — Expo Router's, set in app.json. */
const APP_SCHEME = 'inssappv2'

/** XML has five characters that mean something else; a title may contain all five. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * What Windows shows, as the toast XML WNS wants.
 *
 * This is the one payload written by hand rather than as JSON: WNS is sent
 * `application/xml`, and the decisions the other platforms make with fields are
 * attributes here. Loud is `scenario="urgent"` — it breaks through Focus Assist
 * and plays the notification sound; quiet is silent and waits in the Action
 * Center. Both open the app on the same path a browser alert would, through the
 * app's own scheme, so a click lands on the code that was scanned rather than on
 * the home screen.
 */
export function windowsBody(message: HubMessage): string {
  const loud = message.priority === 'loud'
  const launch = escapeXml(`${APP_SCHEME}://${message.url ?? '/'}`)
  const attributes = [
    'activationType="foreground"',
    `launch="${launch}"`,
    ...(loud ? ['scenario="urgent"'] : []),
  ]
  const audio = loud
    ? '<audio src="ms-winsoundevent:Notification.Default"/>'
    : '<audio silent="true"/>'

  return [
    `<toast ${attributes.join(' ')}>`,
    '<visual><binding template="ToastGeneric">',
    `<text>${escapeXml(message.title)}</text>`,
    `<text>${escapeXml(message.body)}</text>`,
    '</binding></visual>',
    audio,
    '</toast>',
  ].join('')
}

export interface HubLeg {
  channel: 'apns' | 'fcmv1' | 'wns'
  ok: boolean
  error?: string
}

export interface HubResult {
  /** Platform sends the hub accepted. */
  sent: number
  legs: HubLeg[]
  errors: string[]
  /** Set when the hub is not configured: nothing was attempted. */
  skipped: 'not-configured' | null
}

/**
 * The expression a send is addressed by: the tags that reach people, minus the
 * ones who should not be interrupted.
 *
 * The hub does the fan-out, so a person on a call cannot be filtered out after
 * the fact — they have to be excluded in the expression, which is why `!` and
 * `&&` appear here. The service caps an expression at twenty tags, so exclusions
 * ride along only when they fit; a held operator with a very long tag list may
 * still see a banner, and their call is rung when it ends either way. Browsers
 * need none of this: `browser.ts` sends to the resolved audience, so a held
 * operator is simply not in the list.
 */
const TAG_LIMIT = 20

export function tagExpressionFor(tags: string[], excludeUserIds: string[]): string {
  const included = tags.slice(0, TAG_LIMIT)
  const excluded = [...new Set(excludeUserIds.filter(Boolean))]
    .map((userId) => `user:${userId}`)
    .slice(0, Math.max(TAG_LIMIT - included.length, 0))

  if (excluded.length === 0) return createTagExpression(included)
  return `(${included.join(' || ')}) && !(${excluded.join(' || ')})`
}

/**
 * The sends a set of platforms needs. Left out, every platform is attempted.
 *
 * iOS and macOS share one send: both are APNs, and the hub's Apple credential is
 * the only one involved.
 */
export function legsFor(platforms?: HubPlatform[]): HubLeg['channel'][] {
  if (!platforms) return ['apns', 'fcmv1', 'wns']

  const legs: HubLeg['channel'][] = []
  if (platforms.includes('ios') || platforms.includes('macos')) legs.push('apns')
  if (platforms.includes('android')) legs.push('fcmv1')
  if (platforms.includes('windows')) legs.push('wns')

  return legs
}

/**
 * Sends to whoever carries these tags, on the platforms the audience actually
 * has: iOS and macOS (one APNs send), Android (FCM v1), Windows (WNS).
 *
 * `platforms` is what the audience's devices reported. Left out, every platform
 * is attempted — which is right for a caller that does not know the audience,
 * and wrong for a broadcast, where a platform nobody has would still cost a
 * request and log a failure if its credentials were missing from the hub.
 *
 * The sends go out together and none can fail another: an alert that reaches
 * Android but not iOS is still delivered, and the error is recorded.
 */
export async function sendByTags(
  tags: string[],
  message: HubMessage,
  options: { excludeUserIds?: string[]; platforms?: HubPlatform[] } = {},
): Promise<HubResult> {
  const result: HubResult = { sent: 0, legs: [], errors: [], skipped: null }

  if (tags.length === 0) return result

  const notifications = hub()
  if (!notifications) {
    result.skipped = 'not-configured'
    return result
  }

  const tagExpression = tagExpressionFor(tags, options.excludeUserIds ?? [])
  const wanted = new Set(legsFor(options.platforms))

  const candidates: { name: HubLeg['channel']; run: () => Promise<unknown> }[] = [
    {
      name: 'apns',
      run: () =>
        notifications.sendNotification(
          createAppleNotification({
            body: appleBody(message),
            headers: {
              'apns-push-type': 'alert',
              'apns-priority': message.priority === 'loud' ? '10' : '5',
            },
          }),
          { tagExpression },
        ),
    },
    {
      name: 'fcmv1',
      run: () =>
        notifications.sendNotification(createFcmV1Notification({ body: fcmBody(message) }), {
          tagExpression,
        }),
    },
    {
      name: 'wns',
      run: () =>
        notifications.sendNotification(
          createWindowsToastNotification({ body: windowsBody(message) }),
          { tagExpression },
        ),
    },
  ]

  const legs = candidates.filter((leg) => wanted.has(leg.name))
  if (legs.length === 0) return result

  const outcomes = await Promise.all(
    legs.map(async (leg): Promise<HubLeg> => {
      try {
        await leg.run()
        return { channel: leg.name, ok: true }
      } catch (cause) {
        return {
          channel: leg.name,
          ok: false,
          error: cause instanceof Error ? cause.message : String(cause),
        }
      }
    }),
  )

  result.legs = outcomes
  result.sent = outcomes.filter((leg) => leg.ok).length
  result.errors = outcomes
    .filter((leg) => !leg.ok)
    .map((leg) => `${leg.channel}: ${leg.error}`)

  return result
}

/** The wire tags an installation carries: who it belongs to, and what it hears. */
export function installationTags(userId: string, notificationTags: string[]): string[] {
  return [`user:${userId}`, ...notificationTags.map((tag) => `nt:${tag}`)]
}

/** `user:<id>` tags for people named the old way, before tags existed. */
export function userTags(userIds: string[]): string[] {
  return [...new Set(userIds)].map((userId) => `user:${userId}`)
}
