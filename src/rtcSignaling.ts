import type { Server as HttpServer } from 'node:http'

import { Server, type Socket } from 'socket.io'

import type { AlertRef } from './activity.ts'
import { recordCallEnd, recordCallStart } from './activity.ts'
import { db } from './db.ts'
import { verifyRtcToken } from './rtcTokens.ts'

/**
 * Kiosk Connect's signaling socket.
 *
 * This is `cooperrtc` folded into the API: same event names, same JSON-string
 * payloads and the same relay-by-socket-id handshake the kiosk and operator
 * pages already speak, so moving the host is all a client sees. What the old
 * server got from the private `coopercode` package — token checks, the device
 * presence fields, the list of devices for the console — is done here against
 * the same Mongo documents.
 *
 * Only signaling lives here. Media never touches this process: the browser peers
 * exchange SDP and ICE candidates and then talk directly.
 */

const OPERATORS = 'operators'

let server: Server | null = null

/** The room holding every window one signed-in account has open. */
function userRoom(userId: string): string {
  return `user:${userId}`
}

/**
 * A loud alert, addressed to people rather than to devices.
 *
 * `priority` travels with it so the window can decide, but only loud alerts are
 * ever sent: quiet ones are notifications that wait to be looked at.
 */
export interface IncomingAlert {
  id: string
  title: string
  body: string
  priority: 'loud' | 'quiet'
  qrCodeId?: string
  qrCodeName?: string
  destination?: string
  createdAt: string
}

/**
 * Who is on a call, and what to do with the alerts that arrive meanwhile.
 *
 * A person in a video call is not available, and ringing them is worse than
 * useless: it takes over their screen in the middle of a conversation about the
 * thing that just got scanned. So they are not rung and not pushed to — the
 * alert is **held**, not dropped, and rings as soon as they hang up. Call
 * waiting rather than a missed call.
 *
 * Held per user in memory, because it is only meaningful while the call is: a
 * restart loses a held alert, but the push for it has already gone to everybody
 * who was free, and the notification row keeps the record.
 */
const calls = new Map<
  string,
  { callId: string; startedAt: Date; sockets: Set<string> }
>()

const held = new Map<string, IncomingAlert[]>()

/** How many alerts are kept while somebody is on a call. */
const MAX_HELD = 5

export function userIsBusy(userId: string): boolean {
  return calls.has(userId)
}

/**
 * Rings every open window these accounts have, the way a call does.
 *
 * Push is the fallback, not the primary: it needs permission that may have been
 * refused and a browser that is running, and its sound is the OS's to give. A
 * socket reaches an open app whether or not notifications were ever allowed, so
 * a loud alert can ring until somebody answers it.
 *
 * Answers with who was rung and who was held, because the caller records both:
 * "nobody answered" and "nobody was free to answer" are different problems.
 */
export function ringUsers(
  userIds: readonly string[],
  alert: IncomingAlert,
): { reached: string[]; held: string[] } {
  const reached: string[] = []
  const busy: string[] = []
  const unique = [...new Set(userIds)].filter(Boolean)

  for (const userId of unique) {
    if (!calls.has(userId)) {
      reached.push(userId)
      continue
    }

    busy.push(userId)
    held.set(userId, [...(held.get(userId) ?? []), alert].slice(-MAX_HELD))
  }

  const payload = JSON.stringify(alert)
  for (const userId of reached) {
    server?.to(userRoom(userId)).emit('incomingAlert', payload)
  }

  return { reached, held: busy }
}

/** Rings what was held for someone, oldest first, once their call is over. */
function releaseHeld(userId: string): void {
  const waiting = held.get(userId)
  if (!waiting || waiting.length === 0) return

  held.delete(userId)
  for (const alert of waiting) {
    server?.to(userRoom(userId)).emit('incomingAlert', JSON.stringify(alert))
  }
}

/**
 * Ends the call this socket was on, if it was on one.
 *
 * One path for "they hung up" and "their browser went away": a call that is
 * only ended by an explicit event would leave the person permanently busy after
 * a crash, and nobody would ever ring them again.
 */
async function releaseSocket(userId: string, socketId: string): Promise<void> {
  const call = calls.get(userId)
  if (!call) return
  if (!call.sockets.delete(socketId)) return
  if (call.sockets.size > 0) return

  calls.delete(userId)
  await recordCallEnd({ callId: call.callId, userId, startedAt: call.startedAt })
  releaseHeld(userId)
}

/** The alert a call was started from, so the call is attributable to a place. */
async function callContext(notificationId: string): Promise<Partial<AlertRef>> {
  const row = await (await db('global'))
    .collection<{ _id: string } & Record<string, unknown>>('notifications')
    .findOne({ _id: notificationId })

  if (!row) return {}

  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)

  return {
    notificationId,
    qrCodeId: text(row.qrCodeId),
    qrCodeName: text(row.qrCodeName),
    locationId: text(row.locationId),
    locationName: text(row.locationName),
    rtcDeviceId: text(row.rtcDeviceId),
    rtcDeviceName: text(row.rtcDeviceName),
  }
}

interface DeviceDocument {
  _id: string
  name?: string
  active?: boolean
  socketId?: string
  status?: string
  organizationId?: string
  [field: string]: unknown
}

/** What the console's device list needs: the id, the name and whether it is up. */
interface DevicePresence {
  _id: string
  name: string
  socketId: string | null
  status: 'connected' | 'disconnected'
}

/**
 * A device is online when its stored socket id is one this process holds.
 *
 * The stored id alone is not enough: a restart, or a round trip through the old
 * server, leaves ids behind that point at sockets nobody has. Checking against
 * the live socket table means the console is never told a device is reachable
 * when it is not, without having to clear the collection at boot.
 */
function presenceFromRow(row: DeviceDocument): DevicePresence {
  const stored = typeof row.socketId === 'string' && row.socketId ? row.socketId : null
  const socketId = stored && server?.sockets.sockets.has(stored) ? stored : null
  return {
    _id: String(row._id),
    name: typeof row.name === 'string' ? row.name : '',
    socketId,
    status: socketId ? 'connected' : 'disconnected',
  }
}

async function devicePresence(): Promise<DevicePresence[]> {
  const global = await db('global')
  const rows = await global
    .collection<DeviceDocument>('rtcDevices')
    .find({ active: true })
    .toArray()

  return rows
    .map((row) => presenceFromRow(row))
    .sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true }))
}

/**
 * The device list, pushed to every operator console.
 *
 * A no-op until a socket server is attached, so a route that changes devices
 * while running under a test does not have to check.
 */
export async function refreshRtcDevices(): Promise<void> {
  if (!server) return
  server.to(OPERATORS).emit('devicesRefresh', JSON.stringify(await devicePresence()))
}

/** Marks a device as calling, and answers with its row (the console needs its org). */
async function markConnected(deviceId: string, socketId: string): Promise<DeviceDocument | null> {
  const global = await db('global')
  return global.collection<DeviceDocument>('rtcDevices').findOneAndUpdate(
    { _id: deviceId, active: true },
    { $set: { socketId, status: 'connected', modified: new Date() } },
    { returnDocument: 'after' },
  )
}

/** Clears a dropped socket's device, whatever device that was. */
async function markDisconnected(socketId: string): Promise<string | null> {
  const global = await db('global')
  const row = await global.collection<DeviceDocument>('rtcDevices').findOneAndUpdate(
    { socketId },
    { $set: { status: 'disconnected', modified: new Date() }, $unset: { socketId: '' } },
    { returnDocument: 'after' },
  )
  return row ? String(row._id) : null
}

/** A signalling payload, parsed whether the peer sent an object or its JSON. */
function payload(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
    } catch {
      // Not JSON: there is no connectSocketId to relay to.
    }
  }
  return {}
}

/**
 * Attaches a listener by name.
 *
 * The socket is untyped on purpose — the event names are the clients', not this
 * server's — so this narrows the attach call once instead of at every use.
 */
function on(socket: Socket, event: string, listener: (raw: unknown) => void): void {
  const attach = socket.on.bind(socket) as unknown as (
    name: string,
    handler: (raw: unknown) => void,
  ) => void
  attach(event, listener)
}

/**
 * Forwards one signalling event to the peer socket it names.
 *
 * Clients send `{ connectSocketId, ... }` and get `{ connectSocketId, ... }`
 * back — the id is always the sender's, so the receiver knows where to answer.
 * The reply is a JSON string, the way the pages have always parsed it.
 */
function relay(
  socket: Socket,
  incoming: string,
  outgoing: string,
  extra?: (data: Record<string, unknown>) => Record<string, unknown>,
) {
  // The socket is untyped on purpose — the event names are the clients', not
  // this server's — so the listener is attached by name. Bound, because a
  // detached `on` would lose its emitter.
  const on = socket.on.bind(socket) as unknown as (
    event: string,
    listener: (raw: unknown) => void,
  ) => void

  on(incoming, (raw: unknown) => {
    const data = payload(raw)
    const target = data.connectSocketId
    if (typeof target !== 'string' || !target) return
    if (!server?.sockets.sockets.has(target)) return

    socket.to(target).emit(
      outgoing,
      JSON.stringify({ connectSocketId: socket.id, ...(extra ? extra(data) : {}) }),
    )
  })
}

function tokenFrom(socket: Socket): unknown {
  const handshake = socket.handshake
  const header = handshake.headers.token
  const headerToken = Array.isArray(header) ? header[0] : header
  const authorization = handshake.headers.authorization ?? ''
  const [scheme, bearer] = authorization.split(' ')
  const authToken = (handshake.auth as { token?: unknown } | undefined)?.token

  return headerToken || (scheme?.toLowerCase() === 'bearer' ? bearer : '') || authToken
}

/**
 * Attaches the signaling socket to the API's HTTP server.
 *
 * Any origin may connect: a kiosk is an unattended browser on its own network
 * and the token in the handshake is the credential. The browser pages pass it
 * as the `token` header (socket.io sends it on the polling handshake); a native
 * client may pass it in `auth` instead.
 */
export function attachRtcSignaling(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: {
      origin: '*',
      allowedHeaders: ['token', 'authorization', 'content-type'],
    },
  })
  server = io

  // The handshake is where a kiosk is admitted, not the connection handler.
  // socket.io tells the client it is connected before `connection` fires, so a
  // device that was deactivated or deleted would otherwise connect and be
  // dropped a moment later — the page would see a brief success and a reconnect
  // loop. Here a refused kiosk never gets a `connect` at all.
  io.use((socket, next) => {
    void (async () => {
      const identity = verifyRtcToken(tokenFrom(socket))
      if (!identity) {
        next(new Error('Invalid token'))
        return
      }

      if (identity.kind === 'kiosk') {
        // Claiming the device is part of admitting it: by the time the console
        // hears about the connection, presence is already written.
        const device = await markConnected(identity.deviceId, socket.id)
        if (!device) {
          next(new Error('That kiosk is not active'))
          return
        }
        socket.data.device = device
      }

      socket.data.rtc = identity
      next()
    })().catch((cause) => {
      console.error('[rtc] handshake failed:', cause)
      next(new Error('Could not verify the connection'))
    })
  })

  // The handler is async and socket.io does not await it, so every failure has
  // to be caught here: an unhandled rejection would take the API down with it.
  io.on('connection', (socket) => {
    void onConnection(socket).catch((cause) => {
      console.error('[rtc] connection failed:', cause)
      socket.disconnect(true)
    })
  })

  async function onConnection(socket: Socket): Promise<void> {
    const identity = socket.data.rtc as ReturnType<typeof verifyRtcToken>
    if (!identity) {
      socket.disconnect(true)
      return
    }

    if (identity.kind === 'kiosk') {
      // Claimed during the handshake, which is also what refused a device that
      // is not active.
      const device = socket.data.device as DeviceDocument | undefined
      if (!device) {
        socket.disconnect(true)
        return
      }

      if (device.organizationId) {
        await socket.join(`clients:${String(device.organizationId)}`)
      }

      socket.to(OPERATORS).emit(
        'rtcDeviceConnected',
        JSON.stringify({ rtcDeviceId: identity.deviceId, socketId: socket.id }),
      )
      await refreshRtcDevices()
    }

    if (identity.kind === 'operator') {
      await socket.join(OPERATORS)
      // Its own room too: "every operator console" and "every window this person
      // has open" are different audiences, and an alert is addressed to people.
      if (identity.userId) await socket.join(userRoom(identity.userId))
      // The console has no other way to list devices: send the current ones now,
      // then keep them current through the events below.
      socket.emit('devicesRefresh', JSON.stringify(await devicePresence()))

      // A call in progress: busy, recorded, and alerts held until it ends. The
      // console reports both ends; the socket's own disconnect ends it too, so a
      // crashed tab cannot make somebody permanently unreachable.
      if (identity.userId) {
        const userId = identity.userId

        on(socket, 'callStarted', (raw: unknown) => {
          void (async () => {
            if (calls.has(userId)) {
              calls.get(userId)?.sockets.add(socket.id)
              return
            }

            const data = payload(raw)
            const notificationId =
              typeof data.notificationId === 'string' ? data.notificationId : ''
            const context = notificationId ? await callContext(notificationId) : {}
            const deviceId =
              typeof data.rtcDeviceId === 'string' && data.rtcDeviceId
                ? data.rtcDeviceId
                : context.rtcDeviceId
            const deviceName =
              typeof data.rtcDeviceName === 'string' && data.rtcDeviceName
                ? data.rtcDeviceName
                : context.rtcDeviceName

            const callId = await recordCallStart(userId, {
              ...context,
              ...(deviceId ? { rtcDeviceId: deviceId } : {}),
              ...(deviceName ? { rtcDeviceName: deviceName } : {}),
            })

            calls.set(userId, { callId, startedAt: new Date(), sockets: new Set([socket.id]) })
          })().catch((cause) => {
            console.error('[rtc] could not record a call start:', cause)
          })
        })

        on(socket, 'callEnded', () => {
          void releaseSocket(userId, socket.id).catch((cause) => {
            console.error('[rtc] could not record a call end:', cause)
          })
        })
      }
    }

    relay(socket, 'initRtcDevice', 'initializeConnection')
    relay(socket, 'rtcDeviceInitialized', 'rtcDeviceInitialized')
    relay(socket, 'iceCandidate', 'incomingIce', (data) => ({ candidate: data.candidate }))
    relay(socket, 'offerCreated', 'offerAvailable', (data) => ({ offer: data.offer }))
    relay(socket, 'answerCreated', 'answerAvailable', (data) => ({ answer: data.answer }))
    relay(socket, 'partnerError', 'partnerError', (data) => ({ error: data.error }))
    relay(socket, 'enableScreenshareDisplay', 'enableScreenshareDisplay')
    relay(socket, 'partnerFocus', 'partnerFocus')
    relay(socket, 'selfFocus', 'selfFocus')
    relay(socket, 'callOnHold', 'callOnHold', (data) => ({ hold: data.hold === true }))
    relay(socket, 'resetYourself', 'resetYourself')

    socket.on('disconnect', () => {
      // A call cannot outlive its socket, whatever the client did or did not
      // send on the way out.
      if (identity.kind === 'operator' && identity.userId) {
        void releaseSocket(identity.userId, socket.id).catch((cause) => {
          console.error('[rtc] could not close a dropped call:', cause)
        })
        return
      }

      if (identity.kind !== 'kiosk') return

      void (async () => {
        const deviceId = await markDisconnected(socket.id)
        if (!deviceId) return

        // Broadcast from the server, not from this socket: by the time
        // `disconnect` fires the socket has left its rooms and cannot address
        // anyone.
        server?.to(OPERATORS).emit(
          'rtcDeviceDisconnected',
          JSON.stringify({ rtcDeviceId: deviceId, socketId: socket.id }),
        )
        await refreshRtcDevices()
      })().catch((cause) => {
        console.error('[rtc] could not clear device presence:', cause)
      })
    })
  }

  return io
}
