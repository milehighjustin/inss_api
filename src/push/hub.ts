import {
  NotificationHubsClient,
  createAppleInstallation,
  createAppleNotification,
  createFcmV1Installation,
  createFcmV1Notification,
  createTagExpression,
} from '@azure/notification-hubs'

import type { PushPriority } from './browser.ts'

/**
 * Phone push, through Azure Notification Hubs.
 *
 * The hub holds the APNs and FCM v1 credentials, so this service never touches a
 * certificate or a service-account key: it registers an installation per app
 * install (the device token plus the tags to route by) and sends by tag
 * expression.
 *
 * Two facts shape this file:
 *
 * 1. A send is **one platform per request**. `createAppleNotification` and
 *    `createFcmV1Notification` are different messages, so every alert is an APNs
 *    send and an FCM v1 send against the same expression.
 * 2. Routing is by the **tags stored on the installation**, not by a query at
 *    send time. A user's tags only take effect once their installations have
 *    been rewritten — which is why `installationTags` exists and why a tag change
 *    re-registers every device that user has.
 *
 * Without the two environment variables nothing here runs and every caller gets
 * `configured: false` instead of an exception: a scan still redirects, and the
 * notification row says why nobody's phone buzzed.
 */

export interface HubMessage {
  title: string
  body: string
  priority: PushPriority
  /** Grouping key in the tray; a second alert replaces the first. */
  tag?: string
  data?: Record<string, string>
}

export interface HubInstallation {
  installationId: string
  userId: string
  platform: 'ios' | 'android'
  pushChannel: string
  tags: string[]
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

/** Whether phone push can be attempted at all in this process. */
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
  if (!notifications) throw new Error('Phone notifications are not configured on this server.')

  const common = {
    installationId: input.installationId,
    userId: input.userId,
    pushChannel: input.pushChannel,
    tags: input.tags,
  }

  await notifications.createOrUpdateInstallation(
    input.platform === 'ios'
      ? createAppleInstallation(common)
      : createFcmV1Installation(common),
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

export interface HubLeg {
  channel: 'apns' | 'fcmv1'
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
 * Sends to whoever carries these tags, on both phone platforms.
 *
 * Both sends go out together and neither can fail the other: an alert that
 * reaches Android but not iOS is still delivered, and the error is recorded.
 */
export async function sendByTags(tags: string[], message: HubMessage): Promise<HubResult> {
  const result: HubResult = { sent: 0, legs: [], errors: [], skipped: null }

  if (tags.length === 0) return result

  const notifications = hub()
  if (!notifications) {
    result.skipped = 'not-configured'
    return result
  }

  const tagExpression = createTagExpression(tags)

  const legs: { name: HubLeg['channel']; run: () => Promise<unknown> }[] = [
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
  ]

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
