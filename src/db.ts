import { MongoClient, type Db } from 'mongodb'

import { requireEnv } from './env.ts'

/**
 * The one Mongo connection.
 *
 * The client is created on first use rather than at import time, so the process
 * can start (and fail with a readable message) before the database is needed,
 * and so a dev server restart does not open a second pool.
 */
let clientPromise: Promise<MongoClient> | null = null

export function mongo(): Promise<MongoClient> {
  if (!clientPromise) {
    const client = new MongoClient(requireEnv('MONGODB_URI'))
    clientPromise = client.connect()
  }
  return clientPromise
}

/**
 * A database on the shared cluster. `global` holds users and app state;
 * `loglady` holds the facility data the nightly cron writes.
 */
export async function db(name = 'global'): Promise<Db> {
  return (await mongo()).db(name)
}
