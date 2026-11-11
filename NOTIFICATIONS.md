# Notifications

How push notifications work: tags on users, QR codes that name tags, and two
transports that each do what the other cannot — Azure Notification Hubs for the
phones, which hold tokens only Azure's APNs and FCM credentials can use, and this
service pushing straight to each browser subscription, which needs no hub at all.

**Status: built.** The registry, user tags, QR tag pickers, installations,
both delivery channels, the admin console and the reconcile cron are in place.
What is left is not code: the Azure hub's APNs/FCM credentials, an app bundle
identifier and package (push is tied to them), `google-services.json`, a
development build, and a device to prove it on. The last section lists exactly
what is unverified.

## Goals

- Tags are the administrator's own vocabulary: there are no predefined ones, so
  the registry starts empty and is filled in from Admin → Notifications.
- An administrator can give any user any number of **notification tags**.
- A notification can be sent to one or more tags; every device registered to a
  user carrying one of those tags receives it.
- A QR code chooses **which tags** are alerted when it is scanned, plus the
  message and whether it is loud or quiet.
- The app asks for notification permission **only** for users who have at least
  one tag. No tag, no prompt, ever.

Non-goals for this pass: per-device read receipts, notification inbox inside the
app, scheduled or recurring notifications, and critical alerts (needs Apple's
separate entitlement).

Desktop is no longer a non-goal — it is built. Windows, macOS and Linux are
served by this service pushing straight to each browser's subscription; Azure is
not in that path at all: see [Desktop](#desktop-windows-macos-and-linux).

## Vocabulary

| Term | Meaning |
| --- | --- |
| Notification tag | A stable slug in a registry, e.g. `support`. Assigned to users; chosen by QR codes. |
| Audience tag | The wire form of a notification tag: `nt:<slug>`. This is what an installation carries. |
| Installation | One native app install, as Azure knows it — a phone, or the app built for macOS or Windows. It names itself with a UUID it generates once. Browsers are *not* installations — see [Desktop](#desktop-windows-macos-and-linux). |
| Push channel | The raw APNs token (iOS, macOS), FCM registration token (Android), or WNS channel URI (Windows). Not an Expo push token. |
| Loud / quiet | How the alert arrives. Loud: sound + time-sensitive delivery. Quiet: visible, silent, no wake. |

## How it travels

```
Admin assigns tags ──► users.notificationTags ──► re-sync each phone installation
                                                        │
QR scan ──► notification record (tags, title, body, priority)
                        │
                        ▼
              tags resolved to people (and named recipients)
                        │
             ┌──────────┴──────────────────────────────┐
      APNs send                                 one web push send
      FCM v1 send                               per subscription
      WNS send                              (Chrome, Edge, Firefox and Safari
   (iPhone/Mac, Android, Windows           on Windows/macOS/Linux, sent by this
    by tag expression, via Azure —         service — no Azure in the path)
    only the platforms in the audience)
```

Three important facts that shape everything:

1. A hub send is **one platform per request**. Apple, FCM v1 and WNS are
   separate messages, so every alert is up to three sends against the same tag
   expression — and only the ones the audience has a device for.
   (Templates could collapse them, but templates put the payload shape in the
   installation instead of the code, which is worse for us.)
2. **The two paths are addressed differently, on purpose.** Phones are routed by
   the tags stored on their installations, so a tag change only takes effect once
   those are updated. Browsers are addressed by the audience the scan already
   resolved — the same list the in-app ring used — so a tag change reaches them on
   the next alert with nothing to sync, and somebody on a call is simply not in
   the list.
3. **Azure serves the native apps only.** Anything a browser needs is one HTTP
   call to an endpoint we already hold, so the hub would add a registration to
   maintain and nothing else. That is why `hub.ts` has no browser code.

## Desktop: Windows, macOS and Linux

**This half is built.** `src/push/browser.ts`, `src/routes/push.ts`, the service
worker `inss-support/public/sw.js` and the Account block are in place; a scan
already alerts every browser its recipients have subscribed.

### What "desktop" means

The web build in a browser — no Electron or Tauri shell. v2 is Expo Router, and
its web target is the desktop app. That has one consequence worth stating: push
arrives through the **browser's** push service, so the browser must be installed,
but it does not have to be running.

### How a browser is routed

It is not routed — it is **sent to**. `push/browser.ts` holds every subscription
as `{ endpoint, keys }`, and a scan hands it the list of people to tell; it then
makes one `web-push` call per subscription (RFC 8030/8291/8292, VAPID). Chrome,
Edge, Firefox, Safari on macOS and Safari on iOS all take that same path, because
Apple's `web.push.apple.com` speaks standard web push.

There is deliberately no hub in it. Azure's Browser platform would have meant an
installation per browser to create, re-create when the account's tags changed, and
repair when a write failed — all to reach an address we already store, for a
client whose audience the scan has already resolved. The hub earns its place on
the phones, where it holds the APNs and FCM credentials this service cannot use
itself.

Everything else about browsers is shared with the phones: the message, the
audience, the loud/quiet rules, and the exclusion applied to anyone on a call.

### The native builds: macOS and Windows

The same app, built with `react-native-macos` or `react-native-windows`, registers
as platform `macos` or `windows` through the ordinary installation endpoint, and
receives its alerts through the hub exactly as a phone does:

- **macOS is APNs.** Apple's push service carries macOS and iOS alike, so it is
the same leg, the same payload and the same reasoning as an iPhone — no second
sender to build or keep working.
- **Windows is WNS**, whose messages are toast XML rather than JSON. Loud sets
`scenario="urgent"` (breaks through Focus Assist) with the default notification
sound; quiet is `audio silent="true"` with no scenario. Both carry a
`launch="inssappv2://…"` pointing at the path a browser alert would use, so a
click opens the app on the code that was scanned.

Two Azure constraints, both configuration rather than code:

1. **WNS credentials live on the hub** — the Windows Store app's Package SID and
   client secret — the same way APNs and FCM credentials do. Until they are there,
   a `wns` send is refused with an authorization error and the log records it.
2. **One APNs credential per hub, and it names a bundle id.** iOS and macOS are
   different apps with different bundle ids, so a native macOS build needs its own
   hub (or the iOS app's hub, if the macOS one adopts the same bundle id, which
   App Store rules will not allow for the same app). This is the one place where
   "just add a platform" is not enough.

A send only attempts the platforms the audience actually has: `platformsFor()`
reads the distinct platforms of the people being told, so a broadcast to a
Windows-free team does not make a WNS request, and a hub missing a platform's
credentials only shows up once somebody actually has that device.

### What a browser needs

1. **HTTPS** (or `localhost`): service workers and push do not exist otherwise.
2. **A service worker at the site root.** `public/sw.js` is copied to the build
   root and served at `/sw.js`, which gives it scope `/`. A worker under
   `/assets/` would only control `/assets/`.
3. **Permission, asked from a click.** Safari and Firefox only show the prompt in
   a user gesture, and Chrome penalises origins that ask outside one. So the
   prompt is raised by the Account button, never on launch — the same policy as
   the phones.
4. **A VAPID key pair in this service's environment.** The browser subscribes
   with the public half and this service signs with the private one — the only
   sender. Nothing else holds the pair, so there is nothing to keep in step with
   Azure.

### Storage

`global.pushSubscriptions`, one row per browser, and the only copy there is:

```ts
{ _id: string         // sha256(endpoint) — the same browser subscribing again
                      //   updates one row instead of adding a second
  userId: string
  endpoint: string    // https, the push service's URL for this browser
  keys: { p256dh, auth }   // the encryption keys; never logged, never returned
  device: string      // "Chrome on macOS", from the user agent
  createdAt, updatedAt, lastSentAt?
  lastError?, failedAt? }
```

Indexes: `_id` (primary), `userId`.

No tags and no sync state: the row is used exactly as written, and routing comes
from the audience the scan resolved. The app posts on every enable and every
launch where it already has a subscription, so signing in as someone else on the
same browser moves the alerts to that person; deactivating an account removes the
browsers with the phones.

A `404` or `410` from a push endpoint means the browser is gone (uninstalled,
permission revoked, profile deleted): the row is deleted rather than retried
forever. Anything older than ninety days without a re-registration is pruned by
the notifications-sync cron.

### Payload

The same message the phones get, in the shape a service worker reads:

```json
{ "title": "Front gate scanned", "body": "Maple St",
  "priority": "loud", "silent": false, "tag": "qr-<codeId>",
  "renotify": true, "icon": "/notification-icon.png",
  "badge": "/notification-badge.png", "url": "/",
  "kind": "qr-scan", "qrCodeId": "…" }
```

`icon` and `badge` are **paths on the app's origin**, not URLs: this service does
not know where the app is hosted, so the worker resolves them against
`self.location.origin`. They are what stops a desktop alert reading as
"Google Chrome · app.inselfstorage.com" — without them the OS draws the browser's
own mark, and the notification looks like a message from the browser rather than
from INSS. The two files live in `inss-support/public/`, so the export copies
them to the site root. **They are currently generated from the app's own icon,
which is still Expo's placeholder** — replacing the app icon and re-running the
same two `sips` calls is what makes them the company mark.

The worker turns that into `showNotification` options:

| | Quiet | Loud |
|---|---|---|
| `silent` | `true` | `false` |
| `requireInteraction` | `false` | `true` — stays until dismissed |
| `renotify` | `false` | `true` — re-alerts when it replaces |
| `urgency` (push header) | `low` | `high` |
| `tag` | the code | the code — a second scan replaces the first |
| `icon`, `badge` | the app's mark | the app's mark |

`renotify` needs a non-empty tag, which is why every alert carries one. The
payload limit is the Web Push one, about 4 KB.

What "loud" cannot do on a desktop: macOS Focus and Windows Focus Assist still
suppress it, and so does a browser's own "quiet notifications". That is the same
ceiling as the phones' mute switch, and the same answer — Apple's Critical Alerts
is a separate approval and out of scope.

**It cannot ring.** The sound of a notification belongs to the OS and the browser,
not to the sender: there is no field to supply a tone, and no way to play audio
from a service worker (no `AudioContext` there). `silent: false` only *permits* the
system sound; whether one plays is the user's per-app setting and the OS's mood.
Phones are the one place a push rings on its own: APNs and FCM both take a sound
name.

### The call: ringing an open app

Because a push cannot ring, a loud alert is also sent over the signaling socket
that Kiosk Connect already runs on (`src/rtcSignaling.ts`). Every operator socket
joins `user:<userId>` as well as `operators`, and `deliver()` calls `ringUsers()`
for a loud alert **before** it touches a push service — a window must not wait on
a push round trip to start ringing.

- It reaches an open window whether or not notification permission was ever
granted. Being told is not a permission.
- The client (`inss-support/src/lib/alerts/incoming.tsx`) shows a full-screen
takeover with **Answer** and **Ignore**, and synthesises the ring with Web Audio —
440 + 480 Hz, 1.2 s on, 3 s off — so no audio file is shipped. A page whose audio
context is suspended starts ringing on the first interaction, and shows the
overlay meanwhile.
- Answering stops the tone and, for an administrator, opens Admin → QR inside the
code it came from.
- **Quiet alerts never travel this way.** The server sends only loud ones and the
client drops anything else, so quiet stays a notification that waits to be looked
at.
- The socket token lives an hour; on `connect_error` the client asks for a fresh
one instead of retrying a dead token forever.
- **Nobody connected is not an error.** The push for the same alert has already
gone out (they are sent together), and a scan never waits on ringing.
- Kiosk devices are excluded: an unattended screen has no one to answer a call.

### API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/mobile/push/key` | `{ publicKey }` — what the browser subscribes with; `null` when unconfigured. |
| `POST` | `/api/mobile/push/subscribe` | `{ endpoint, keys, device? }` → `{ subscription }`. Upsert, so a browser that signs in as someone else moves its alerts to them. |
| `POST` | `/api/mobile/push/unsubscribe` | `{ endpoint }` → `{ deleted }`. Only the caller's own. |
| `POST` | `/api/mobile/push/test` | `{ sent }` — one loud alert to the caller's own browsers, so "is it on?" has an answer. |

All four need a bearer token and act only on the caller's own subscriptions. The
`subscribe` call runs on every visit to Account as well as on the button, which is
how a shared browser stops alerting the previous person.

### Configuration

```bash
node -e "console.log(require('web-push').generateVAPIDKeys())"
```

| Variable | Used for |
|---|---|
| `VAPID_PUBLIC_KEY` | signing, and served to the browser to subscribe with |
| `VAPID_PRIVATE_KEY` | signing — never leaves the server |
| `VAPID_SUBJECT` | the contact in the VAPID header: a `mailto:` or URL (default `mailto:support@inselfstorage.com`) |

Generate the pair once and keep it. These three variables are the whole story:
this service is the only sender to browsers, so there is no second copy to match
and no blade to keep in step. A new pair invalidates every existing subscription
— the browser accepts a push only from the key its subscription was made under —
and everyone has to turn alerts on again.

The subject is **not** part of the pair: it is a contact address the push service
can use to reach whoever runs this app if its traffic is a problem, so it has to
read as a URI — `mailto:someone@example.com` or `https://…`. A display name is not
one, and a sender whose subject does not parse is refused by the push service
rather than corrected. Changing it invalidates nothing, so it can be edited
whenever.

The notification hub's **Browser (Web Push)** blade is no longer used. It can be
left empty: nothing in this system sends a browser alert through Azure.

### Known edges

- **Safari on macOS** takes the same direct path as every other browser, and it
  needs Ventura and Safari 16. It revokes a site's push
  permission if a push arrives and no notification is shown — so the worker must
  always call `showNotification`, which is why `userVisibleOnly: true` is not just
  a formality. Safari also ignores `icon`, `image` and `actions`, and its earlier
  handling of `tag` replacement was unreliable.
- **Chrome** shows "This site has been updated in the background" if the worker
  fails to display anything, so a broken handler is visible rather than silent.
- **iOS browsers are not a target.** Safari on iOS only supports web push for a
  home-screen web app; the app itself is native there, so that would be a second,
  worse implementation of the same thing.
- **Kiosk screens are not a target** either: an unattended screen in a lobby does
  not want an alert tray, and kiosk mode is excluded on the device.
- **Hosting `sw.js`.** The app's `web.output` is `server`, so an export puts
  `public/` in `dist/client` and the server has to answer `/sw.js` from there with
  `application/javascript`. A catch-all route that returns HTML for unknown paths
  breaks registration silently — the first thing to check after a deploy is
  `curl -I https://<app-host>/sw.js`.

## Data model

### `users` (existing collection, shared with the website)

```ts
notificationTags?: string[]   // slugs, e.g. ['support', 'accounting']
```

Additive, so v1 ignores it. Slugs only — never names, emails or anything
identifying, because Notification Hubs stores tags **unencrypted**.

### `global.notificationTags` (new)

The registry. One row per tag.

```ts
{ _id: 'support', label: 'Support', description?: string,
  active: boolean, createdAt: Date, updatedAt: Date }
```

- `_id` is the slug: lowercase, `a–z 0–9 . _ -`, 1–40 chars.
- Admin CRUD, and the only source of tags: the registry ships **empty** and every
  name in it is one an administrator created (Admin → Notifications → Tags).
- A tag that is still assigned to users or codes cannot be deleted — deactivate it
  instead (hidden from pickers, existing assignments keep working until removed).

### `global.pushInstallations` (new)

Our record of what we have registered. Notification Hubs holds the routing copy.

```ts
{ _id: string            // installation UUID generated on the device
  userId: string
  platform: 'ios' | 'android' | 'macos' | 'windows'
  pushChannel: string    // APNs / FCM token, or a WNS channel URI
  tags: string[]         // materialised: ['user:<id>', 'nt:support', …]
  appVersion?: string
  deviceLabel?: string
  createdAt: Date
  updatedAt: Date
  lastSeenAt: Date
  tagsSyncedAt: Date | null
  syncError?: string
}
```

Indexes: `_id` (primary), `userId`.

### `global.notifications` (existing, extended)

The delivery log. Existing rows keep their shape; new rows add:

```ts
{ kind: 'qr-scan' | 'manual' | 'document'
  qrCodeId?: string
  qrCodeName?: string
  documentId?: string       // the posted file, for a document alert
  documentName?: string
  documentFolder?: string
  title, body, priority
  tags: string[]            // slugs targeted (empty for a document)
  legacypeople?: string[]   // old notifyUserIds, still honoured
  expression: string        // what was actually sent
  sends: { platform: 'apns' | 'fcmv1' | 'wns' | 'browser', trackingId?,
           notificationId?, ok: boolean, error?: string }[]
  createdBy?: string        // userId for manual sends
  status: 'pending' | 'delivered' | 'failed' | 'suppressed' | 'no-audience'
  note?: string             // what happened, in a sentence
  createdAt, deliveredAt?
}
```

Indexes: `createdAt`, `qrCodeId`, `status`.

### `global.qr` (existing)

```ts
notifyTags?: string[]       // slugs — the audience, and the switch
notifyUserIds?: string[]    // kept for codes configured before tags
notification?: { title, body, priority }
```

There is no on/off field. A code notifies the tags it carries (plus any legacy
named recipients), and a code with neither simply redirects — the audience is the
whole answer to "does this alert anybody?". Rows written under the old flag may
still carry it on the document; nothing reads it, so it is inert.

A code is valid for notifications when it has at least one tag (or legacy
recipient); it also needs a title, so choosing an audience without one is refused
rather than saved as an alert that says nothing. Tags and legacy recipients are
union-expanded into the expression; the save is refused if that exceeds 20 tags.

## Limits (Azure-enforced)

| Limit | Value | What it means here |
| --- | --- | --- |
| Tags per installation | 60 | Cap a user at **40** notification tags; `user:<id>` and future system tags take the rest. |
| Tag length | 120 chars, `alnum _ @ # . : -` only | Prefixed slugs are far shorter. |
| OR-only tag expression | 20 tags | Cap a QR code at **20** tags; the picker recommends ≤ 10. |
| Platforms per send | 1 | Two sends per alert. |
| APNs payload | 4 KB | Title/body plus a small `data` object. |

## API surface

### App (session required)

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/mobile/notifications/installations` | Upsert this device: `{ installationId, platform, pushChannel, appVersion }`. Server derives tags from the user; replaces the installation in the hub. Idempotent. |
| `DELETE` | `/api/mobile/notifications/installations/:id` | Remove this device (sign-out, permission revoked, no tags left). Own installations only. |
| `POST` | `/api/mobile/alerts/:id/acknowledge` | Answer or ignore an alert: `{ outcome: 'answered' \| 'ignored' }`. Records the response time; 404 when that alert was never offered to you. |

The four desktop routes (`/api/mobile/push/…`) are already live and are listed
under [Desktop](#api). They are the browser's equivalent of these two: a
subscription instead of a device token.

`GET /api/mobile/auth/session` (already exists) gains `notificationTags: string[]`
so the app knows on sign-in whether to ask at all — no extra round trip.

### Admin (administrator role)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET/POST` | `/api/mobile/admin/notification-tags` | List / create tags. |
| `PATCH/DELETE` | `/api/mobile/admin/notification-tags/:slug` | Rename, describe, deactivate, delete when unused. |
| `PATCH` | `/api/mobile/admin/users/:userId` | Existing route gains `notificationTags`; server validates against the registry and re-syncs that user's installations. |
| `POST` | `/api/mobile/admin/notifications/send` | Ad-hoc send: `{ tags, title, body, priority }`. Returns the log row. |
| `GET` | `/api/mobile/admin/notifications` | Recent sends, filterable by tag/code. |
| `GET` | `/api/mobile/admin/performance` | Alerts, answers and calls per person and per property. `days` (default 30), or `from`/`to`. Administrator, manager or supervisor. |
| `GET` | `/api/mobile/admin/documents/audience` | How many investors will see a file filed under `audience` (+ `investorId`/`locationId`) — the count the upload form shows. |
| `POST` | `/api/mobile/admin/documents` | Gains optional `notify: { title, body?, priority }`: the document's own audience is told it was posted. Returns `{ document, notification }`. |

`PATCH /api/mobile/admin/qr-codes/:codeId` accepts `notifyTags` alongside the
existing notification fields.

### Operations (`CRON_SECRET`)

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/cron/notifications-sync` | Re-push phone installations whose `tagsSyncedAt` is stale or whose `syncError` is set, and prune what nobody has opened in 90 days — devices and browser subscriptions alike. |
| `POST` | `/api/cron/notifications/send` | Send by tag from a scheduler (smoke tests, future automations). |

## The app

### One provider, four states

`src/lib/notifications/` + a provider mounted beside the auth provider:

| State | When | Behaviour |
| --- | --- | --- |
| `unsupported` | iOS and Android today, kiosk screens | Nothing runs; Account says nothing at all about alerts. |
| `not-assigned` | signed in, no tags **and not an investor** | **No permission call at all.** If a registration exists, delete it. Account shows "No alert tags". |
| `needs-permission` | eligible account, permission not granted | Show the enable affordance in Account only; never call `requestPermissionsAsync` on launch. Home nudges **tagged** accounts once (an investor is never asked on arrival). |
| `registered` | eligible account, permission granted, enabling was pressed **on this device** | Upsert on launch/foreground and on token rollover. A device without the local opt-in flag is left alone even if the OS would grant permission silently. |

The provider reacts to: sign-in, sign-out, `notificationTags` changing, app
returning to the foreground, and `addPushTokenListener`.

**The browser is the exception, and it is already built.** There are no tags to
gate on yet and no token to rotate: `src/lib/push/browser.ts` (native no-op) and
`browser.web.ts` (web push) are driven by the Account block, which asks for the
browser's permission from a press and re-claims the subscription on every visit.
When the tag registry lands, the web block folds into the same provider and its
prompt gains the same gate — a user with no tags is not asked there either.

### Permission, deliberately

- **Who can enable.** Anyone something is actually sent to: an account carrying
  a notification tag, or an investor — a posted document is addressed to the
  investors who can read the file, which is nobody's tag. Everybody else is not
  offered the control at all, and an installation they still hold is removed. The
  rule lives in one place in the app (`receivesAlerts`), and it means *eligible*,
  not *enrolled*.
- **Nothing is asked on arrival.** The OS dialog is raised from the Account button
  and nowhere else. An investor is never prompted on login or while they have
  alerts off: opening Account is not enabling either — the phone section reads the
  state without registering, and the device records a local opt-in flag that only
  the Enable press sets. A second phone, or a fresh install, waits for its own
  visit to Account. The desktop side keeps the subscription's owner, so signing in
  on a browser someone else enabled never adopts their subscription.
- Channel creation happens **before** any permission request (Android 13 will not
  show the prompt until a channel exists).
- Two channels, created once with final settings (Android will not let us change
  importance later):
  - `alerts-loud` — High importance, default sound, vibration. "Alerts".
  - `alerts-quiet` — Low importance, no sound, no vibration. "Quiet alerts".
- Prompt policy, recommended: tagged users get a single in-app prompt — a banner
  on Home and a persistent control in Account — and the OS dialog is raised from
  that button, not silently on first launch. If `canAskAgain` is false, the
  button becomes "Open settings" (`Linking.openSettings()`), never a dead button.
- iOS provisional authorisation is treated as "quiet only": we still offer
  "Enable alerts" to request full authorisation, because provisional cannot play
  a sound.
- Decline is respected: no repeated prompts; Account is the only place to retry.

### Registration lifecycle

1. On launch, read the session: `notificationTags`, and whether the account is an
   investor (anything addressed to it).
2. Nothing addressed → delete this device's installation if present; stop.
3. Nothing was enabled **on this device** (no local opt-in flag and no stored
   installation id) → stop. Launching the app is not consent, even where the OS
   would grant permission silently.
4. Enabled here → channel → permission → `getDevicePushTokenAsync()` (native
   token; not an Expo push token) → `POST installations`.
5. `addPushTokenListener` re-posts when the OS rotates the token, but only for a
   switched-on device.
6. Sign-out deletes the installation **before** clearing the local session — a
   shared phone must stop receiving the previous user's alerts.
7. Permission revoked in OS settings → the next foreground check deletes the
   installation, so the hub stops spending sends on it.

**Devices are independent.** The installation id, the opt-in flag and the browser
subscription are all per device/browser, so enabling on a phone never enables a
laptop and turning one off leaves the others alone. Delivery goes to every device
that enabled, because a document alert is addressed to the person (`user:<id>`),
not to one install.

### Account & Home

- Account holds the whole control: the user's tags as chips, each device's state,
  and one action per channel (Enable / Open settings / Turn off). Quiet hours are
  not in this pass.
- Home shows a dismissible one-time banner for **tagged** users without
  permission: "You're on the Support alert list — enable notifications." Dismissed
  once and remembered per device. An investor is never asked on arrival — the
  Enable control waits in Account, because alerts are opt-in and per device.

## Delivery

### Building the audience

```
tags → ['nt:support', 'nt:accounting'] (+ 'user:<id>' for legacy recipients)
expression = tags.join(' || ')
```

**Documents are the exception that proves the rule.** Their audience is people,
resolved when the upload is recorded (`documentAudienceUserIds`): every active
investor, one investor, or the investors whose portfolio holds the property — the
same rows `investorFiles` reads to decide who may open the file. Those ids are
written to `recipients`, which delivery already treats as `user:<id>` tags for
phones and as a direct list for browsers, so nothing new is needed to reach a
phone that registered.

A document alert does **not** ring the in-app takeover and does **not** record an
offer, at either priority: there is no call to answer, and putting statements into
"answered ÷ offered" would quietly corrupt the operator figures. Loud for a
document means the push arrives with a sound, nothing more.

Refuse to send when the expression exceeds 20 tags — that is an authoring error,
not a runtime surprise.

### Payloads

Loud (iOS):

```json
{ "aps": { "alert": { "title": "…", "body": "…" },
           "sound": "default",
           "interruption-level": "time-sensitive" },
  "qrCodeId": "…", "kind": "qr-scan" }
```

with `apns-push-type: alert`, `apns-priority: 10`.

Loud (Android, FCM v1):

```json
{ "message": {
    "notification": { "title": "…", "body": "…", "channel_id": "alerts-loud" },
    "android": { "priority": "high" },
    "data": { "qrCodeId": "…", "kind": "qr-scan" } } }
```

Quiet is the same with no sound, `interruption-level: passive`,
`apns-priority: 5`, `channel_id: alerts-quiet`, `"priority": "normal"`.

Loud (Windows, WNS toast):

```xml
<toast activationType="foreground" launch="inssappv2:///admin/qr" scenario="urgent">
  <visual><binding template="ToastGeneric">
    <text>…</text><text>…</text>
  </binding></visual>
  <audio src="ms-winsoundevent:Notification.Default"/>
</toast>
```

Quiet drops `scenario` and uses `<audio silent="true"/>`. Every value is
XML-escaped, and the body is sent as `application/xml` with `X-WNS-Type:
wns/toast`.

What "loud" can and cannot do: iOS will still respect the mute switch and Focus;
`time-sensitive` only lets it break through Focus, not the hardware switch.
Android respects Do Not Disturb. Truly overriding both needs Apple's Critical
Alerts entitlement (case-by-case approval) and Android alarms — out of scope, and
worth telling support staff so expectations are right.

### Sending

`src/push/hub.ts` wraps the client:

- `registerInstallation({ installationId, platform, pushChannel, tags })` —
  `createAppleInstallation` (`ios`, `macos`) / `createFcmV1Installation`
  (`android`) / `createWindowsInstallation` (`windows`) +
  `createOrUpdateInstallation`. The platform the app reported decides it, never
  the shape of the token.
- `deleteInstallation(id)`.
- `send(expression, { title, body, priority, data }, { platforms })` — an APNs
  send, an FCM v1 send and a WNS send against the expression, minus the platforms
  the audience does not have; each accepted send returns a tracking ID.

`deliver()` in `notifications.ts` calls it and writes the log row. A scan awaits
the send (bounded by a timeout) so the record is complete before the scan
endpoint answers, and a hub failure marks the row `failed` with the error — the
visitor is never held up by it: the app has its destination either way.

Desktop goes out first, from the same function: `sendToUsers()` in
`src/push/browser.ts` posts one encrypted payload per browser subscription of a
recipient, in parallel, each bounded by an eight-second timeout, and reports
`sent`, `removed` and `errors`. The row is `delivered` when at least one browser
accepted it, `pending` when nobody has alerts on, and `failed` when the push
service refused — either way the scan endpoint has already answered and the page
has moved on.

### Tag changes

`PATCH /admin/users/:id` with `notificationTags`:

1. Validate slugs against the registry, dedupe, enforce ≤ 40.
2. Save the user.
3. For each installation of that user, re-PUT with the recomputed tag list.
4. Record `tagsSyncedAt` or `syncError` per installation; the cron reconcile
   retries failures.

Deactivating a user deletes their installations. Reactivating does not recreate
them — the device re-registers next time that user signs in.

## QR codes

Admin → QR Codes → a code:

- There is no on/off switch: picking tags is how a code starts notifying, and
  clearing them is how it stops. A switch beside an audience was two answers to
  one question, and the stored one could read "yes" while pointing at nobody.
- Message and priority sit under the picker, shown only once an audience exists.
- **Who gets it** is a tag picker (checkbox list from the registry, any number up
  to 20) instead of a list of people.
- Codes configured before this change show their named recipients as a read-only
  "Legacy recipients" group with a "Replace with tags" action. Until replaced,
  both are sent to (union, still capped at 20).
- Under the panel, a short "Recent alerts" list for that code: time, tags,
  priority, status. Read-only, from the log.

### Place and device on a code

A code carries two links beyond its destination, both optional and both chosen
from lists the panel already has:

| Field | What it does |
| --- | --- |
| `locationId` | The property the sign stands at. The alert names it ("L005 — Havana (Aurora) · Door 3") and performance is grouped by it. |
| `rtcDeviceId` | The video kiosk beside the sign. Answering the alert can start a call on that device, because the person who scanned is standing in front of it. |

Names are resolved from the ids when the alert is written, so a row says where
and which screen even after the device is renamed or retired. The location list
is the one Admin → Locations already edits; the device list is the active kiosks,
with offline ones shown but marked.

## Answering an alert

Three states, and the reason for each:

1. **Rung.** The socket pushes `incomingAlert` to every window the account has
   open. Push is the fallback, not the primary: it needs permission, a running
   browser and a sound the OS chooses, while a socket reaches an open app
   whether or not notifications were ever allowed.
2. **Held.** Someone already on a call is *not* rung and *not* pushed to — a
   banner about a different sign in the middle of a conversation is worse than
   useless. Their alert is kept, and rings the moment they hang up: call waiting
   rather than a missed call. Five are kept per person, oldest dropped first,
   and the held list is in memory because it is only meaningful while the call
   is. The notification row is still the record, and everyone who *was* free got
   the push.
3. **Answered.** Answering opens `/kioskconnect?device=<rtcDeviceId>&alert=<id>`,
   so the console comes up on that kiosk with the alert in hand and a Connect
   button. A code with no kiosk still answers — an administrator lands on that
   code's admin panel instead.

A dropped socket ends the call. "They hung up" and "their tab vanished" are one
path on purpose: a call that only ended on an explicit event would leave the
person permanently busy, and nobody would ever ring them again.

### Who is on a call

The console reports both ends itself, because only it knows when a call is
actually up:

| Event | Sent | Effect |
| --- | --- | --- |
| `callStarted` | after the SDP answer lands, with `{ notificationId?, rtcDeviceId?, rtcDeviceName? }` | Marks the operator busy, records `call-started` with the alert's code, property and device. |
| `callEnded` | on hang-up or reset | Clears busy, records `call-ended` with the call's length, releases anything held. |

Busy is per account, not per window: an operator with two tabs open is on one
call, and both sockets are tracked so closing one does not end it.

## Performance

The activity log answers what people *did*, which no other collection can: an
alert says what was sent, not whether anyone answered or how fast.

| Event | Written when | Carries |
| --- | --- | --- |
| `alert-offered` | a loud or quiet alert reaches someone free | alert, code, property, device |
| `alert-held` | an alert arrives while that person is on a call | the same, so "nobody answered" and "nobody was free" can be told apart |
| `alert-answered` | they answer | `latencyMs`, from the offer |
| `alert-ignored` | they decline | `latencyMs` |
| `call-started` | the call connects | `callId`, alert, code, property, device |
| `call-ended` | the call drops | `callId`, `durationMs` |

Events are appended and never edited. Acknowledgement is idempotent and refused
(404) for anyone who was not offered that alert, so a replayed or invented click
cannot manufacture a response time.

`GET /api/mobile/admin/performance?days=30` (administrator, manager, supervisor)
rolls the window up per person and per property:

| Column | Meaning |
| --- | --- |
| Offered / held | Times rung while free, times held because they were busy |
| Answered / ignored / missed | Clicked, declined, never touched |
| Answer rate | Answered ÷ offered |
| Median / average answer | Seconds from ring to click, per person and overall |
| Calls / talk time | Calls started and their total length |
| Last activity | The newest event, to spot an idle account |

Quiet alerts count as offers: a supervisor reading the rate should not have the
quiet codes silently disappear from the denominator. Medians are computed over
raw latencies rather than over per-person medians, which would weigh a person
who answered once the same as one who answered fifty times. The report reads at
most 50,000 events and asks the caller to shorten the range past that.

## Admin UI

New Admin section **Notifications** (next to Users / KPI / Investor / Kiosk / QR):

- Tags tab: the registry, create/rename/describe/deactivate, with how many users
  and codes use each one.
- Send tab: composer (tags, title, body, loud/quiet), preview of the audience
  count, send, then the recent sends list.
- Users → user detail gains a Notification tags block (chips + picker).
- QR codes → the tag picker above.
- Investor Portal → Documents → Add document gains **Tell the investors**: a
  switch that sends the uploaded file's own audience a title and message, with
  the audience count beside it. Off, the file is simply posted. The result says
  whether the alert reached a device, and the same row appears in the send log.

## Configuration

### Azure

- One hub per environment: a hub's APNs credential carries a single bundle ID and
  a single APNs environment (sandbox vs production), so dev (sandbox tokens) and
  production builds cannot share a hub.
- APNs: token auth (.p8, Key ID, Team ID, bundle ID).
- FCM: v1 service account (project ID, client email, private key). FCM legacy is
  retired; don't plan against it.
- Backend env: `AZURE_NOTIFICATION_HUB_CONNECTION_STRING`,
  `AZURE_NOTIFICATION_HUB_NAME` (hub name, not namespace), plus the existing
  `CRON_SECRET` for ops routes.

### App build

- Add `expo-notifications` (not installed yet) and its config plugin, with the
  notification icon and accent colour.
- `app.json` has no bundle identifiers today — push needs
  `ios.bundleIdentifier` and `android.package`, because the APNs topic is the
  bundle ID and FCM registration is tied to the package.
- Android needs `google-services.json` and `android.googleServicesFile`.
- Push needs a development build (Expo Go cannot receive it), and a physical
  device: iOS simulators do not produce an APNs token.
- Entitlement: the plugin adds `aps-environment` automatically. Time Sensitive
  Notifications entitlement is optional (without it `time-sensitive` degrades to
  `active`); Critical Alerts are out of scope.

## Failure handling

| Case | Behaviour |
| --- | --- |
| Hub rejects an installation | Keep the row with `syncError`; surface "couldn't reach the push service" in Account; reconcile cron retries. |
| Token rotated | `addPushTokenListener` → upsert. |
| App uninstalled | APNs/FCM report the token; the hub prunes. Our reconcile deletes records whose hub installation is gone, and prunes anything unseen for 90 days. |
| Hub down during a scan | Row is `failed` with the error; the visitor is still sent to the destination. Optional bounded retry, then the log stands as the record. |
| No installation matches | `status: 'no-audience'` — visible in the log, not an error, and usually a sign nobody with that tag has enabled notifications. |
| Permission revoked | Next app foreground deletes the installation. |
| Duplicate scans | One row per scan; the first alert, then `suppressed` inside the code's quiet window (`NOTIFY_DEBOUNCE_SECONDS`). |
| Someone sends in a loop | 30 sends per administrator per ten minutes, 5 test alerts per person per five. Both answer `429` with `Retry-After`. |

## Build order

0. **Desktop** — done: the subscription store and routes, the direct web push
   sender, the service worker, the Account block. **Still needed:** the VAPID pair
   in the environment. Prove with the Account test alert on Chrome or Edge on
   Windows and on Safari or Chrome on macOS, then a scan of a code that names you.
1. **Foundations** — done in code: `@azure/notification-hubs` in the backend,
   `expo-notifications` and its plugin in the app, the two hub variables in the
   environment. **Still needed:** a hub per environment with APNs and FCM v1
   credentials, `ios.bundleIdentifier` and `android.package` (the APNs topic *is*
   the bundle id), `google-services.json`, a development build and a device.
2. **Tags** — done: registry, user tags, the Users block, the session carries
   tags.
3. **Devices** — done: install/upsert/delete, the registration hook mounted beside
   the app shell, the Account block. Tagged accounts are prompted; untagged ones
   are never asked and are unregistered.
4. **QR** — done: `notifyTags` on the model and panel, the tag picker, scan →
   audience → one web push per browser subscription plus the two hub sends
   (Apple, FCM v1), log row.
5. **Admin Notifications** — done: `/admin/notifications` (tags, composer, log),
   the audience preview, and a test send that reaches the caller's own devices.
6. **Hardening** — done: the reconcile cron and prune
   (`/api/cron/notifications-sync`), in-process rate limits on the two sending
   endpoints, a per-code quiet window for scans, and a per-code recent-alerts
   list under the code in the QR panel. See [Abuse and noise](#abuse-and-noise).

## Abuse and noise

Three ways this could annoy people, and what each one does about it.

**A send used twice.** `POST /api/mobile/admin/notifications/send` is limited to
30 per administrator per ten minutes, and the test alert to 5 per person per five
minutes. Both answer `429` with `Retry-After`, and the app shows the sentence the
API returns. The counters are a fixed window in process memory
(`src/rateLimit.ts`): correct for this service, which already runs as one
instance because of the socket server, and not shared between instances if that
ever changes.

**A scan counted twice.** A chat client fetches the link to build a preview, a
person double taps, or someone retries a code that did not seem to work. The first
scan sends; every scan inside `NOTIFY_DEBOUNCE_SECONDS` (default 60) afterwards is
written with `status: 'suppressed'` and a note saying which alert it followed.
The window is per code — two different signs scanned together both alert — and
`0` turns it off. Every scan still has a row, so the log stays a true record.

**A sign that is not being scanned.** The QR panel shows the last few alerts for
the code it is editing: time, priority, audience, status and the note. Silence is
then evidence about the sign rather than an absence of information, and a
`suppressed` row proves the code works even when the alert was deliberately not
sent again.

## What is not verified

No part of the phone path has been run against a real hub: there are no APNs or
FCM credentials here and no device build, so `registerInstallation` and
`sendByTags` are exercised only by the type checker. The web path type-checks and
its routes answer, but a real browser has not been subscribed either — the
Account test button is the way to prove that, and it needs the VAPID pair set.

Specifically unverified: an installation the hub accepts; an APNs send arriving
loud and quiet; the `alerts-loud` and `alerts-quiet` channels being honoured on
Android 13+; `time-sensitive` passing Focus with the Time Sensitive
Notifications entitlement; and the hub's behaviour when a token has expired
(which is what the reconcile cron exists for).

## Test plan

- Unit: slug validation; expression building and the 20-tag refusal; installation
  tag computation; QR patch validation; legacy/new recipient union.
- Integration with a fake hub client and a fake push service: scan produces the
  record, one browser send per subscription plus each platform send the audience
  needs, the right payload per priority, `failed` on a hub error, and a withheld browser that is
  simply absent from the audience rather than filtered after the fact.
- On device: iOS granted / denied / provisional; Android 13 granted / denied;
  loud vs quiet with the phone unlocked, locked, muted; tag added and removed
  while installed; sign-out purge; second device for the same user; legacy code
  with named recipients.
- Rate limits: a seventh test alert in five minutes answers 429 with a
  `Retry-After`, and a fresh window allows again; a second administrator's send is
  unaffected by the first one's counter.
- The quiet window: scan a code twice within a minute → one alert and one
  `suppressed` row; scan it after the window → a second alert; two different codes
  inside the same minute → two alerts; `NOTIFY_DEBOUNCE_SECONDS=0` → every scan
  alerts.
- Desktop (works today): subscribe in Chrome on Windows and in Safari on macOS;
  test alert appears; scan alerts arrive with the tab closed; quiet stays silent
  and does not persist; loud stays until dismissed; permission denied shows the
  blocked sentence and no button; second account on the same browser moves the
  alerts; `unsubscribe` in browser settings leaves a row that is pruned on the
  next 410.
- Not testable without production credentials: production APNs and the
  Time Sensitive entitlement behaviour.

## Decisions taken

1. **Tags are a registry, not free text.** A slug must exist before it can be
   assigned or sent to, so a typo cannot create an audience nobody is in. A tag
   still in use cannot be deleted — it is turned off, which hides it from pickers
   while existing assignments keep working.
2. **The prompt is a button, never a launch behaviour.** iOS shows its dialog once
   in the app's life, so the Account control is the only place it is raised, and
   only for an account that actually carries a tag.
3. **Ad-hoc sending is in**, with an audience count and the log beneath it. It is
   how support gets told something that has no printed code.
4. **Legacy named recipients are kept.** A code printed before tags still tells
   its people; the panel shows them separately with a "Remove them" action once
   the tags cover the same ground. They ride along as `user:<id>` tags in the
   expression, capped at 20 either way.
5. **Loud means sound plus time-sensitive, subject to the device.** The mute
   switch and Focus still win. Critical Alerts is a separate Apple approval and
   is out of scope.
6. **Identifiers are still the deployment's decision.** Push is tied to them — the
   APNs topic is the bundle id and FCM registers against the package — so
   `app.json` does not invent them. Add `ios.bundleIdentifier` and
   `android.package` before the first development build. There is no tag seed: a
   fresh registry is empty until an administrator names the first tag.
