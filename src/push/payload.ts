/**
 * The JSON a browser's service worker reads, built in one place.
 *
 * Every browser alert leaves this service the same way — `web-push` to the
 * subscription's own endpoint — so this is the only shape there is: a title and
 * body to show, `silent` and `renotify` from the priority, and the rest of the
 * notification's data flattened alongside so a click can navigate. The worker at
 * `/sw.js` in the app reads exactly these fields, so a change here is a change
 * the app has to know about.
 */

export type PushPriority = 'loud' | 'quiet'

/**
 * The mark a desktop alert wears, as a path on the app's own origin.
 *
 * A notification shown by a browser is otherwise attributed to the browser —
 * "Google Chrome · app.inselfstorage.com" with Chrome's icon, which reads as a
 * message from the browser rather than from INSS. These two files live in the
 * app's `public/`, so the export copies them to the site root and the service
 * worker resolves the paths against its own origin. Relative on purpose: this
 * service does not know, and should not have to know, where the app is hosted.
 */
const NOTIFICATION_ICON = '/notification-icon.png'
/** The monochrome silhouette some platforms draw in the status bar. */
const NOTIFICATION_BADGE = '/notification-badge.png'

export interface BrowserAlert {
  title: string
  body: string
  priority: PushPriority
  /**
   * Collapse key. A second alert with the same tag replaces the first in the
   * tray instead of stacking, which is what a code scanned twice should do.
   */
  tag?: string
  /** Where a click on the notification goes. */
  url?: string
  /** Copies of these strings ride along, for the service worker to use. */
  data?: Record<string, string>
}

export function browserPayload(message: BrowserAlert): Record<string, unknown> {
  const quiet = message.priority === 'quiet'
  const tag = message.tag ?? 'inss'

  return {
    title: message.title,
    body: message.body,
    // The worker turns this into `silent` and `requireInteraction`: quiet is a
    // notification that is there when you look, loud is one that says so.
    priority: quiet ? 'quiet' : 'loud',
    silent: quiet,
    tag,
    // A tag is what makes a replacement possible; without `renotify` a replaced
    // notification arrives without making a sound.
    renotify: !quiet,
    icon: NOTIFICATION_ICON,
    badge: NOTIFICATION_BADGE,
    url: message.url ?? '/',
    timestamp: Date.now(),
    ...(message.data ?? {}),
  }
}
