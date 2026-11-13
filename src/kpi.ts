import { db } from './db.ts'

/**
 * The KPI board.
 *
 * Facility metrics are calculated nightly by the cron into
 * `loglady.locations`: every document carries its own `statistics`,
 * `profitLoss` and `budget` block. So this is a read of one collection and a
 * little arithmetic — the same math v1's `app/kpi/prepareKpi.ts` does, minus the
 * display formatting, which belongs to the client.
 *
 * Only `kpiActive` facilities are included: the others are not operating yet.
 */

/**
 * Who may read the KPI board.
 *
 * `kpi` is the group an administrator assigns to a user; the rest keep their way
 * in, because they could read the board before the role existed.
 */
export const KPI_ROLES = ['kpi', 'administrator', 'manager', 'supervisor'] as const

export interface KpiFacility {
  id: string
  name: string
  /** Last Operations Excellence Review score. */
  oerScore: number
  occupancy: {
    storagePct: number
    parkingPct: number
    totalPct: number
    economicPct: number
    rentedUnits: number
    unrentableUnits: number
  }
  movement: {
    moveIns30d: number
    moveOuts30d: number
    overlockedUnits: number
  }
  delinquency: {
    /** Dollars owed by tenants 30+ days late. */
    amountOver30: number
    units30to60: number
    unitsOver60: number
    occupiedOver30Pct: number
  }
  revenue: {
    /** Monthly rent tied up in units that are vacant and unrentable. */
    vacantUnrentableRent: number
    concessions30d: number
    waivedRent30d: number
    waivedFees30d: number
    /** Actual rented-unit value against the month's rent budget. */
    contractedVsBudgetRentPct: number
  }
  leads: {
    reservations30d: number
    inquiries30d: number
    converted30d: number
  }
  protection: {
    autopayPct: number
    insuredPct: number
    insuranceSold30d: number
  }
  budget: {
    incomeVsBudgetPct: number
    expensesVsBudgetPct: number
    noiVsBudgetPct: number
    /** NOI against budget, in dollars (negative when behind). */
    noiVsBudgetDol: number
  }
}

interface LocationDocument {
  _id: string
  name?: string
  qbDepartmentName?: string
  oerScore?: number
  kpiActive?: boolean
  updatedAt?: Date | string
  statistics?: Record<string, number | undefined>
  profitLoss?: {
    totalIncome?: number
    totalExpense?: number
    netOperatingIncome?: number
  }
  budget?: {
    incomeTotal?: number
    expenseTotal?: number
    monthRentBudgetAmount?: number
  }
}

/** A number from Mongo, or 0 — the snapshots are full of missing fields. */
function num(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** `part` as a percentage of `whole`, rounded to two places. */
function pctOf(part: number, whole: number): number {
  if (!whole) return 0
  return round((part / whole) * 100)
}

function round(value: number): number {
  return Number(value.toFixed(2))
}

/** Actual against budget as a percentage; a zero budget is not a result. */
function againstBudget(actual: number, budget: number): number {
  if (!budget) return 0
  return round((actual / budget) * 100)
}

function facilityOf(doc: LocationDocument): KpiFacility {
  const stats = doc.statistics ?? {}
  const budget = doc.budget ?? {}
  const profitLoss = doc.profitLoss ?? {}

  const budgetNoi = num(budget.incomeTotal) - num(budget.expenseTotal)
  const noi = num(profitLoss.netOperatingIncome)

  return {
    id: String(doc._id),
    name: doc.qbDepartmentName || doc.name || 'Unnamed facility',
    oerScore: num(doc.oerScore),
    occupancy: {
      storagePct: round(num(stats.storageUnitOccupancy)),
      parkingPct: round(num(stats.parkingUnitOccupancy)),
      totalPct: round(num(stats.facilityOccupancy)),
      economicPct: round(num(stats.economicOccupancy)),
      rentedUnits: num(stats.totalRentedUnits),
      unrentableUnits: num(stats.totalUnavailableUnits),
    },
    movement: {
      moveIns30d: num(stats.moveInPrevious30Days),
      moveOuts30d: num(stats.moveOutPrevious30Days),
      overlockedUnits: num(stats.overlocks),
    },
    delinquency: {
      amountOver30: round(
        num(stats.ar3060days) + num(stats.ar6090days) + num(stats.ar90120days) + num(stats.ar120plusdays),
      ),
      units30to60: num(stats.delinquentUnitsGt30) - num(stats.delinquentUnitsGt60),
      unitsOver60: num(stats.delinquentUnitsGt60),
      occupiedOver30Pct: pctOf(num(stats.delinquentUnitsGt30), num(stats.totalRentableUnits)),
    },
    revenue: {
      vacantUnrentableRent: round(num(stats.totalUnavailableValue)),
      concessions30d: round(num(stats.concessionsLast30Days)),
      waivedRent30d: round(num(stats.waivedRentLast30Days)),
      waivedFees30d: round(num(stats.waivedFeesLast30Days)),
      contractedVsBudgetRentPct: againstBudget(
        num(stats.totalRentedUnitsValue),
        num(budget.monthRentBudgetAmount),
      ),
    },
    leads: {
      reservations30d: num(stats.reservationsLast30Days),
      inquiries30d: num(stats.inquiriesLast30Days),
      converted30d: num(stats.convertedLast30Days),
    },
    protection: {
      autopayPct: round(num(stats.autopayOccupancy)),
      insuredPct: round(num(stats.insuredOccupancy)),
      insuranceSold30d: num(stats.insuranceSoldLast30Days),
    },
    budget: {
      incomeVsBudgetPct: againstBudget(num(profitLoss.totalIncome), num(budget.incomeTotal)),
      expensesVsBudgetPct: againstBudget(num(profitLoss.totalExpense), num(budget.expenseTotal)),
      noiVsBudgetPct: againstBudget(noi, budgetNoi),
      noiVsBudgetDol: round(noi - budgetNoi),
    },
  }
}

/** Every active facility, alphabetically. */
export async function kpiFacilities(): Promise<KpiFacility[]> {
  const collection = (await db('loglady')).collection<LocationDocument>('locations')
  const docs = await collection.find({ kpiActive: true }).toArray()

  return docs
    .map(facilityOf)
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))
}
