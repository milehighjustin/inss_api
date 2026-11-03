import { db } from '../db.ts'
import { getUser } from '../users.ts'

import { PushError } from './browser.ts'
import { deleteInstallation, hubConfigured, installationTags, registerInstallation } from './hub.ts'

/**
 * The devices a user has signed in on.
 *
 * Azure Notification Hubs is what routes a send, but it is not a list we can
 * read a user's devices from in the shape we need, and it cannot tell us which
 * registration failed. So every installation is kept here too, with the tags we
 * last pushed and whether that push worked — the hub is the routing copy, this is
 * the record.
 *
 * A row is written before the hub is called. If the hub refuses, the row stays
 * with `syncError` set and the reconcile cron retries it: a device that was
 * registered once should not have to be discovered again.
 */

export type InstallationPlatform = 'ios' | 'android'

export interface InstallationRecord {
  _id: string
  userId: string
  platform: InstallationPlatform
  pushChannel: string
  /** As pushed: `['user:<id>', 'nt:support', …]`. */
  tags: string[]
  deviceLabel?: string
  appVersion?: string
  createdAt: Date
  updatedAt: Date
  tagsSyncedAt: Date | null
  syncError?: string
}

/** What the app is told about its device — the push channel is never echoed. */
export interface InstallationSummary {
  installationId: string
  platform: InstallationPlatform
  tags: string[]
  deviceLabel: string
  createdAt: string
  updatedAt: string
  synced: boolean
}

function installations() {
  return db('global').then((global) =>
    global.collection<InstallationRecord>('pushInstallations'),
  )
}

const ID_PATTERN = /^[A-Za-z0-9._:-]{8,120}$/

function summarize(row: InstallationRecord, synced: boolean): InstallationSummary {
  return {
    installationId: row._id,
    platform: row.platform,
    tags: row.tags,
    deviceLabel: row.deviceLabel ?? '',
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    synced,
  }
}

/**
 * Records this device and pushes its tags to the hub.
 *
 * Idempotent: the id is generated once on the device, so a foreground, a token
 * rollover and a tag change are all the same upsert. `synced` says whether the
 * hub accepted it — the app can say "we'll keep trying" rather than pretending.
 */
export async function saveInstallation(
  userId: string,
  input: {
    installationId: string
    platform: InstallationPlatform
    pushChannel: string
    appVersion?: string
    deviceLabel?: string
  },
): Promise<{ installation: InstallationSummary; synced: boolean; error?: string }> {
  const installationId = input.installationId.trim()
  const pushChannel = input.pushChannel.trim()

  if (!ID_PATTERN.test(installationId)) {
    throw new PushError('A device needs an installation id')
  }
  if (!pushChannel || pushChannel.length > 4096) {
    throw new PushError('A device needs its push token')
  }

  const user = await getUser(userId)
  if (!user || !('userId' in user) || !user.userId) {
    throw new PushError('That account is not there', 404)
  }

  const tags = installationTags(userId, user.notificationTags ?? [])
  const collection = await installations()
  const now = new Date()

  await collection.updateOne(
    { _id: installationId },
    {
      $set: {
        userId,
        platform: input.platform,
        pushChannel,
        tags,
        deviceLabel: (input.deviceLabel ?? '').slice(0, 200),
        appVersion: (input.appVersion ?? '').slice(0, 40),
        updatedAt: now,
        tagsSyncedAt: now,
      },
      $setOnInsert: { createdAt: now },
      $unset: { syncError: '' },
    },
    { upsert: true },
  )

  const row = await collection.findOne({ _id: installationId })
  if (!row) throw new PushError('That device could not be recorded')

  if (!hubConfigured()) {
    const error = 'Phone notifications are not configured on the server yet.'
    await collection.updateOne(
      { _id: installationId },
      { $set: { tagsSyncedAt: null, syncError: error } },
    )
    return { installation: summarize({ ...row, tagsSyncedAt: null }, false), synced: false, error }
  }

  try {
    await registerInstallation({
      installationId,
      userId,
      platform: input.platform,
      pushChannel,
      tags,
    })

    return { installation: summarize(row, true), synced: true }
  } catch (cause) {
    const error = cause instanceof Error ? cause.message : String(cause)
    await collection.updateOne(
      { _id: installationId },
      { $set: { tagsSyncedAt: null, syncError: error, updatedAt: new Date() } },
    )

    return { installation: summarize({ ...row, tagsSyncedAt: null }, false), synced: false, error }
  }
}

/** Forgets one device, here and in the hub. Only its owner can. */
export async function removeInstallation(
  userId: string,
  installationId: string,
): Promise<boolean> {
  const clean = installationId.trim()
  if (!clean) throw new PushError('Which device should be removed?')

  const collection = await installations()
  const result = await collection.deleteOne({ _id: clean, userId })
  if (result.deletedCount === 0) return false

  await deleteInstallation(clean)
  return true
}

/**
 * Forgets every device this account had.
 *
 * Called when an account is deactivated: a deactivated person must stop getting
 * alerts whether or not their phone is still signed in. Reactivating does not
 * recreate them — each device re-registers the next time it is opened.
 */
export async function deleteUserInstallations(userId: string): Promise<number> {
  const collection = await installations()
  const rows = await collection.find({ userId }, { projection: { _id: 1 } }).toArray()

  for (const row of rows) {
    await deleteInstallation(row._id)
  }

  const result = await collection.deleteMany({ userId })
  return result.deletedCount
}

/**
 * Re-pushes this user's tags to every device they have.
 *
 * Called whenever `notificationTags` changes. Until this succeeds the hub still
 * routes by the old set, so this is not housekeeping: it is the moment a tag
 * change takes effect.
 */
export async function syncUserInstallations(
  userId: string,
  notificationTags: string[],
): Promise<{ updated: number; failed: number }> {
  const collection = await installations()
  const rows = await collection.find({ userId }).toArray()
  if (rows.length === 0) return { updated: 0, failed: 0 }

  const tags = installationTags(userId, notificationTags)
  const now = new Date()
  let updated = 0
  let failed = 0

  for (const row of rows) {
    try {
      if (!hubConfigured()) throw new Error('Phone notifications are not configured yet')

      await registerInstallation({
        installationId: row._id,
        userId,
        platform: row.platform,
        pushChannel: row.pushChannel,
        tags,
      })

      await collection.updateOne(
        { _id: row._id },
        { $set: { tags, tagsSyncedAt: now, updatedAt: now }, $unset: { syncError: '' } },
      )
      updated += 1
    } catch (cause) {
      const error = cause instanceof Error ? cause.message : String(cause)
      await collection.updateOne(
        { _id: row._id },
        { $set: { tags, updatedAt: now, syncError: error } },
      )
      failed += 1
    }
  }

  return { updated, failed }
}

/**
 * Retries whatever the hub refused, and forgets devices nobody has opened in a
 * long time. Both are safe to run as often as a scheduler likes.
 */
export async function reconcileInstallations(days = 90): Promise<{
  retried: number
  repaired: number
  still: number
  pruned: number
}> {
  const collection = await installations()
  const now = new Date()
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

  const pruned = await collection.deleteMany({ updatedAt: { $lt: cutoff } })

  const stale = await collection
    .find({ $or: [{ syncError: { $exists: true } }, { tagsSyncedAt: null }] })
    .toArray()

  let repaired = 0
  let still = 0

  for (const row of stale) {
    try {
      if (!hubConfigured()) throw new Error('Phone notifications are not configured')

      await registerInstallation({
        installationId: row._id,
        userId: row.userId,
        platform: row.platform,
        pushChannel: row.pushChannel,
        tags: row.tags,
      })

      await collection.updateOne(
        { _id: row._id },
        { $set: { tagsSyncedAt: now }, $unset: { syncError: '' } },
      )
      repaired += 1
    } catch (cause) {
      await collection.updateOne(
        { _id: row._id },
        { $set: { syncError: cause instanceof Error ? cause.message : String(cause) } },
      )
      still += 1
    }
  }

  return { retried: stale.length, repaired, still, pruned: pruned.deletedCount }
}

/** The devices this user has signed in on, newest first. */
export async function userInstallations(userId: string): Promise<InstallationSummary[]> {
  const collection = await installations()
  const rows = await collection.find({ userId }).sort({ updatedAt: -1 }).toArray()

  return rows.map((row) => summarize(row, !row.syncError && Boolean(row.tagsSyncedAt)))
}

/** Every device carrying any of these notification tags. Debugging aid. */
export async function countInstallationsForTags(notificationTags: string[]): Promise<number> {
  if (notificationTags.length === 0) return 0

  const collection = await installations()
  return collection.countDocuments({
    tags: { $in: notificationTags.map((tag) => `nt:${tag}`) },
  })
}
