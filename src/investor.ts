import { db } from './db.ts'

/**
 * The investor portal's data.
 *
 * This is v1's `prepareInvestor` (`inssapp/app/investor/prepareInvestor.ts`)
 * moved to the API, with the same collections and the same arithmetic. It reads
 * the investor's `investments` (QuickBooks account ids) from `investors`, joins
 * them to `entitiesInvested`, and rolls the equity, dividend and budget figures
 * up per location and then into two totals: this investor's portfolio and the
 * whole organization's.
 *
 * Numbers stay numbers here; formatting is the app's job.
 */

interface InvestmentDoc {
  locationId?: string
  account: string
  amount: string | number
  name?: string
}

interface DividendDoc {
  locationId?: string
  accountId?: string
  dividends?: { amount: string | number }[]
  totalDividendPaid?: string | number
  lastDividend?: number
}

interface NoteDoc {
  locationId?: string
  content?: string
  createdAt?: string
}

interface InvestorDoc {
  userId: string
  investments?: string[]
}

export interface InvestorEquityAccount {
  name: string
  amount: number
}

export interface InvestorLocation {
  id: string
  internalId: string
  name: string
  departmentName: string
  departmentId: string
  address: { city?: string; region?: string }
  acquisitionDate: string
  status: string
  valuationDate: string
  loanInterestRate: number
  loanMaturityDate: string
  storageSF: number
  totalArea: number
  closingCostPct: number
  issPromote: number
  propertyValue: number
  loanBalance: number
  operatingCashReserves: number
  projectedCapitalCalls: number
  budgetOccupancy: number
  occupiedAreaPct: number
  occupiedStorageSfPct: number
  occupancyPct: number
  absorption30: number
  gt30delinquent: number
  incomeVsBudgetPct: number
  expensesVsBudgetPct: number
  noiVsBudgetPct: number
  noiVsBudgetDol: number
  notes: { content: string; createdAt: string }[]
  equity: {
    initialInvestmentDol: number
    changeInEquity: number
    investorInvestedTotal: number
    investorInvestmentValueDol: number
    totalDividendsPaid: number
    lastDividendAnn: number
    lastDividendDol: number
    investorSharePct: number
    lastDividendPct: number
    pctTotalInvestment: number
    equityExposure: number
    netSalesProceeds: number
    netInvestorProceeds: number
    projectedCapitalCallsDol: number
    totalInvested: number
    cumulativeByAccount: InvestorEquityAccount[]
  }
}

export interface InvestorPortfolio {
  budgetOccupancy: number
  storageSfOcc: number
  occupiedStorageSfPct: number
  totalUnitOcc: number
  absorption30: number
  gt30delinquent: number
  incomeVsBudgetPct: number
  expensesVsBudgetPct: number
  noiVsBudgetPct: number
  noiVsBudgetDol: number
  totalDealEquity: number
  initialInvestmentDol: number
  investorSharePct: number
  investorInvestedTotal: number
  pctTotalInvestment: number
  projectedCapitalCalls: number
  propertyValue: number
  loanBalance: number
  estimatedClosingCosts: number
  netSalesProceeds: number
  issPromote: number
  netInvestorProceeds: number
  investorInvestmentValueDol: number
  equityExposure: number
  totalDividendsPaid: number
  lastDividendDol: number
  storageSF: number
  totalArea: number
}

export interface InvestorData {
  locations: InvestorLocation[]
  portfolio: InvestorPortfolio
  organizationPortfolio: InvestorPortfolio
}

export interface InvestorFile {
  id: string
  name: string
  folder: string
  blobName: string
  container: string
  createdAt: string | null
}

const num = (value: unknown): number => {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? parsed : 0
}

/** Sum that ignores missing values, so a null never poisons a total. */
const sum = <T,>(list: T[], get: (item: T) => number): number =>
  list.reduce((total, item) => total + (get(item) || 0), 0)

/** Average across entries that actually report a value, as v1 does. */
const average = <T,>(list: T[], get: (item: T) => number): number => {
  const reported = list.filter((item) => get(item))
  if (reported.length === 0) return 0
  return sum(reported, get) / reported.length
}

/** The `investors` row for a user, or null when they have no portal access. */
async function investorFor(userId: string): Promise<InvestorDoc | null> {
  const loglady = await db('loglady')
  return loglady.collection<InvestorDoc>('investors').findOne({ userId })
}

/**
 * Every investment row except the opening-balance equity line, which is an
 * accounting artefact rather than money anyone put in. v1 excludes it too.
 */
async function allInvestments(): Promise<InvestmentDoc[]> {
  const loglady = await db('loglady')
  const rows = await loglady
    .collection<InvestmentDoc>('entitiesInvested')
    .find({ name: { $ne: 'Opening Balance Equity' } })
    .toArray()

  return rows.map((row) => ({
    locationId: row.locationId,
    account: row.account,
    amount: row.amount,
    name: row.name,
  }))
}

/**
 * GET /api/mobile/investor
 *
 * Success: { locations, portfolio, organizationPortfolio }
 *
 * `locations` is only the properties this investor holds equity in — v1's
 * snapshot and report both work from that subset. `organizationPortfolio` is the
 * comparison column, built from every active location.
 */
export async function investorData(userId: string): Promise<InvestorData | null> {
  const investor = await investorFor(userId)
  if (!investor) return null

  const loglady = await db('loglady')
  const investmentsForInvestor = (await allInvestments()).filter((investment) =>
    (investor.investments ?? []).includes(investment.account),
  )
  const investmentIds = investmentsForInvestor.map((investment) => investment.account)
  const locationIds = investmentsForInvestor
    .map((investment) => investment.locationId)
    .filter((id): id is string => Boolean(id))
  // Every account's money in the properties this investor holds a piece of — the
  // denominator of their share of a deal, and of their portfolio column. v1
  // scopes it to those locations; the organization column uses the whole book.
  const everyInvestment = await allInvestments()
  const portfolioInvestments = everyInvestment.filter((investment) =>
    locationIds.includes(investment.locationId ?? ''),
  )

  const dividends = await loglady
    .collection<DividendDoc>('dividends')
    .find({})
    .toArray()
    .then((rows) =>
      rows.map((row) => ({
        ...row,
        lastDividend: row.dividends?.length ? num(row.dividends[row.dividends.length - 1]?.amount) : 0,
      })),
    )

  const locations = await loglady
    .collection('locations')
    .find({ status: { $ne: 'Inactive' } })
    .toArray()

  const notes = await loglady
    .collection<NoteDoc>('ipLocationNotes')
    .find({ locationId: { $in: locationIds } })
    .toArray()

  // The denominator for a location's share of this investor's money.
  const investorInvested = sum(investmentsForInvestor, (investment) => num(investment.amount))

  const cleanLocations: InvestorLocation[] = []

  for (const location of locations) {
    const statistics = (location.statistics ?? {}) as Record<string, number>
    const id = String(location._id)
    const locationNotes = notes
      .filter((note) => note.locationId === id)
      .map((note) => ({
        content: String(note.content ?? ''),
        createdAt: note.createdAt ? new Date(note.createdAt).toISOString() : '',
      }))

    const locationInvestments = investmentsForInvestor.filter(
      (investment) => investment.locationId === id,
    )

    const investmentsByAccount: InvestmentDoc[] = []
    for (const investment of locationInvestments) {
      if (!investmentsByAccount.find((entry) => entry.account === investment.account)) {
        investmentsByAccount.push(investment)
      }
    }
    const initialDol = sum(investmentsByAccount, (investment) => num(investment.amount))

    const locationDividends = dividends.filter((dividend) => dividend.locationId === id)
    const investorDividends = locationDividends.filter(
      (dividend) => dividend.accountId && investmentIds.includes(dividend.accountId),
    )

    let lastDividendAmount = 0
    for (const dividend of investorDividends) {
      if (dividend.dividends?.length) {
        lastDividendAmount += num(dividend.dividends[dividend.dividends.length - 1]?.amount)
      }
    }

    const investedTotal = sum(locationInvestments, (investment) => num(investment.amount))
    const totalDividendsPaid = sum(investorDividends, (dividend) => num(dividend.totalDividendPaid))
    const lastDividendPct = investedTotal ? (lastDividendAmount / investedTotal) * 100 : 0
    const lastDividendAnnualizedPct = investedTotal
      ? ((lastDividendAmount * 4) / investedTotal) * 100
      : 0

    const cumulativeByAccount: InvestorEquityAccount[] = []
    for (const investment of locationInvestments) {
      const existing = cumulativeByAccount.find((entry) => entry.name === investment.name)
      if (existing) {
        existing.amount += num(investment.amount)
      } else {
        cumulativeByAccount.push({
          name: String(investment.name ?? investment.account),
          amount: num(investment.amount),
        })
      }
    }

    const allEquityAtLocation = portfolioInvestments.filter(
      (investment) => investment.locationId === id,
    )

    const propertyValue = num(location.propertyValue)
    const cashReserves = num(location.operatingCashReserves)
    const loanBalance = num(location.loanBalance)
    const closingCostPct = num(location.closingCostPct)
    const issPromote = num(location.issPromote)

    const netSalesProceeds =
      propertyValue + cashReserves - loanBalance - propertyValue * (closingCostPct / 100)
    const netInvestorProceeds = Math.max(0, netSalesProceeds) - issPromote

    const totalDealEquity = sum(allEquityAtLocation, (investment) => num(investment.amount))
    const investorSharePct = totalDealEquity ? (investedTotal / totalDealEquity) * 100 : 0
    const investorInvestmentValueDol = (Math.max(0, netInvestorProceeds) * Math.max(0, investorSharePct)) / 100

    const equityExposure = investedTotal - totalDividendsPaid

    cleanLocations.push({
      id,
      internalId: String(location.internalId ?? ''),
      name: String(location.name ?? ''),
      departmentName: String(location.qbDepartmentName ?? ''),
      departmentId: String(location.qbDepartmentId ?? ''),
      address: {
        city: location.address?.city,
        region: location.address?.region,
      },
      acquisitionDate: location.acquisitionDate ?? '',
      status: String(location.status ?? ''),
      valuationDate: location.valuationDate ?? '',
      loanInterestRate: num(location.loanInterestRate),
      loanMaturityDate: location.loanMaturityDate ?? '',
      storageSF: num(statistics.totalStorageSf),
      totalArea: num(statistics.totalFacilitySf),
      closingCostPct,
      issPromote,
      propertyValue,
      loanBalance,
      operatingCashReserves: cashReserves,
      projectedCapitalCalls: num(location.projectedCapitalCalls),
      budgetOccupancy: num(location.budgetOccupancy),
      occupiedAreaPct: num(statistics.facilitySfOccupancy),
      occupiedStorageSfPct: num(statistics.storageSfOccupancy),
      occupancyPct: num(statistics.facilityAvailableUnitOccupancy),
      absorption30: num(
        ((num(statistics.moveInPrevious30Days) - num(statistics.moveOutPrevious30Days)) /
          (num(statistics.totalRentableUnits) || 1)) *
          100,
      ),
      gt30delinquent: num(
        (num(statistics.delinquentUnitsGt30) / (num(statistics.totalUnits) || 1)) * 100,
      ),
      incomeVsBudgetPct: num(
        (num(location.profitLoss?.totalIncome) / (num(location.budget?.incomeTotal) || 1)) * 100,
      ),
      expensesVsBudgetPct: num(
        (num(location.profitLoss?.totalExpense) / (num(location.budget?.expenseTotal) || 1)) * 100,
      ),
      noiVsBudgetPct: num(
        (num(location.profitLoss?.netOperatingIncome) /
          (num(location.budget?.incomeTotal) - num(location.budget?.expenseTotal) || 1)) *
          100,
      ),
      noiVsBudgetDol: num(
        num(location.profitLoss?.totalIncome) -
          num(location.budget?.incomeTotal) -
          (num(location.profitLoss?.totalExpense) - num(location.budget?.expenseTotal)),
      ),
      notes: locationNotes,
      equity: {
        initialInvestmentDol: initialDol,
        changeInEquity: investedTotal - initialDol,
        investorInvestedTotal: investedTotal,
        investorInvestmentValueDol,
        totalDividendsPaid,
        lastDividendAnn: lastDividendAnnualizedPct,
        lastDividendDol: lastDividendAmount,
        lastDividendPct,
        investorSharePct,
        pctTotalInvestment: investorInvested ? (investedTotal / investorInvested) * 100 : 0,
        equityExposure,
        netSalesProceeds,
        netInvestorProceeds,
        projectedCapitalCallsDol:
          num(location.projectedCapitalCalls) * (investorSharePct > 0 ? investorSharePct / 100 : 0),
        totalInvested: totalDealEquity,
        cumulativeByAccount,
      },
    })
  }

  const portfolioLocations = cleanLocations.filter((location) => locationIds.includes(location.id))
  const portfolioInvested = sum(portfolioInvestments, (investment) => num(investment.amount))
  const organizationInvested = sum(everyInvestment, (investment) => num(investment.amount))

  const portfolio: InvestorPortfolio = {
    budgetOccupancy: average(portfolioLocations, (location) => location.budgetOccupancy),
    storageSfOcc: Number(average(portfolioLocations, (location) => location.occupiedAreaPct).toFixed(2)),
    occupiedStorageSfPct: average(portfolioLocations, (location) => location.occupiedStorageSfPct),
    totalUnitOcc: Number(average(portfolioLocations, (location) => location.occupancyPct).toFixed(2)),
    absorption30: Number(average(portfolioLocations, (location) => location.absorption30).toFixed(2)),
    gt30delinquent: Number(average(portfolioLocations, (location) => location.gt30delinquent).toFixed(2)),
    incomeVsBudgetPct: Number(
      average(portfolioLocations, (location) => location.incomeVsBudgetPct).toFixed(2),
    ),
    expensesVsBudgetPct: Number(
      average(portfolioLocations, (location) => location.expensesVsBudgetPct).toFixed(2),
    ),
    noiVsBudgetPct: Number(average(portfolioLocations, (location) => location.noiVsBudgetPct).toFixed(2)),
    noiVsBudgetDol: Number(average(portfolioLocations, (location) => location.noiVsBudgetDol).toFixed(2)),
    totalDealEquity: sum(portfolioLocations, (location) => location.equity.totalInvested),
    initialInvestmentDol: sum(portfolioLocations, (location) => location.equity.initialInvestmentDol),
    // The investor's share across everything they hold, against the same
    // properties' deal equity — v1's portfolio column.
    investorSharePct: portfolioInvested ? Number(((investorInvested / portfolioInvested) * 100).toFixed(2)) : 0,
    investorInvestedTotal: Number(investorInvested.toFixed(2)),
    pctTotalInvestment: 100,
    projectedCapitalCalls: sum(portfolioLocations, (location) => location.projectedCapitalCalls),
    propertyValue: sum(portfolioLocations, (location) => location.propertyValue),
    loanBalance: sum(portfolioLocations, (location) => location.loanBalance),
    estimatedClosingCosts: sum(
      portfolioLocations,
      (location) => location.propertyValue * (location.closingCostPct / 100),
    ),
    netSalesProceeds: sum(portfolioLocations, (location) => location.equity.netSalesProceeds),
    issPromote: sum(portfolioLocations, (location) => location.issPromote),
    netInvestorProceeds: sum(portfolioLocations, (location) => location.equity.netInvestorProceeds),
    investorInvestmentValueDol: sum(
      portfolioLocations,
      (location) => location.equity.investorInvestmentValueDol,
    ),
    equityExposure: sum(portfolioLocations, (location) => location.equity.equityExposure),
    totalDividendsPaid: sum(portfolioLocations, (location) => location.equity.totalDividendsPaid),
    lastDividendDol: sum(portfolioLocations, (location) => location.equity.lastDividendDol),
    storageSF: sum(portfolioLocations, (location) => location.storageSF),
    totalArea: sum(portfolioLocations, (location) => location.totalArea),
  }

  const organizationPortfolio: InvestorPortfolio = {
    budgetOccupancy: average(cleanLocations, (location) => location.budgetOccupancy),
    storageSfOcc: Number(average(cleanLocations, (location) => location.occupiedStorageSfPct).toFixed(2)),
    occupiedStorageSfPct: average(cleanLocations, (location) => location.occupiedStorageSfPct),
    totalUnitOcc: Number(average(cleanLocations, (location) => location.occupancyPct).toFixed(2)),
    absorption30: Number(average(cleanLocations, (location) => location.absorption30).toFixed(2)),
    gt30delinquent: Number(average(cleanLocations, (location) => location.gt30delinquent).toFixed(2)),
    incomeVsBudgetPct: Number(average(cleanLocations, (location) => location.incomeVsBudgetPct).toFixed(2)),
    expensesVsBudgetPct: Number(
      average(cleanLocations, (location) => location.expensesVsBudgetPct).toFixed(2),
    ),
    noiVsBudgetPct: Number(average(cleanLocations, (location) => location.noiVsBudgetPct).toFixed(2)),
    noiVsBudgetDol: Number(average(cleanLocations, (location) => location.noiVsBudgetDol).toFixed(2)),
    totalDealEquity: sum(cleanLocations, (location) => location.equity.totalInvested),
    initialInvestmentDol: portfolio.initialInvestmentDol,
    // Organization-wide: this investor's money against every deal in the book.
    investorSharePct: organizationInvested
      ? Number(((investorInvested / organizationInvested) * 100).toFixed(2))
      : 0,
    investorInvestedTotal: Number(investorInvested.toFixed(2)),
    pctTotalInvestment: 100,
    projectedCapitalCalls: sum(cleanLocations, (location) => location.projectedCapitalCalls),
    propertyValue: sum(cleanLocations, (location) => location.propertyValue),
    loanBalance: sum(cleanLocations, (location) => location.loanBalance),
    estimatedClosingCosts: sum(
      cleanLocations,
      (location) => location.propertyValue * (location.closingCostPct / 100),
    ),
    netSalesProceeds: sum(cleanLocations, (location) => location.equity.netSalesProceeds),
    issPromote: sum(cleanLocations, (location) => location.issPromote),
    netInvestorProceeds: sum(cleanLocations, (location) => location.equity.netInvestorProceeds),
    investorInvestmentValueDol: sum(cleanLocations, (location) => location.equity.investorInvestmentValueDol),
    equityExposure: sum(cleanLocations, (location) => location.equity.equityExposure),
    totalDividendsPaid: sum(cleanLocations, (location) => location.equity.totalDividendsPaid),
    lastDividendDol: sum(cleanLocations, (location) => location.equity.lastDividendDol),
    storageSF: sum(cleanLocations, (location) => location.storageSF),
    totalArea: sum(cleanLocations, (location) => location.totalArea),
  }

  return { locations: portfolioLocations, portfolio, organizationPortfolio }
}

/**
 * GET /api/mobile/investor/files
 *
 * The documents this investor may read: those attached to a property they hold
 * equity in, those addressed to them personally, and anything published to every
 * investor. Same query as v1's `initInvestorFiles`.
 */
export async function investorFiles(userId: string): Promise<InvestorFile[] | null> {
  const investor = await investorFor(userId)
  if (!investor) return null

  const loglady = await db('loglady')
  const investments = await loglady
    .collection<InvestmentDoc>('entitiesInvested')
    .find({ account: { $in: investor.investments ?? [] } })
    .toArray()

  const locationIds = investments
    .map((investment) => investment.locationId)
    .filter((id): id is string => Boolean(id))

  const files = await loglady
    .collection('files')
    .find({
      $or: [
        { locationId: { $in: locationIds } },
        { investorId: userId },
        { audience: 'allInvestors' },
      ],
    })
    .toArray()

  return files
    .map((file) => ({
      id: String(file._id),
      name: String(file.name ?? file.fileName ?? ''),
      folder: String(file.folderName ?? 'Files'),
      blobName: String(file.blobName ?? ''),
      container: String(file.container ?? ''),
      createdAt: file.createdAt ? new Date(file.createdAt).toISOString() : null,
    }))
    .sort((left, right) => {
      const byFolder = left.folder.localeCompare(right.folder);
      if (byFolder !== 0) return byFolder;
      return left.name.localeCompare(right.name, 'en', { numeric: true });
    })
}

/** One file the investor may read, for signing its URL. */
export async function investorFile(userId: string, fileId: string): Promise<InvestorFile | null> {
  const files = await investorFiles(userId)
  return files?.find((file) => file.id === fileId) ?? null
}
