# inss-app-backend

The HTTP API for the INSS apps (Hono on Node), plus the socket.io signaling
server for Kiosk Connect.

That socket used to run in `../cooperrtc`, a separate Express process. It is now
attached to this API's HTTP server, so a client is pointed at one origin for both
`/api/*` and `/socket.io` — which is what a host like Render gives it.

The mobile app (`../inss-support`, v2) is the only client today. The website
(`../inssapp`, v1) keeps its own pages and its NextAuth cookie session; it will
never be deployed, so its `/api/mobile/*` routes were moved here instead.

## Run it

```bash
npm install
npx puppeteer browsers install chrome   # once: PDFs are printed by a real browser
npm run dev            # http://localhost:3001
npm run build && npm start
```

Set `PORT` to serve elsewhere: the default is **3001** so the API can run at the
same time as v1's dev server on 3000. `npm run dev` reads `.env` with Node's own
loader; a deployed process takes its variables from the host.

## Environment

| Variable | Used for |
|---|---|
| `MONGODB_URI` | the `global` database (users, magic-link tokens) and `loglady` (facility metrics) |
| `AUTH_SECRET` (or `MOBILE_AUTH_SECRET`) | signing the app's bearer tokens |
| `jwtSecret` (or `RTC_AUTH_SECRET`) | signing Kiosk Connect's socket tokens — the same secret v1 signs them with, so kiosks already in the field keep working |
| `twilioAccountSid`, `twilioAuthToken` | TURN credentials for calls; without them peers fall back to Google STUN, which fails across strict networks |
| `AUTH_POSTMARK_KEY` | sending magic-link email (falls back to `POSTMARK_KEY`) |
| `azureStorageAccountName`, `azureStorageAccountKey` | signing photo upload URLs |
| `intuitClientId`, `intuitClientSecret` | QuickBooks: the OAuth flow, token refresh and every API call |
| `encryptionKey` | sealing the QuickBooks tokens at rest — the same key and scheme the existing ones were sealed with |
| `googleClientEmail`, `googlePrivateKey` | the service account the console's photo tool uploads with (v1's names); `GOOGLE_DRIVE_SUBJECT` and `GOOGLE_DRIVE_PHOTO_FOLDER` override the impersonated account and the destination folder |
| `KIOSK_PUBLIC_BASE_URL` | the public origin a kiosk's `kioskUrl` is built from (default `https://app.inselfstorage.com`) |
| `QR_PUBLIC_BASE_URL` | the origin printed QR codes encode; defaults to `API_URL`, then the request's own origin, so a deployed API answers with itself |
| `CRON_SECRET` | the bearer secret the four `/api/cron/*` endpoints require; with none set they all answer 401 |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | what browsers subscribe with and what signs every browser send. Browsers are pushed by this service alone, so the pair lives here and nowhere else. Generate with `node -e "console.log(require('web-push').generateVAPIDKeys())"` and never regenerate: a new pair invalidates every existing subscription. Without them scans are still recorded and nobody is told |
| `VAPID_SUBJECT` | the contact in the VAPID header, a `mailto:` or URL (default `mailto:support@inselfstorage.com`) |
| `NOTIFY_DEBOUNCE_SECONDS` | the quiet window after a QR code's alert: further scans inside it are recorded but not sent (default 60, `0` turns it off) |
| `AZURE_NOTIFICATION_HUB_CONNECTION_STRING`, `AZURE_NOTIFICATION_HUB_NAME` | push: the hub installations (phones and browsers) are written to and sends go through. APNs, FCM and the VAPID pair live in the hub, not here. Without them devices are still remembered, and a delivery says nothing could be reached |
| `CUBBY_API_KEY` | Cubby's API: rent roll, pricing groups, aged receivables and each facility's activity |
| `CUBBY_BQ_KEY` | base64 service-account JSON for the Cubby warehouse (BigQuery), used for the facility list |
| `INTUIT_REDIRECT_URI` | overrides the QuickBooks callback URL (defaults to `API_URL` + `/admin/integration/intuit/oauth`) |
| `API_URL` | the public origin used in magic-link emails and the QuickBooks redirect (defaults to the request's origin) |
| `PUPPETEER_EXECUTABLE_PATH` | the Chrome/Chromium binary to print PDFs with (defaults to the one `npx puppeteer browsers install chrome` put in puppeteer's cache) |
| `PUPPETEER_NO_SANDBOX` | set to `1` only where Chrome cannot sandbox itself (many containers); it is off by default because it weakens the rendering sandbox |
| `PORT` | listen port (default 3001) |

## Routes

All paths match what the app already calls, so pointing the app at this service
was a host change, not a client rewrite. Everything is JSON except the
magic-link landing page, which is HTML for a browser.

| Route | Auth | What it does |
|---|---|---|
| `POST /api/mobile/auth/signin` | — | `{ email \| username, password }` → `{ token, user }`. Same password check as the website. |
| `GET /api/mobile/auth/session` | bearer | `{ user }`; re-reads the user, so a deactivated account is refused at once. |
| `POST /api/mobile/auth/magic-link` | — | `{ email }` → emails a one-time link. Answers the same for unknown addresses. In development the response also carries the link. |
| `GET /api/mobile/auth/magic-link?token=…` | — | Redeems the link and hands the token to the app through `inssappv2://`. |
| `GET /api/mobile/admin/users` | admin | `{ users }` — everyone, active or not, without password material. |
| `POST /api/mobile/admin/users` | admin | `{ firstName, lastName, email?, roles? }` → `{ user }`. No password is set. |
| `GET /api/mobile/admin/users/:userId` | admin | `{ user }` |
| `PATCH /api/mobile/admin/users/:userId` | admin | profile, roles, `active`. A locked user cannot be edited; an administrator cannot deactivate themselves or drop their own administrator role. |
| `POST /api/mobile/admin/users/:userId/photo` | admin | `{ contentType }` → a write-only SAS for one blob. |
| `PATCH /api/mobile/admin/users/:userId/photo` | admin | `{ blobName }` → checks the uploaded blob (image, 8 MB max) and saves `photoUrl`. |
| `GET /api/mobile/kpi` | admin, manager, supervisor | `{ facilities }` — every `kpiActive` facility from `loglady.locations` with its metrics as raw numbers. |
| `GET /api/mobile/kpi/lists` | admin, manager, supervisor | `{ lists }` — saved facility subsets from `loglady.savedKpiLists`. Shared by everyone, exactly as on the website. |
| `POST /api/mobile/kpi/lists` | admin, manager, supervisor | `{ name, facilityIds }` → `{ list }`. |
| `DELETE /api/mobile/kpi/lists/:listId` | admin, manager, supervisor | `{ deleted: true }`; 404 when the list is already gone. |
| `GET /api/mobile/investor` | investor | `{ locations, portfolio, organizationPortfolio }` — v1's `prepareInvestor`, scoped to the caller's own `investors` record. |
| `GET /api/mobile/investor/files` | investor | `{ files }` — the documents shared with this investor, grouped by folder in the app. |
| `GET /api/mobile/investor/files/:fileId/url` | investor | `{ url, expiresOn }` — a ten-minute read-only SAS for one document this investor may see; anyone else's file is a 404. |
| `GET /api/mobile/investor/locations/:locationId/reports/:kind` | investor | `{ report }` — one QuickBooks report for a property in the caller's portfolio (`profit-loss` or `budget-vs-actual`), as tables plus printable HTML. `?start=&end=` are optional; without them the reply carries v1's default window. |
| `POST /api/mobile/pdf` | bearer | `{ html, filename?, landscape? }` → the PDF itself (`application/pdf`, as an attachment). The one print endpoint: it knows nothing about reports. |
| `GET /api/mobile/admin/integrations/quickbooks` | admin | `{ integration }` — the connection, read live: company name from QuickBooks, token expiries, and `needsAttention` when something has to be renewed. |
| `POST /api/mobile/admin/integrations/quickbooks/connect` | admin | `{ url, expiresOn }` — Intuit's authorize URL, carrying a signed fifteen-minute `state` naming the administrator. |
| `GET /admin/integration/intuit/oauth` | signed state | QuickBooks' OAuth callback, at v1's path. Saves the tokens in exchange for the code; failures are pages too. |
| `GET /api/mobile/admin/locations` | admin | `{ locations }` — every property, by name, with its status, KPI flag, OER score and manual inputs. |
| `GET /api/mobile/admin/locations/:locationId` | admin | `{ location }` — the same record plus its investor-portal notes, newest first. |
| `PATCH /api/mobile/admin/locations/:locationId` | admin | Any subset of the editable fields: manual inputs, `status`, `kpiActive`, `oerScore`, `departmentId` + `departmentName`. |
| `POST /api/mobile/admin/locations/:locationId/notes` | admin | `{ content }` → `{ note }`. |
| `DELETE /api/mobile/admin/locations/:locationId/notes/:noteId` | admin | `{ deleted: true }`; only a note belonging to that property. |
| `GET /api/mobile/admin/quickbooks/departments` | admin | `{ departments }` — the QuickBooks departments a property can be linked to. |
| `GET /api/mobile/admin/investors` | admin | `{ investors }` — everyone with the investor role, with their associated equity accounts. |
| `GET /api/mobile/admin/investors/equity-accounts` | admin | `{ accounts }` — the QuickBooks equity accounts an investor can be associated with. |
| `GET /api/mobile/admin/investors/:userId` | admin | `{ view }` — one investor's holdings per property and their total. |
| `PUT /api/mobile/admin/investors/:userId/investments` | admin | `{ investments }` → `{ investor }`; replaces the association list, creating the record on first save. |
| `GET /api/mobile/admin/investments` | admin | `{ investments }` — every investment in the book, with its account and property names. |
| `GET /api/mobile/admin/documents` | admin | `{ documents }` — the investor portal's files, newest first. |
| `POST /api/mobile/admin/documents/upload` | admin | `{ contentType, fileName? }` → a write-only SAS for one server-named blob. |
| `GET /api/mobile/admin/documents/audience` | admin | `?audience=allInvestors\|investor\|locationSpecific` with `investorId` or `locationId` → `{ users }`: how many investors will see a file filed that way, by the same rule the Files tab reads with. |
| `POST /api/mobile/admin/documents` | admin | `{ blobName, name, audience, investorId?, locationId?, folderName?, notify? }` → `{ document, notification }`; the blob is read back first, so nothing is recorded for a failed upload. `notify` is `{ title, body?, priority }` and tells the document's own audience it was posted. |
| `GET /api/mobile/admin/documents/:documentId/url` | admin | `{ url, expiresOn }` — a short-lived read SAS. |
| `DELETE /api/mobile/admin/documents/:documentId` | admin | `{ deleted: true }`; removes the row and the bytes. |
| `GET /api/mobile/admin/qr-codes` | admin | `{ codes }` — active codes with their public and kiosk links; `?includeInactive=1` adds deactivated ones. |
| `POST /api/mobile/admin/qr-codes` | admin | `{ name, url }` → `{ code }`. The id is fixed for the life of the code. |
| `PATCH /api/mobile/admin/qr-codes/:codeId` | admin | `{ name?, url?, active?, notifyTags?, notification?, notifyUserIds? }` → `{ code }`. `notification` is `{ title?, body?, priority }` and merges over what is stored. The tags are the audience and the switch; there is no on/off flag. |
| `GET /api/mobile/admin/qr-codes/:codeId/svg` | admin | `{ svg }` — the drawing as markup, for a native SVG renderer. |
| `GET /api/mobile/admin/qr-codes/:codeId/image` | admin | The same drawing as `image/svg+xml`, for a browser. |
| `GET /api/mobile/notifications/devices` | bearer | `{ devices }` — the phones this account has alerts on. |
| `POST /api/mobile/notifications/installations` | bearer | `{ installationId, platform: 'ios' \| 'android' \| 'macos' \| 'windows', pushChannel, appVersion?, deviceLabel? }` → `{ installation, synced }`. The tags come from the account, never from the device, so nobody can subscribe themselves to a tag. A macOS or Windows build registers here too: macOS is an APNs token, Windows a WNS channel URI. |
| `DELETE /api/mobile/notifications/installations/:installationId` | bearer | `{ deleted }`; only the caller's own. |
| `GET /api/mobile/admin/notification-tags` | admin | `{ tags }` with how many accounts and codes use each. There are no predefined tags — the registry starts empty and everything in it was created here. |
| `POST /api/mobile/admin/notification-tags` | admin | `{ label, description? }` → `{ tag }`; the slug is derived from the label. |
| `PATCH /api/mobile/admin/notification-tags/:slug` | admin | `{ label?, description?, active? }`. |
| `DELETE /api/mobile/admin/notification-tags/:slug` | admin | Only when nothing uses it — a tag still on an account or a code answers 409 and should be turned off instead. |
| `GET /api/mobile/admin/qr-codes/:codeId/notifications` | admin | `{ notifications }` — the alerts that code raised, newest first: whether a sign is being scanned, and whether anything arrived. |
| `GET /api/mobile/admin/notifications` | admin | `{ notifications }` — the send log, newest first, with what each channel did. |
| `GET /api/mobile/admin/notifications/preview?tags=` | admin | `{ users, devices }` — the audience a send would reach. |
| `POST /api/mobile/admin/notifications/send` | admin | `{ tags, title, body?, priority }` → `{ notification }`. |
| `GET /api/mobile/push/key` | bearer | `{ publicKey }` — the VAPID key a browser subscribes with; `null` when the server has no keys yet. |
| `POST /api/mobile/push/subscribe` | bearer | `{ endpoint, keys: { p256dh, auth }, device? }` → `{ subscription }`. Upsert into `global.pushSubscriptions`; no hub registration, because this service sends to browsers itself. The same browser subscribing again updates one row, and a browser signing in as someone else moves its alerts to them. |
| `POST /api/mobile/push/unsubscribe` | bearer | `{ endpoint }` → `{ deleted }`; only the caller's own subscriptions. |
| `POST /api/mobile/push/test` | bearer | `{ sent, browser, phone }` — one loud alert to the caller's own devices, phones and browsers, so "are alerts working?" has an answer that does not need a scan. |
| `POST /api/mobile/qr/:codeId/scan` | — | `{ url, live, name }` — where a code resolves right now, and the point at which a scan is recorded. Unknown or deactivated answers the fallback destination, not an error. |
| `GET /api/mobile/qr/:codeId/svg` | — | The code drawn as SVG. `404` for an id that does not exist. |
| `GET /api/mobile/admin/rtc/devices` | admin | `{ devices }` — active kiosk devices, by name, each with its `kioskUrl`. |
| `GET /api/mobile/admin/rtc/devices/:deviceId` | admin | `{ device }` — with its playlist, ordered by priority, and its on-hold image and call tone resolved to URLs. |
| `POST /api/mobile/admin/rtc/devices` | admin | `{ name, hardwareMake, hardwareModel, hardwareSerial }` → `{ device }`. |
| `PATCH /api/mobile/admin/rtc/devices/:deviceId` | admin | Profile fields, `onHoldImageId`, `callStartToneId`, `active`. |
| `POST /api/mobile/admin/rtc/devices/:deviceId/schedule` | admin | `{ rtcMediaId, priority, duration? }` → `{ item }`. |
| `DELETE /api/mobile/admin/rtc/devices/:deviceId/schedule/:scheduleId` | admin | `{ deleted: true }`. |
| `GET /api/mobile/admin/rtc/media` | admin | `{ media }` — the kiosk media library. |
| `POST /api/mobile/admin/rtc/media/upload` | admin | `{ contentType, fileName? }` → a write-only SAS for one blob in the open media container. |
| `POST /api/mobile/admin/rtc/media` | admin | `{ blobName, name, mediaType }` → `{ media }`; the blob is checked before the row is written. |
| `DELETE /api/mobile/admin/rtc/media/:mediaId` | admin | `{ deleted: true }`. |
| `POST /api/mobile/rtc/token` | admin, developer, manager, supervisor | `{ token, expiresOn, iceServers }` — the console's socket token (one hour) and TURN credentials. |
| `GET /api/mobile/rtc/kiosk/:deviceId` | device id | `{ token, expiresOn, iceServers, device }` — a kiosk's socket token (four days), its playlist and TURN credentials. A deactivated device is a 404. |
| `POST /api/mobile/rtc/photos` | admin, developer, manager, supervisor | `{ dataUrl, fileName }` → `{ file: { id, name } }` — the console's capture tool files the PNG in v1's Google Drive folder. |
| `GET /api/cron/quickbooks` | `CRON_SECRET` | Departments, accounts, budgets, loan balances, equity, dividends and P&L. |
| `GET /api/cron/cubby` | `CRON_SECRET` | The facility list, rent roll, pricing groups and aged receivables, into staging. |
| `GET /api/cron/cubby-process` | `CRON_SECRET` | The staging tables into each facility's `statistics`. |
| `GET /api/cron/roles` | `CRON_SECRET` | Adds the `investor` role to accounts that have an investor record, removes it from those that do not. |

## Notes

- **Auth.** Bearer tokens carry only the user id (`iss: inssapp`,
  `aud: inss-support`, 30 days) and the user is re-read from Mongo on every
  request. The website's tokens are the same shape, so a token issued by either
  works on both while they share `AUTH_SECRET`.
- **CORS.** `*` on `/api/*`: the Expo web build runs on another origin and native
  clients send no origin at all, so the token is the only credential. Nothing is
  cacheable.
- **Photos.** The app uploads straight to Azure with a SAS this service signs for
  a single server-chosen blob (`master-open/userPhotos/…`, write-only, ten
  minutes). The account key never leaves the server and no Azure SDK ships in the
  app. The confirm step re-reads the blob's real size and content type and
  deletes it if it fails either, so a cancelled upload leaves nothing behind.
- **Investor documents.** Read access is a SAS for one blob, ten minutes, signed
  only after the file is found in that investor's own list — never a container
  SAS, so a leaked URL reads one document and cannot list or write.
- **Kiosk photos.** The photo tool's frame is posted here as a PNG data URL and
  filed in Google Drive with v1's service account, impersonating the same
  subject (`googleClientEmail`, `googlePrivateKey`, optional
  `GOOGLE_DRIVE_SUBJECT` / `GOOGLE_DRIVE_PHOTO_FOLDER`). It talks to Google's
  token and multipart upload endpoints with a signed assertion rather than
  shipping the whole `googleapis` client for one request. Names keep v1's
  `location_customer_unit_yyyymmdd_type` shape, cleaned for a file system. A body
  that is not PNG is refused before anything leaves the process, and images are
  capped at 12 MB.
- **Investor scope.** The investor routes take no id: the portal always reads the
  `investors` row for the signed-in user, so one investor cannot request
  another's portfolio or documents. A user with the role but no investor record
  gets a 404 rather than an empty portfolio.
- **PDF.** One endpoint, one shared headless Chrome. The caller sends markup and
  gets a PDF; nothing about reports is baked into it. The browser is launched on
  the first print and reused (a warm print takes ~150 ms, a cold one ~4 s), each
  page is closed as soon as it has printed, and the browser closes itself after
  five idle minutes or on `SIGINT`/`SIGTERM` so a stopped server holds no Chrome.
  Documents are capped at 2 MB and render for at most 30 seconds. Deployments
  need a Chrome binary — the README's install step, or `PUPPETEER_EXECUTABLE_PATH`.
- **QuickBooks reports.** Parsed here, formatted here, printed here:
  `ProfitAndLoss` for Profit & Loss, `BudgetVsActuals` for Budget vs Actuals and
  for the Management Summary's financial block. Nested account groups are kept
  (v1 dropped them), totals are QuickBooks' own numbers rather than recalculated,
  and dates follow v1's defaults and limits — Profit & Loss stops where the books
  stop, Budget vs Actuals runs to today, the summary to yesterday.
- **QuickBooks.** One connection, in `global.integrations`
  (`integrationId: 'quickbooks'`): access token, refresh token and company id,
  sealed individually and stored with the same document, field names and AES
  scheme v1 used, so an existing connection carries over without re-authorising
  and either service can read what the other wrote (`src/quickbooks/`). Access
  tokens refresh five minutes before they expire, one refresh at a time even when
  several requests need it; the company id always comes from storage, never from
  the caller, so nothing can point the API at another realm. Connecting is a
  browser errand: an administrator asks for an authorize URL, Intuit calls back
  to `/admin/integration/intuit/oauth`, and the app only reads status. That path
  is v1's, so the redirect URI already registered with Intuit keeps working when
  this service answers on that host; set `INTUIT_REDIRECT_URI` when it does not.

## Data refresh

Every number the KPI board and the investor portal show is written by these
endpoints; nothing computes a metric on read. They are v1's Vercel crons
(`inssapp/vercel.json`) moved here, with the schedules left to whatever calls
them — a Render cron job, a system crontab, any scheduler that can send a
header:

```bash
curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<api-host>/api/cron/quickbooks
```

| Endpoint | v1 schedule | What it does |
|---|---|---|
| `/api/cron/quickbooks` | every 5 hours | Departments and accounts first (everything else is attributed by them), then budgets, loan balances, equity by account, dividends, and year-to-date P&L. |
| `/api/cron/cubby` | 08:30 | Reads the Cubby warehouse and API into `cubbyRentRoll`, `cubbyPricingGroups` and `cubbyAgedReceivables`, and creates a location for any facility that has none. |
| `/api/cron/cubby-process` | 10:30 | Turns those three tables into one `statistics` block per facility. |
| `/api/cron/roles` | by hand | Keeps the `investor` role in step with the `investors` records. |
| `/api/cron/notifications-sync` | hourly | Retries the phone installations the hub refused, and prunes anything unseen for 90 days — phone devices and browser subscriptions alike. |

Run `cubby` before `cubby-process`; the process step refuses to start on an
empty staging table rather than writing zeros over the portfolio. Both stages
are safe to run twice, and so is the QuickBooks refresh — every write is an
upsert or a replace of something it just read.

Each endpoint answers with the same report: one entry per step, its duration,
what it wrote, or why it failed. **200** when every step succeeded, **500** when
any did not — a scheduler can alert on the status alone. Steps are independent:
a failed budget pull does not stop the P&L, and the report says which is which.

Three places this deliberately differs from v1, all of them because v1 wrote
bad data rather than none:

- **A property with no QuickBooks department** used to get a zeroed `profitLoss`,
  because the report went out with `department=undefined`, failed, and the empty
  result was still saved. It is skipped now.
- **An empty answer no longer wipes a collection.** v1 replaced the rent roll and
  the equity rows whenever the response was truthy — an empty array is truthy —
  so a quiet response could blank the board. A wipe now needs rows.
- **The role sync only touches `investor`.** v1 set `roles` to `['investor']` or
  `[]` outright, which would strip `administrator` from an administrator. This
  adds and removes the one role and leaves the rest of the account alone.

A facility whose Cubby calls fail keeps its previous numbers and is listed in
that run's `failures`; only the facilities that answered are written.

## QR codes and notifications

A code lives in `global.qr`: a fixed id, a name, a destination, and now the
notification it raises when someone scans it.

**The pages belong to the app, not to this service.** A printed sign encodes one
hostname (`app.inselfstorage.com/qr/<id>`), and that hostname has to keep working
whatever happens to the API — so `/qr/:id` and `/qr/:id/kiosk` are routes in
`../inss-support`, and what is here is the two things only a server can do:

- `POST /api/mobile/qr/:codeId/scan` — where the code points *now*. A POST
  because looking is the event: it records the scan and may notify whoever the
  code names, and a GET could be fired by a link preview nobody read. Unknown or
  deactivated codes answer the fallback destination rather than an error — the
  visitor scanned a real sign, and a broken page is a worse answer than the
  company homepage.
- `GET /api/mobile/qr/:codeId/svg` — the drawing, so a lobby screen and the sign
  beside it are the same picture from the same id.

**Notification tags.** A code carries `notifyTags`, `notifyUserIds` (named
recipients, from before tags) and `notification: { title, body, priority }`.

Choosing tags *is* how a code starts notifying — there is no separate on/off flag
to get out of step with the audience. Clear the tags and the code simply
redirects. Tags without a title are refused (`400`): that would be an alert that
says nothing. An unknown tag is also refused, because it would be an
audience nobody is in. `priority` is `'quiet'` (the default) or `'loud'` — quiet
is the default because choosing an audience should not start making phones ring
until that is asked for.

Every scan of a notifying code writes a row to `global.notifications`:

```json
{ "kind": "qr-scan", "qrCodeId": "…", "qrCodeName": "Maple St front gate",
  "destination": "https://…", "title": "Front gate scanned", "body": "…",
  "priority": "loud", "recipients": ["<userId>"], "status": "delivered",
  "createdAt": "…", "deliveredAt": "…", "note": "2 browser(s) alerted." }
```

**A loud alert is a call.** A push cannot make a sound the sender chooses, needs
permission that may have been refused, and needs a browser that is running — so a
loud alert also rings every window the tagged accounts have open, over the
signaling socket (`incomingAlert`, room `user:<id>`). The app answers or ignores
it; answering opens the code it came from. Quiet alerts are notification-only,
and kiosk devices are never rung.

**Delivery** is the one `deliver()` seam in `src/notifications.ts`, and it sends
to every device the tagged accounts have turned alerts on in — phones through the
hub, browsers directly. The outcome is written back onto the row: `delivered`
with a count, `pending` when nobody who should be told has alerts on yet, `failed`
when the push service refused — with the reason in `note`, so an empty tray is
explained rather than mysterious. A delivery problem never blocks the redirect,
and the row is the record of what happened.

**Browsers are pushed by this service** (`src/push/browser.ts`), which is what
Windows, macOS and Linux run. The web build subscribes once through a service
worker (`inss-support/public/sw.js`); this service keeps `{ endpoint, keys }` in
`global.pushSubscriptions` against the signed-in user and sends to each
subscription with `web-push`. There is no hub in that path: the endpoint *is* the
delivery address, so registering it as an installation would only add a copy to
keep in sync. A scan is addressed to the people it resolved, so a browser alert is
one request per subscription and nobody has to be filtered out afterwards. The
browser does not have to be open — its push service wakes the worker — and
nothing has to be installed. `priority` decides how it arrives: `loud` is a
notification with a sound that waits to be dismissed, `quiet` is one that is there
when you look.

Every browser family takes that path, Safari included: Apple's Web Push
(`web.push.apple.com`) speaks the same protocol, so one sender and one payload
shape cover Chrome, Edge, Firefox and Safari. `src/push/payload.ts` builds it, and
the pair in `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` is the only key involved —
the app subscribes with the public half, this service signs with the private one.

**The native apps go through the hub** (`src/push/hub.ts`) — phones, and the same
app built for macOS or Windows. Each install registers its APNs token, FCM token
or WNS channel URI — not an Expo push token — with the tags its account carries,
prefixed `nt:<slug>` and `user:<id>`. A send is one request per platform — Apple
(iOS and macOS share it), FCM v1, WNS — because the SDK builds a single-platform
message, and only the platforms the audience actually has are attempted;
loud becomes `sound: default` + `interruption-level: time-sensitive` +
the `alerts-loud` Android channel, quiet becomes silent and `passive` on the
`alerts-quiet` channel. On Windows a send is toast XML instead of JSON:
`scenario="urgent"` plus a sound for loud, silent `audio` for quiet, and a
`launch="inssappv2://…"` that opens the app on the scanned code. Those two Android
channels are created by the app before it prompts, because Android 13 will not
show the permission dialog without one and a channel's importance cannot be
changed afterwards.

**Tags are what make most of this addressable.** `global.notificationTags` is the
registry (`/admin/notifications`); `users.notificationTags` is who hears what;
`GET /api/mobile/auth/session` carries them so the app knows on sign-in whether
to ask for permission at all. Changing a person's tags rewrites every device they
have, since the hub routes the phones by the tags on their installations: until
that write succeeds, the hub still sends those phones by the old set. Browsers
need no such write — a scan addresses them by the audience it resolved, so a tag
change reaches them on the next alert. `GET /api/cron/notifications-sync` retries
whatever the hub refused and forgets anything unseen for 90 days.

**Documents are addressed to people, not tags.** Uploading a file in Admin →
Investor Portal → Documents can tell the investors who can see it that it was
posted (`notify` on the create call). The audience is the file's own — every
active investor, one investor, or the investors holding the property, worked out
by `documentAudienceUserIds` from the same rows `investorFiles` reads. So an
account with **no** tags can still switch alerts on (an investor, whose statements
arrive this way), which is what `receivesAlerts` in the app decides: tags **or**
the investor role. That is eligibility, not enrolment — nothing is asked on
arrival, and a device registers only when its owner presses Enable in Account, per
device. Anybody else is never offered it, and an installation they keep is
removed. Document alerts do not ring the in-app takeover and do not count as
offers in the operator performance figures — there is no call to answer.

Set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` or nothing is delivered — the row
says so. Generate the pair once and keep it; a new pair invalidates every
existing subscription.

**A code is quiet after it rings.** A scan that lands within
`NOTIFY_DEBOUNCE_SECONDS` (default 60) of the last alert for that code is still
recorded — every scan is a scan — but its row is `suppressed` and nothing is
sent. That is what stops a chat client's link preview, a double tap or a retry
from ringing someone twice. The window is per code and can be turned off with
`0`; the panel under the code shows both the alerts and the suppressed scans, so
silence is visible rather than mysterious.

**Rate limits.** `POST /admin/notifications/send` allows 30 sends per
administrator per ten minutes and `POST /push/test` allows 5 per person per five
minutes; both answer `429` with `Retry-After`. The counters are in-process, which
fits a service that already runs as a single instance for the socket server —
scaling out means moving them to Redis along with the socket adapter.

## Kiosk Connect signaling

socket.io is attached to this API's HTTP server (`src/rtcSignaling.ts`) at the
default path `/socket.io`. It replaces `../cooperrtc`: the event names, the
JSON-string payloads and the relay-by-socket-id handshake are the ones the kiosk
and operator pages already speak, so moving the host is all those pages see.

**Connecting.** Pass the token as the `token` header on the handshake (what the
browser pages do — socket.io sends it on the polling request), in
`auth: { token }`, or as `Authorization: Bearer`. A missing, bad or expired token
is refused with a `connect_error`; nothing is handled before it is verified. Any
origin may connect: a kiosk is an unattended browser on its own network, and the
token is the credential.

A kiosk is also checked against its device row **in the handshake**, before
socket.io tells the client it is connected: a device that was deactivated or
deleted is refused with `connect_error` rather than connecting and being
dropped, which is what a page would see as a connect/disconnect loop. Claiming
the device (writing `socketId` and `status`) happens there too, so the console's
first `rtcDeviceConnected` can never describe a device the database does not
know is online.

**Clients.** v2 carries both ends, at v1's paths: the console at
`<web origin>/kioskconnect` and a kiosk at
`<web origin>/kioskconnect/kiosk/<rtcDeviceId>`. They read `EXPO_PUBLIC_API_URL`,
so the pages talk to whichever API they were built against, and the socket rides
that same origin. A kiosk needs only the device id in its URL — the token comes
from the bootstrap route.

**Presence.** A kiosk token (`type: 'kiosk'`, or `'client'` as the old token
helpers wrote it) joins as that device: `socketId` and `status: 'connected'` are
written to `global.rtcDevices`, and the operators get `devicesRefresh` (the list
of active devices) and `rtcDeviceConnected`. An operator token
(`type: 'operator'`) joins the `operators` room and is sent the device list
immediately — the console has no other way to fill it. On disconnect the device's
`socketId` is cleared, `status` becomes `disconnected`, and the list is pushed
again. Online means "the stored socket id is one this process holds", so an id
left behind by a dead process reads as offline without the collection having to
be cleaned up.

The device list is one list for the whole installation, not scoped to an
organization: the website already reads every device in `rtcDevices` regardless
of its `organizationId`, and its operator tokens carry no organization.

**Relaying a call.** A peer sends `{ connectSocketId, ... }` naming the other
end; the server forwards to that socket with `connectSocketId` replaced by the
sender's id, as a JSON string:

| Sent by a peer | socket event | Arrives as |
|---|---|---|
| operator | `initRtcDevice` | `initializeConnection` |
| kiosk | `rtcDeviceInitialized` | `rtcDeviceInitialized` |
| either | `offerCreated` | `offerAvailable` (`{ offer }`) |
| either | `answerCreated` | `answerAvailable` (`{ answer }`) |
| either | `iceCandidate` | `incomingIce` (`{ candidate }`) |
| either | `callOnHold` | `callOnHold` (`{ hold }`) |
| either | `partnerError` | `partnerError` (`{ error }`) |
| either | `selfFocus`, `partnerFocus`, `enableScreenshareDisplay`, `resetYourself` | the same name |

Media never passes through this process: peers swap SDP and ICE here and then
talk directly. TURN credentials come from `POST /api/mobile/rtc/token` (or the
kiosk bootstrap), which caches Twilio's short-lived ones for five minutes and
falls back to STUN when they cannot be had.

**Hosting.** Signaling wants one instance: without a shared adapter two
processes cannot see each other's sockets, so a device would read as offline on
the instance it is not attached to. A single Render web service is that — the
WebSocket upgrade rides the same `PORT` as the API, so nothing extra is needed
beyond the variables above. If it ever has to scale, add
`@socket.io/redis-adapter` (or sticky sessions) so the socket table is shared.

## Checks

```bash
npx tsc --noEmit
```
