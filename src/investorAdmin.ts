import { db } from './db.ts'

/**
 * The Investor Portal's admin data.
 *
 * v1's `lib/ip/*` server actions, moved here: who is an investor, which
 * QuickBooks equity accounts they are associated with, how that money is spread
 * across properties, and the document folders behind the portal's Files tab.
 *
 * Investor accounts live in `global.users` (where this API already reads people)
 * while the associations live in `loglady.investors`, so both are read here and
 * joined by user id — the same split v1 has.
 */

export interface AdminInvestor {
  userId: string
  firstName: string
  lastName: string
  name: string
  email: string
  active: boolean
  lastLogin: string | null
  /** QuickBooks equity account ids this investor is associated with. */
  investments: string[]
  investmentCount: number
}

export interface EquityAccount {
  id: string
  name: string
}

export interface AdminInvestment {
  account: string
  accountName: string
  locationId: string
  locationName: string
  amount: number
}

interface InvestorDocument {
  _id?: string
  userId?: string
  investments?: string[]
  createdAt?: Date
  updatedAt?: Date
}

interface InvestmentDocument {
  _id?: string
  account?: string
  name?: string
  amount?: string | number
  locationId?: string
}

interface AccountDocument {
  _id?: string
  Id?: string
  Name?: string
}

interface LocationDocument {
  _id?: string
  name?: string
  qbDepartmentName?: string
}

interface InvestorUserDocument {
  _id: string
  email?: string
  firstName?: string
  lastName?: string
  active?: boolean
  lastLogin?: Date | string
  roles?: string[]
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function sumInvestments(investments: AdminInvestment[]): number {
  return investments.reduce((total, investment) => total + investment.amount, 0)
}

/** Everyone with the investor role, with how much they are associated with. */
export async function adminInvestors(): Promise<AdminInvestor[]> {
  const global = await db('global')
  const loglady = await db('loglady')

  const [users, records] = await Promise.all([
    global.collection<InvestorUserDocument>('users').find({ roles: 'investor' }).toArray(),
    loglady.collection<InvestorDocument>('investors').find({}).toArray(),
  ])

  return users
    .map((user) => {
      const record = records.find((entry) => entry.userId === String(user._id))
      const investments = Array.isArray(record?.investments) ? record!.investments! : []
      const firstName = text(user.firstName)
      const lastName = text(user.lastName)

      return {
        userId: String(user._id),
        firstName,
        lastName,
        name: `${firstName} ${lastName}`.trim() || text(user.email) || String(user._id),
        email: text(user.email),
        active: user.active !== false,
        lastLogin: user.lastLogin ? new Date(user.lastLogin).toISOString() : null,
        investments,
        investmentCount: investments.length,
      }
    })
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** The QuickBooks equity accounts an investor can be associated with. */
export async function equityAccounts(): Promise<EquityAccount[]> {
  const loglady = await db('loglady')
  const documents = await loglady
    .collection<AccountDocument>('accounts')
    .find({ AccountType: 'Equity' })
    .toArray()

  return documents
    .map((document) => ({ id: String(document.Id ?? ''), name: String(document.Name ?? '') }))
    .filter((account) => account.id && account.name)
    .sort((left, right) => left.name.localeCompare(right.name, 'en', { numeric: true }))
}

/**
 * Associates an investor with equity accounts.
 *
 * v1 creates the `investors` row on first save rather than requiring one up
 * front, so an investor role can be granted before their money is set up.
 */
export async function setInvestorInvestments(
  userId: string,
  investments: string[],
): Promise<AdminInvestor | null> {
  const loglady = await db('loglady')
  const collection = loglady.collection<InvestorDocument>('investors')
  const existing = await collection.findOne({ userId })

  if (existing) {
    await collection.updateOne(
      { userId },
      { $set: { investments, updatedAt: new Date() } },
    )
  } else {
    await collection.insertOne({
      userId,
      investments,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
  }

  const investors = await adminInvestors()
  return investors.find((investor) => investor.userId === userId) ?? null
}

/** Every investment in the book, newest accounting data joined to its property. */
export async function adminInvestments(): Promise<AdminInvestment[]> {
  const loglady = await db('loglady')

  const [investments, accounts, locations] = await Promise.all([
    loglady
      .collection<InvestmentDocument>('entitiesInvested')
      .find({ name: { $ne: 'Opening Balance Equity' } })
      .toArray(),
    loglady.collection<AccountDocument>('accounts').find({ AccountType: 'Equity' }).toArray(),
    loglady.collection<LocationDocument>('locations').find({}).toArray(),
  ])

  return investments.map((investment) => {
    const account = accounts.find((entry) => entry.Id == investment.account)
    const location = locations.find((entry) => String(entry._id) === String(investment.locationId))
    const amount = Number(investment.amount)

    return {
      account: String(investment.account ?? ''),
      accountName: String(account?.Name ?? investment.name ?? ''),
      locationId: String(investment.locationId ?? ''),
      locationName: String(location?.qbDepartmentName ?? location?.name ?? ''),
      amount: Number.isFinite(amount) ? amount : 0,
    }
  })
}

export interface InvestorView {
  investor: AdminInvestor
  holdings: {
    locationId: string
    locationName: string
    amount: number
  }[]
  totalInvested: number
}

/**
 * What one investor holds, for the admin's read-only view.
 *
 * The arithmetic is the portal's: an investor holds the investments whose
 * QuickBooks account is one of theirs, and a property can be held through more
 * than one account, so the amounts are summed per property.
 */
export async function investorView(userId: string): Promise<InvestorView | null> {
  const investors = await adminInvestors()
  const investor = investors.find((entry) => entry.userId === userId)
  if (!investor) return null

  const investments = (await adminInvestments()).filter((investment) =>
    investor.investments.includes(investment.account),
  )

  const holdings = new Map<string, { locationId: string; locationName: string; amount: number }>()
  for (const investment of investments) {
    const key = investment.locationId || investment.account
    const existing = holdings.get(key)
    if (existing) existing.amount += investment.amount
    else {
      holdings.set(key, {
        locationId: investment.locationId,
        locationName: investment.locationName || 'Unassigned',
        amount: investment.amount,
      })
    }
  }

  return {
    investor,
    holdings: [...holdings.values()].sort((left, right) => right.amount - left.amount),
    totalInvested: sumInvestments(investments),
  }
}
