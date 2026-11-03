import { investorData } from './investor.ts'
import { QuickBooksError } from './quickbooks/api.ts'
import {
  ReportError,
  budgetVsActualReport,
  isReportKind,
  profitLossReport,
  resolveRange,
  type ReportDocument,
} from './quickbooks/reports.ts'

/**
 * One QuickBooks report for one property in one investor's portfolio.
 *
 * The report belongs to a portfolio, not to a person: the property is looked up
 * in that investor's holdings first, which is what keeps a property they do not
 * hold equity in a 404 rather than a window into someone else's books. Both the
 * portal's route and the admin preview go through here, so the two can never
 * disagree about which properties exist or which window is the default.
 *
 * Failures come back as a value rather than an exception: the caller decides how
 * to shape the HTTP reply, and the two routes were already duplicating the
 * mapping from `ReportError` and `QuickBooksError` to a status.
 */
export type InvestorReport =
  | { report: ReportDocument }
  | { error: string; status: 400 | 401 | 404 | 409 | 502 }

export async function investorReport(
  userId: string,
  locationId: string,
  kind: string,
  range: { start?: string; end?: string },
): Promise<InvestorReport> {
  if (!isReportKind(kind)) return { error: 'That report does not exist', status: 404 }

  const data = await investorData(userId)
  if (!data) return { error: 'No investor record is linked to this account', status: 404 }

  const location = data.locations.find((entry) => entry.id === locationId)
  if (!location) return { error: 'That property is not in this portfolio', status: 404 }

  try {
    const window = resolveRange(kind, { start: range.start, end: range.end })

    return {
      report:
        kind === 'profit-loss'
          ? await profitLossReport(location, window)
          : await budgetVsActualReport(location, window),
    }
  } catch (cause) {
    if (cause instanceof ReportError) return { error: cause.message, status: cause.status }
    if (cause instanceof QuickBooksError) return { error: cause.message, status: cause.status }
    throw cause
  }
}
