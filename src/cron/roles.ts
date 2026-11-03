import { db } from '../db.ts'

/**
 * Keeping the `investor` role in step with the investor portal's records.
 *
 * v1 had this as an unauthenticated cron route as well, and it was blunter than
 * it looks: it set `roles` to `['investor']` for anyone with an investor record
 * and to `[]` for everyone else — which would strip `administrator` from an
 * administrator and `manager` from a manager. That is not a sync, it is a reset.
 *
 * This adds the role to whoever holds an investor record and takes it away from
 * whoever no longer does, touching nothing else on the account. Running it twice
 * changes nothing the second time.
 */

interface InvestorRow {
  userId?: unknown
}

interface UserRow {
  _id: string
  roles?: string[]
}

export interface RoleSyncResult {
  granted: number
  revoked: number
  users: number
  investors: number
}

export async function refreshInvestorRoles(): Promise<RoleSyncResult> {
  const loglady = await db('loglady')
  const global = await db('global')

  const investors = await loglady.collection<InvestorRow>('investors').find({}).toArray()
  const investorIds = new Set(
    investors.map((investor) => String(investor.userId ?? '')).filter(Boolean),
  )

  const users = global.collection<UserRow>('users')
  const everyone = await users.find({}).toArray()

  let granted = 0
  let revoked = 0

  for (const user of everyone) {
    const roles = Array.isArray(user.roles)
      ? user.roles.filter((role): role is string => typeof role === 'string')
      : []
    const isInvestor = investorIds.has(String(user._id))

    if (isInvestor && !roles.includes('investor')) {
      await users.updateOne({ _id: user._id }, { $addToSet: { roles: 'investor' } })
      granted += 1
    } else if (!isInvestor && roles.includes('investor')) {
      await users.updateOne({ _id: user._id }, { $pull: { roles: 'investor' } })
      revoked += 1
    }
  }

  return {
    granted,
    revoked,
    users: everyone.length,
    investors: investorIds.size,
  }
}
