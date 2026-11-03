import { db } from '../db.ts'
import { query, report } from '../quickbooks/api.ts'

/**
 * The QuickBooks half of the nightly refresh.
 *
 * This is v1's `app/cron/updateData/quickbooks` route, which ran as a Vercel
 * cron. The website is not going to production, so the work lives here and a
 * scheduler calls `GET /api/cron/quickbooks`. Every step writes the collection
 * and field names the app already reads:
 *
 *   quickbooksDepartments  the departments a property can be linked to
 *   accounts               the chart of accounts, plus the vendor each equity
 *                          account pays dividends through
 *   locations.budget       income/expense and rent budget for the month
 *   locations.loanBalance  long-term liabilities on that property's balance sheet
 *   locations.profitLoss   year-to-date P&L for the property's department
 *   entitiesInvested       equity each entity holds in each property
 *   dividends              member dividends paid, per property and account
 *
 * Calls go through `quickbooks/api.ts`, so the token is refreshed when it is
 * nearly out and the company id always comes from the stored connection.
 *
 * Two v1 behaviours are deliberately dropped, both because they destroyed data
 * rather than computing it:
 *
 *  - a property with no linked QuickBooks department used to be sent a report
 *    URL containing `department=undefined`; the call failed, and the empty
 *    result was still written over its `profitLoss`. Those properties are now
 *    skipped.
 *  - an empty QuickBooks answer used to wipe a collection wholesale. A wipe now
 *    only happens when something was actually read.
 */

/** QuickBooks hands every number back as a string, and every row as `ColData`. */
interface ColData {
  value?: unknown
  id?: unknown
}

interface ReportRow {
  Header?: { ColData?: ColData[] }
  Summary?: { ColData?: ColData[] }
  ColData?: ColData[]
  Rows?: { Row?: ReportRow[] }
}

interface ReportShape {
  Rows?: { Row?: ReportRow[] }
}

interface DepartmentRow {
  Id?: string
  Name?: string
}

interface AccountRow {
  Id?: string
  Name?: string
  AccountType?: string
  [key: string]: unknown
}

interface BudgetDetailRow {
  BudgetDate?: string
  Amount?: unknown
  AccountRef?: { value?: string; name?: string }
  DepartmentRef?: { value?: string; name?: string }
}

interface BudgetRow {
  StartDate?: string
  BudgetDetail?: BudgetDetailRow[]
}

interface LocationRow {
  _id: string
  name?: string
  qbDepartmentId?: string
  qbDepartmentName?: string
}

/** v1's "Member Dividend" account in the chart of accounts. */
const DIVIDEND_ACCOUNT_ID = '88'

function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

function round(value: number): number {
  return Number(value.toFixed(2))
}

/** `YYYY-MM-01` for the month `date` falls in. */
function monthStart(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`
}

/** A name going into a QuickBooks `where` clause. */
function escapeSql(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

/** The first row whose header names `label` — how a QuickBooks report groups. */
function findGroup(rows: ReportRow[] | undefined, label: string): ReportRow | null {
  for (const row of rows ?? []) {
    if (row.Header?.ColData?.some((column) => column.value === label)) return row
  }
  return null
}

/**
 * Departments.
 *
 * The property forms read this to link a property to its department, and the
 * dividend and P&L steps below key off the link.
 */
export async function refreshDepartments(): Promise<{ departments: number }> {
  const departments = await query<DepartmentRow>('select * from Department')

  // Nothing read means nothing to say about departments: keep what is stored
  // rather than emptying the picker on a bad answer.
  if (departments.length === 0) return { departments: 0 }

  const loglady = await db('loglady')
  const collection = loglady.collection<DepartmentRow>('quickbooksDepartments')
  await collection.deleteMany({})
  await collection.insertMany(departments)

  return { departments: departments.length }
}

/**
 * The chart of accounts, and the vendor behind each account.
 *
 * `vendorId` is what ties an equity account to the member it pays, which the
 * dividends step needs; QuickBooks does not put it on the account, so it is
 * looked up by display name.
 */
export async function refreshAccounts(): Promise<{ accounts: number; vendorsLinked: number }> {
  const accounts = await query<AccountRow>('select * from Account MAXRESULTS 1000')
  const loglady = await db('loglady')
  const collection = loglady.collection('accounts')

  for (const account of accounts) {
    if (!account.Id) continue
    await collection.updateOne({ Id: account.Id }, { $set: account }, { upsert: true })
  }

  const unresolved = await collection.find({ vendorId: { $exists: false } }).toArray()
  const looked = new Map<string, string | null>()
  let vendorsLinked = 0

  for (const account of unresolved) {
    const name = str(account.Name)
    if (!name) continue

    // Accounts that share a name share a vendor; ask once.
    if (!looked.has(name)) {
      const vendors = await query<{ Id?: string }>(
        `select * from Vendor where DisplayName = '${escapeSql(name)}'`,
      )
      looked.set(name, vendors[0]?.Id ?? null)
    }

    const vendorId = looked.get(name)
    if (!vendorId) continue

    await collection.updateOne({ Id: account.Id }, { $set: { vendorId } })
    vendorsLinked += 1
  }

  return { accounts: accounts.length, vendorsLinked }
}

/**
 * Budgets, per property.
 *
 * Two things come out of one budget pull: the current month's rent budget (for
 * the KPI board's contracted-vs-budget column) and the income and expense
 * budget through the last reported month (for the budget comparisons on both the
 * KPI board and the investor portal).
 *
 * The month the totals run to is v1's rule: the month before the 15th is the
 * reporting month, so after the 15th it is the current month and before it the
 * previous one. In January that lands in the prior year's budget.
 *
 * v1 took the prior-year budget from `Budget[0]` and the current year from
 * `Budget[1]`. The year is read from `StartDate` instead, so the numbers do not
 * depend on the order Intuit happens to return them in.
 */
export async function refreshBudget(): Promise<{
  locations: number
  updated: number
  budgets: number
}> {
  const loglady = await db('loglady')
  const locations = loglady.collection<LocationRow>('locations')
  const today = new Date()

  const budgets = await query<BudgetRow>(
    `select * from Budget where StartDate >= '${today.getFullYear() - 1}-01-01'`,
  )
  const active = await locations
    .find({ active: true })
    .project({ _id: 1, qbDepartmentName: 1 })
    .toArray()

  if (budgets.length === 0) return { locations: active.length, updated: 0, budgets: 0 }

  const sorted = [...budgets].sort((left, right) =>
    str(left.StartDate).localeCompare(str(right.StartDate)),
  )
  const budgetForYear = (year: number) =>
    sorted.find((budget) => str(budget.StartDate).slice(0, 4) === String(year)) ?? null

  const currentBudget =
    budgetForYear(today.getFullYear()) ?? sorted[sorted.length - 1] ?? null
  const priorBudget = budgetForYear(today.getFullYear() - 1) ?? sorted[0] ?? null

  const accounts = await loglady.collection('accounts').find({}).toArray()
  const accountType = new Map(accounts.map((account) => [str(account.Id), str(account.AccountType)]))
  const thisMonth = monthStart(today)

  let updated = 0

  for (const location of active) {
    const department = str(location.qbDepartmentName)
    if (!department) continue

    const set: Record<string, unknown> = {}

    const rentBudget = (currentBudget?.BudgetDetail ?? []).find(
      (detail) =>
        str(detail.BudgetDate) === thisMonth &&
        str(detail.AccountRef?.name) === 'Storage/Parking Rent' &&
        str(detail.DepartmentRef?.name) === department,
    )
    if (rentBudget) {
      set['budget.monthRentBudgetAmount'] = num(rentBudget.Amount)
      set['budget.monthRentBudgetPeriod'] = thisMonth
    }

    const day = today.getDate()
    let endMonth = today.getMonth()
    let endYear = today.getFullYear()
    if (day <= 15) endMonth -= 1

    let totalsBudget = currentBudget
    if (endMonth < 0) {
      endMonth = 11
      endYear -= 1
      totalsBudget = priorBudget
    }
    const through = monthStart(new Date(endYear, endMonth, 1))

    const details = (totalsBudget?.BudgetDetail ?? []).filter(
      (detail) =>
        str(detail.DepartmentRef?.name) === department &&
        new Date(str(detail.BudgetDate)) <= new Date(through),
    )

    if (details.length > 0) {
      let income = 0
      let expense = 0
      for (const detail of details) {
        const type = accountType.get(str(detail.AccountRef?.value))
        if (type === 'Income') income += num(detail.Amount)
        else if (type === 'Expense') expense += num(detail.Amount)
      }
      set['budget.budgetThrough'] = through
      set['budget.incomeTotal'] = round(income)
      set['budget.expenseTotal'] = round(expense)
    }

    if (Object.keys(set).length === 0) continue

    await locations.updateOne({ _id: location._id }, { $set: set })
    updated += 1
  }

  return { locations: active.length, updated, budgets: budgets.length }
}

/**
 * Long-term liabilities, per property.
 *
 * One balance sheet per linked property; the investor portal shows this as the
 * loan balance against the property's value.
 */
export async function refreshLoanBalances(): Promise<{ updated: number }> {
  const loglady = await db('loglady')
  const locations = loglady.collection<LocationRow>('locations')
  const linked = await locations
    .find({ active: true, qbDepartmentId: { $exists: true } })
    .project({ _id: 1, qbDepartmentId: 1 })
    .toArray()

  let updated = 0

  for (const location of linked) {
    const department = str(location.qbDepartmentId)
    if (!department) continue

    const sheet = await report<ReportShape>('BalanceSheet', {
      date_macro: 'all',
      department,
    })

    const equityGroup = findGroup(sheet.Rows?.Row, 'LIABILITIES AND EQUITY')
    const liabilities = findGroup(equityGroup?.Rows?.Row, 'Liabilities')
    const longTerm = findGroup(liabilities?.Rows?.Row, 'Long-Term Liabilities')

    const columns = longTerm?.Summary?.ColData
    if (!columns || columns.length !== 2) continue

    await locations.updateOne(
      { _id: location._id },
      { $set: { loanBalance: num(columns[1]?.value) } },
    )
    updated += 1
  }

  return { updated }
}

/**
 * Equity held in each property, by account.
 *
 * The investor portal uses these rows for the allocation split and to work out
 * an investor's share of a property. v1 replaced the whole collection, which is
 * right — a closed entity should disappear — but only when it read something.
 */
export async function refreshEntitiesInvested(): Promise<{
  locations: number
  entities: number
}> {
  const loglady = await db('loglady')
  const locations = loglady.collection<LocationRow>('locations')
  const entities = loglady.collection('entitiesInvested')

  const linked = await locations
    .find({ active: true, qbDepartmentId: { $exists: true } })
    .project({ _id: 1, qbDepartmentId: 1 })
    .toArray()

  const rows: Record<string, unknown>[] = []
  for (const location of linked) {
    const department = str(location.qbDepartmentId)
    if (!department) continue

    const ledger = await report<ReportShape>('GeneralLedger', {
      date_macro: 'all',
      department,
      account_type: 'Equity',
      columns: 'account_name,subt_nat_amount',
    })

    for (const group of ledger.Rows?.Row ?? []) {
      for (const row of group.Rows?.Row ?? []) {
        const account = str(row.ColData?.[0]?.id)
        if (!account) continue

        rows.push({
          locationId: location._id,
          account,
          amount: num(row.ColData?.[1]?.value),
          name: str(row.ColData?.[0]?.value),
          modified: new Date(),
        })
      }
    }
  }

  if (rows.length === 0) return { locations: linked.length, entities: 0 }

  await entities.deleteMany({})
  await entities.insertMany(rows)

  return { locations: linked.length, entities: rows.length }
}

/**
 * Member dividends, per property and equity account.
 *
 * A detail P&L filtered to the dividend account, the account's vendor and the
 * property's department; the group's summary is the total paid and its rows are
 * the payments. Only an account that actually holds equity in the property is
 * asked about, which is what the `entitiesInvested` step above is for.
 */
export async function refreshDividends(): Promise<{ written: number; read: number }> {
  const loglady = await db('loglady')
  const locations = loglady.collection<LocationRow>('locations')
  const dividends = loglady.collection('dividends')

  const linked = await locations
    .find({ active: true, qbDepartmentId: { $exists: true } })
    .project({ _id: 1, qbDepartmentId: 1 })
    .toArray()

  const accounts = await loglady
    .collection('accounts')
    .find({ Active: true, AccountType: 'Equity', vendorId: { $exists: true } })
    .toArray()
  const entities = await loglady.collection('entitiesInvested').find({}).toArray()

  let written = 0
  let read = 0

  for (const location of linked) {
    const department = str(location.qbDepartmentId)
    if (!department) continue

    for (const account of accounts) {
      const holds = entities.some(
        (entity) =>
          str(entity.locationId) === location._id && str(entity.account) === str(account.Id),
      )
      if (!holds) continue

      read += 1

      const detail = await report<ReportShape>('ProfitAndLossDetail', {
        date_macro: 'all',
        account: DIVIDEND_ACCOUNT_ID,
        vendor: str(account.vendorId),
        department,
        columns: 'tx_date,name,subt_nat_amount,dept_name',
      })

      // The report nests group → account → transactions. Anything else is a
      // reply shape this does not understand, and is left alone rather than
      // written as a zero.
      const top = detail.Rows?.Row ?? []
      const accountRows = top.length === 1 ? (top[0].Rows?.Row ?? []) : []
      const transactionRows = accountRows.length === 1 ? (accountRows[0].Rows?.Row ?? []) : []
      if (transactionRows.length !== 1) continue

      const row = transactionRows[0]
      const update: {
        totalDividendPaid?: number
        dividends?: { paidDate: string; amount: number }[]
      } = {}

      if (str(row.Summary?.ColData?.[0]?.value) === 'Total for Member Dividend') {
        update.totalDividendPaid = num(row.Summary?.ColData?.[2]?.value)
      }

      const payments = row.Rows?.Row ?? []
      if (payments.length > 0) {
        update.dividends = payments.map((payment) => ({
          paidDate: str(payment.ColData?.[0]?.value),
          amount: num(payment.ColData?.[3]?.value),
        }))
      }

      if (Object.keys(update).length === 0) continue

      const match = { locationId: location._id, accountId: str(account.Id) }
      const existing = await dividends.findOne(match)

      if (existing) {
        await dividends.updateOne(match, { $set: { ...update, modified: new Date() } })
      } else {
        await dividends.insertOne({ ...match, ...update, created: new Date() })
      }
      written += 1
    }
  }

  return { written, read }
}

/**
 * Year-to-date profit and loss, per property.
 *
 * The window is v1's: from January 1st to the end of the last complete month,
 * with a two-month cushion early in the month so QuickBooks has closed the
 * books. Expense rows are kept as QuickBooks groups them, because the investor
 * report prints those headings.
 */
export async function refreshProfitLoss(): Promise<{ locations: number; written: number }> {
  const loglady = await db('loglady')
  const locations = loglady.collection<LocationRow>('locations')

  const linked = await locations
    .find({ active: true, qbDepartmentId: { $exists: true } })
    .project({ _id: 1, qbDepartmentId: 1 })
    .toArray()

  const today = new Date()
  let endMonth = today.getMonth()
  let endYear = today.getFullYear()

  if (today.getDate() > 15) endMonth -= 1
  else endMonth -= 2

  while (endMonth < 0) {
    endMonth += 12
    endYear -= 1
  }

  // Day 0 of the next month is the last day of this one.
  const endDay = new Date(endYear, endMonth + 1, 0).getDate()
  const startDate = `${endYear}-01-01`
  const endDate = `${endYear}-${String(endMonth + 1).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`

  let written = 0

  for (const location of linked) {
    const department = str(location.qbDepartmentId)
    if (!department) continue

    const profitLoss = {
      reportStart: startDate,
      reportEnd: endDate,
      incomeAccounts: [] as { name: string; accountId?: string; amount: number }[],
      expenseAccounts: [] as { name: string; accountId?: string; amount: number }[],
      otherSummary: {} as Record<string, number>,
      totalIncome: 0,
      totalExpense: 0,
      netIncome: undefined as number | undefined,
      netOperatingIncome: undefined as number | undefined,
    }

    const payload = await report<ReportShape>('ProfitAndLoss', {
      start_date: startDate,
      end_date: endDate,
      department,
    })

    // No rows is a failed report, not a property with no money moving.
    const rows = payload.Rows?.Row
    if (!Array.isArray(rows)) continue

    for (const row of rows) {
      const heading = str(row.Header?.ColData?.[0]?.value)

      if (heading === 'Income') {
        profitLoss.totalIncome = num(row.Summary?.ColData?.[1]?.value)
        for (const income of row.Rows?.Row ?? []) {
          // Income accounts sit at one level; keep the ones with a name and an
          // amount, as v1 did.
          const columns = income.ColData
          if (!columns || columns.length !== 2) continue
          profitLoss.incomeAccounts.push({
            name: str(columns[0]?.value),
            accountId: str(columns[0]?.id) || undefined,
            amount: num(columns[1]?.value),
          })
        }
        continue
      }

      if (heading === 'Expenses') {
        profitLoss.totalExpense = num(row.Summary?.ColData?.[1]?.value)
        for (const expense of row.Rows?.Row ?? []) {
          // Expenses are subgroups with their own summary, which is what the
          // report prints as a heading.
          const header = expense.Header?.ColData
          if (!header || header.length !== 2) continue
          profitLoss.expenseAccounts.push({
            name: str(header[0]?.value),
            accountId: str(header[0]?.id) || undefined,
            amount: num(expense.Summary?.ColData?.[1]?.value),
          })
        }
        continue
      }

      const summary = row.Summary?.ColData
      if (summary && summary.length === 2 && str(summary[0]?.value)) {
        profitLoss.otherSummary[str(summary[0]?.value)] = num(summary[1]?.value)
      }
    }

    const netIncome = profitLoss.otherSummary['Net Income']
    if (netIncome) profitLoss.netIncome = netIncome

    const netOperatingIncome = profitLoss.otherSummary['Net Operating Income']
    if (netOperatingIncome) profitLoss.netOperatingIncome = netOperatingIncome

    await locations.updateOne({ _id: location._id }, { $set: { profitLoss } })
    written += 1
  }

  return { locations: linked.length, written }
}
