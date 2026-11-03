import type { InvestorLocation } from '../investor.ts'
import { report } from './api.ts'

/**
 * The investor reports, out of QuickBooks.
 *
 * v1 built each report on the server and rendered it as HTML
 * (`inssapp/app/investor/profitLossByDept.ts`, `budgetVsActualByDept.ts`), then
 * posted that HTML to an external service to get a PDF. The parsing is the same
 * here, with two differences:
 *
 * - The result is a document — titled, sectioned, with formatted cells — so the
 *   app can draw it natively and the same structure can be printed.
 * - Nested account groups (a parent account with sub-accounts) are kept, where
 *   v1 silently dropped them by only reading two-column rows. Nothing that comes
 *   back from QuickBooks is thrown away now.
 *
 * QuickBooks owns the numbers: this file formats them and puts them in order, and
 * never recalculates a total QuickBooks already sent.
 */

export const REPORT_KINDS = ['profit-loss', 'budget-vs-actual'] as const

export type ReportKind = (typeof REPORT_KINDS)[number]

export function isReportKind(value: unknown): value is ReportKind {
  return typeof value === 'string' && (REPORT_KINDS as readonly string[]).includes(value)
}

export const REPORT_TITLES: Record<ReportKind, string> = {
  'profit-loss': 'Profit & Loss',
  'budget-vs-actual': 'Budget vs Actuals',
}

export interface ReportRow {
  label: string
  /** One per column. Already formatted for display. */
  values: string[]
  /** Summary lines print heavier; the bottom line gets the heaviest rule. */
  emphasis?: 'strong' | 'final'
  /** 1 for an account inside a group, so it indents under it. */
  level?: number
}

export interface ReportTable {
  /** v1's section heading — Income, Expenses, … */
  title?: string
  columns: string[]
  rows: ReportRow[]
}

export interface ReportDocument {
  kind: ReportKind
  title: string
  /** The company the books belong to. */
  company: string
  /** The property the report is for. */
  property: string
  start: string
  end: string
  generatedAt: string
  tables: ReportTable[]
  /** The same document as a printable page, for the PDF endpoint. */
  html: string
}

/* ------------------------------------------------------------------ *
 * Dates
 * ------------------------------------------------------------------ */

export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function lastDayOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month + 1, 0))
}

function yearBefore(date: Date): Date {
  const copy = new Date(date)
  copy.setUTCFullYear(copy.getUTCFullYear() - 1)
  return copy
}

/**
 * v1's Profit & Loss window: a year back from the last closed month.
 *
 * Books are not closed on the day they end, so v1 stops two months back until
 * the 15th of the month and one month back after it.
 */
export function defaultProfitLossRange(now = new Date()): { start: string; end: string } {
  const day = now.getUTCDate()
  const end = lastDayOfMonth(
    now.getUTCFullYear(),
    now.getUTCMonth() - (day <= 14 ? 2 : 1),
  )
  return { start: isoDate(yearBefore(end)), end: isoDate(end) }
}

/**
 * v1's Budget vs Actual window: the current fiscal year to last month, or last
 * year in full before February 15.
 */
export function defaultBudgetRange(now = new Date()): { start: string; end: string } {
  const year = now.getUTCFullYear()
  const beforeBudgetYear = now < new Date(Date.UTC(year, 1, 15))

  if (beforeBudgetYear) {
    return {
      start: isoDate(new Date(Date.UTC(year - 1, 0, 1))),
      end: isoDate(new Date(Date.UTC(year - 1, 11, 31))),
    }
  }

  return {
    start: isoDate(new Date(Date.UTC(year, 0, 1))),
    end: isoDate(lastDayOfMonth(year, now.getUTCMonth() - 1)),
  }
}

export function defaultRange(kind: ReportKind, now = new Date()): { start: string; end: string } {
  return kind === 'profit-loss' ? defaultProfitLossRange(now) : defaultBudgetRange(now)
}

/**
 * The latest end date each report accepts, which is v1's own limit.
 *
 * Profit & Loss stops where the books stop, Budget vs Actuals runs to today.
 */
export function latestEnd(kind: ReportKind, now = new Date()): string {
  return kind === 'profit-loss' ? defaultProfitLossRange(now).end : isoDate(now)
}

export class ReportError extends Error {
  status: 400 | 409 | 502

  constructor(message: string, status: 400 | 409 | 502) {
    super(message)
    this.name = 'ReportError'
    this.status = status
  }
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Parses a `YYYY-MM-DD` date, rejecting anything else. */
export function parseReportDate(value: unknown, label: string): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || !DAY_PATTERN.test(value)) {
    throw new ReportError(`${label} must be a date like 2025-01-31`, 400)
  }
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime()) || isoDate(date) !== value) {
    throw new ReportError(`${label} is not a real date`, 400)
  }
  return value
}

export interface ReportRange {
  start: string
  end: string
}

/** The range for one report: the caller's dates, or v1's defaults, and v1's limits. */
export function resolveRange(
  kind: ReportKind,
  input: { start?: unknown; end?: unknown },
  now = new Date(),
): ReportRange {
  const defaults = defaultRange(kind, now)
  const start = parseReportDate(input.start, 'Start date') ?? defaults.start
  const end = parseReportDate(input.end, 'End date') ?? defaults.end

  if (start >= end) throw new ReportError('Start date must be before end date', 400)

  const limit = latestEnd(kind, now)
  if (end > limit) {
    throw new ReportError(`End date cannot be after ${limit}`, 400)
  }

  return { start, end }
}

/* ------------------------------------------------------------------ *
 * QuickBooks response shapes
 * ------------------------------------------------------------------ */

interface ColData {
  value?: string
  id?: string
}

interface QbRow {
  ColData?: ColData[]
  Header?: { ColData?: ColData[] }
  Summary?: { ColData?: ColData[] }
  Rows?: { Row?: QbRow[] }
}

export interface QbReport {
  Header?: { Time?: string; ReportName?: string; StartPeriod?: string; EndPeriod?: string }
  Rows?: { Row?: QbRow[] }
}

/** The money format v1's reports print: two decimals, thousands separators. */
export function reportMoney(value: unknown): string {
  const amount = Number(value)
  if (!Number.isFinite(amount)) return '$0.00'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount)
}

function headerName(row: QbRow): string {
  return (row.Header?.ColData?.[0]?.value ?? '').trim()
}

/** The values of a row, skipping the leading label column. */
function cells(row: QbRow | undefined, count: number): (string | undefined)[] {
  const columns = row?.ColData ?? []
  return Array.from({ length: count }, (_, index) => columns[index + 1]?.value)
}

interface RawRow {
  label: string
  level: number
  cells: (string | undefined)[]
}

/**
 * Flattens one section of a QuickBooks report.
 *
 * A row is either an account (its own `ColData`) or a group (a `Header`, a
 * `Summary` and children). Groups are kept: they are how QuickBooks shows a
 * parent account and the sub-accounts under it.
 */
function flatten(rows: QbRow[] | undefined, columns: number, level = 0): RawRow[] {
  const out: RawRow[] = []

  for (const row of rows ?? []) {
    const groupName = headerName(row)
    if (groupName) {
      out.push({ label: groupName, level, cells: cells(row.Summary, columns) })
      out.push(...flatten(row.Rows?.Row, columns, level + 1))
      continue
    }

    const name = (row.ColData?.[0]?.value ?? '').trim()
    if (!name) continue
    out.push({ label: name, level, cells: cells(row, columns) })
  }

  return out
}

/**
 * QuickBooks writes percentages as `79.16 %`, and sometimes as a bare `0.00`.
 * The report prints both as a percentage.
 */
function reportPercent(value: string | undefined): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return '0%'
  if (trimmed.includes('%')) return trimmed.replace(/\s+%$/, '%')
  return Number.isFinite(Number(trimmed)) ? `${trimmed}%` : trimmed
}

function moneyRow(row: RawRow): ReportRow {
  return {
    label: row.label,
    values: [reportMoney(row.cells[0])],
    ...(row.level > 0 ? { level: row.level } : {}),
  }
}

/** The four-value row Budget vs Actuals prints. */
function budgetRow(row: RawRow): ReportRow {
  return {
    label: row.label,
    values: [
      reportMoney(row.cells[0]),
      reportMoney(row.cells[1]),
      reportMoney(row.cells[2]),
      reportPercent(row.cells[3]),
    ],
    ...(row.level > 0 ? { level: row.level } : {}),
  }
}

interface Section {
  name: string
  rows: RawRow[]
  summary: (string | undefined)[]
}

interface ParsedReport {
  sections: Section[]
  /** Top-level summary rows, by name: Gross Profit, Net Income, … */
  summary: Map<string, (string | undefined)[]>
}

function parse(data: QbReport, columns: number): ParsedReport {
  const sections: Section[] = []
  const summary = new Map<string, (string | undefined)[]>()

  for (const row of data.Rows?.Row ?? []) {
    const name = headerName(row)
    if (name) {
      sections.push({
        name,
        rows: flatten(row.Rows?.Row, columns),
        summary: cells(row.Summary, columns),
      })
      continue
    }

    const label = (row.Summary?.ColData?.[0]?.value ?? '').trim()
    if (label) summary.set(label, cells(row.Summary, columns))
  }

  return { sections, summary }
}

function section(parsed: ParsedReport, name: string): Section | undefined {
  return parsed.sections.find((entry) => entry.name === name)
}

function summaryValues(parsed: ParsedReport, name: string, count: number): (string | undefined)[] {
  const values = parsed.summary.get(name) ?? []
  return Array.from({ length: count }, (_, index) => values[index])
}

/* ------------------------------------------------------------------ *
 * Profit & Loss
 * ------------------------------------------------------------------ */

export async function profitLossReport(
  property: Pick<InvestorLocation, 'departmentId' | 'departmentName'>,
  range: ReportRange,
): Promise<ReportDocument> {
  const department = departmentIdFor(property)
  const data = await report<QbReport>('ProfitAndLoss', {
    start_date: range.start,
    end_date: range.end,
    department,
  })

  const parsed = parse(data, 1)
  const income = section(parsed, 'Income')
  const expenses = section(parsed, 'Expenses')
  const otherExpenses = section(parsed, 'Other Expenses')

  const totals = (values: (string | undefined)[]) => reportMoney(values[0])
  const single: string[] = ['Total']

  const tables: ReportTable[] = [
    {
      title: 'Income',
      columns: single,
      rows: [
        ...(income?.rows ?? []).map(moneyRow),
        { label: 'Total Income', values: [totals(income?.summary ?? [])], emphasis: 'strong' },
        {
          label: 'Gross Profit',
          values: [totals(summaryValues(parsed, 'Gross Profit', 1))],
          emphasis: 'strong',
        },
      ],
    },
    {
      title: 'Expenses',
      columns: single,
      rows: [
        ...(expenses?.rows ?? []).map(moneyRow),
        { label: 'Total Expenses', values: [totals(expenses?.summary ?? [])], emphasis: 'strong' },
        {
          label: 'Net Operating Income',
          values: [totals(summaryValues(parsed, 'Net Operating Income', 1))],
          emphasis: 'strong',
        },
      ],
    },
    {
      title: 'Other Expenses',
      columns: single,
      rows: [
        ...(otherExpenses?.rows ?? []).map(moneyRow),
        {
          label: 'Total Other Expenses',
          values: [totals(otherExpenses?.summary ?? [])],
          emphasis: 'strong',
        },
        {
          label: 'Net Other Income',
          values: [totals(summaryValues(parsed, 'Net Other Income', 1))],
          emphasis: 'strong',
        },
        {
          label: 'Net Income',
          values: [totals(summaryValues(parsed, 'Net Income', 1))],
          emphasis: 'final',
        },
      ],
    },
  ]

  return buildDocument('profit-loss', property, range, tables)
}

/* ------------------------------------------------------------------ *
 * Budget vs Actuals
 * ------------------------------------------------------------------ */

const BUDGET_COLUMNS = ['Actual', 'Budget', 'Variance', 'Var %']

export async function budgetVsActualReport(
  property: Pick<InvestorLocation, 'departmentId' | 'departmentName'>,
  range: ReportRange,
): Promise<ReportDocument> {
  const department = departmentIdFor(property)
  const data = await report<QbReport>('BudgetVsActuals', {
    start_date: range.start,
    end_date: range.end,
    department,
    rowaxis: 'primary',
  })

  const parsed = parse(data, 4)
  const income = section(parsed, 'Income')
  const expenses = section(parsed, 'Expenses')
  const otherExpenses = section(parsed, 'Other Expenses')

  const totalsRow = (label: string, values: (string | undefined)[], emphasis: 'strong' | 'final'): ReportRow => ({
    label,
    values: [
      reportMoney(values[0]),
      reportMoney(values[1]),
      reportMoney(values[2]),
      reportPercent(values[3]),
    ],
    emphasis,
  })

  const tables: ReportTable[] = [
    {
      title: 'Income',
      columns: BUDGET_COLUMNS,
      rows: [
        ...(income?.rows ?? []).map(budgetRow),
        totalsRow('Total Income', income?.summary ?? [], 'strong'),
        totalsRow('Gross Profit', summaryValues(parsed, 'Gross Profit', 4), 'strong'),
      ],
    },
    {
      title: 'Expenses',
      columns: BUDGET_COLUMNS,
      rows: [
        ...(expenses?.rows ?? []).map(budgetRow),
        totalsRow('Total Expenses', expenses?.summary ?? [], 'strong'),
        totalsRow(
          'Net Operating Income',
          summaryValues(parsed, 'Net Operating Income', 4),
          'strong',
        ),
      ],
    },
  ]

  // v1 read Other Expenses and then never printed them. They are printed here
  // when QuickBooks returns any, so nothing in the report is lost.
  if (otherExpenses?.rows.length) {
    tables.push({
      title: 'Other Expenses',
      columns: BUDGET_COLUMNS,
      rows: [
        ...otherExpenses.rows.map(budgetRow),
        totalsRow('Total Other Expenses', otherExpenses.summary, 'strong'),
        totalsRow('Net Other Income', summaryValues(parsed, 'Net Other Income', 4), 'strong'),
        totalsRow('Net Income', summaryValues(parsed, 'Net Income', 4), 'final'),
      ],
    })
  }

  return buildDocument('budget-vs-actual', property, range, tables)
}

/* ------------------------------------------------------------------ *
 * Building the document
 * ------------------------------------------------------------------ */

function departmentIdFor(property: Pick<InvestorLocation, 'departmentId' | 'departmentName'>): string {
  const department = property.departmentId?.trim()
  if (!department) {
    throw new ReportError('This property is not linked to a QuickBooks department', 409)
  }
  return department
}

export function buildDocument(
  kind: ReportKind,
  property: Pick<InvestorLocation, 'departmentName'>,
  range: ReportRange,
  tables: ReportTable[],
): ReportDocument {
  const document: ReportDocument = {
    kind,
    title: REPORT_TITLES[kind],
    company: 'In Self Storage',
    property: property.departmentName,
    start: range.start,
    end: range.end,
    generatedAt: new Date().toISOString(),
    tables,
    html: '',
  }

  return { ...document, html: documentHtml(document) }
}

/** `2025-09-30` as `9/30/2025`, the way v1's headings read. */
function longDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * The printable page.
 *
 * Self-contained (no fonts, images or scripts to fetch), sized for Letter with
 * the narrower type a financial table needs, and broken with `page-break-inside:
 * avoid` so a table is not split across two pages mid-row.
 *
 * This page is what an investor keeps, so it is laid out like a statement: a
 * letterhead, the property and period set as a two-column meta block under it,
 * rules instead of boxes, and fixed-width figures so every column of money lines
 * up down the page.
 */
export function documentHtml(document: ReportDocument): string {
  const tables = document.tables
    .map((table) => {
      const width = 100 / (table.columns.length + 1)
      const head = table.columns
        .map((column) => `<th style="width:${width}%;">${escapeHtml(column)}</th>`)
        .join('')

      const rows = table.rows
        .map((row) => {
          const values = row.values
            .map((value) => `<td style="text-align:right;">${escapeHtml(value)}</td>`)
            .join('')
          const weight = row.emphasis ? '700' : '400'
          const rule =
            row.emphasis === 'final'
              ? 'border-top:1px solid #000;border-bottom:3px double #000;'
              : row.emphasis === 'strong'
                ? 'border-top:1px solid #bbb;'
                : 'border-bottom:1px solid #eee;'
          const indent = row.level ? `padding-left:${18 + row.level * 14}px;` : ''
          return `<tr style="font-weight:${weight};${rule}"><td style="${indent}">${escapeHtml(row.label)}</td>${values}</tr>`
        })
        .join('')

      const title = table.title
        ? `<tr><td colspan="${table.columns.length + 1}" class="section">${escapeHtml(
            table.title.toUpperCase(),
          )}</td></tr>`
        : ''

      return `<table>
        <thead>${title}<tr><th class="metric"></th>${head}</tr></thead>
        <tbody>${rows}</tbody>
      </table>`
    })
    .join('')

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(document.company)} — ${escapeHtml(document.title)}</title>
<style>
  @page { size: Letter; margin: 0.55in 0.45in; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { font-family: Helvetica, Arial, sans-serif; color: #111; margin: 0; font-size: 11px;
         font-variant-numeric: tabular-nums; }

  /* Letterhead: who the report is from, what it is, then the two facts that say
     which books it covers. */
  .eyebrow { font-size: 8.5px; letter-spacing: 2px; text-transform: uppercase;
             color: #666; margin: 0 0 4px; font-weight: 700; }
  h1 { font-size: 21px; margin: 0 0 3px; letter-spacing: -0.3px; font-weight: 700; }
  h2 { font-size: 14px; font-weight: 600; margin: 0; color: #222; }
  .brand { height: 3px; background: #208AEF; margin: 9px 0 0; }
  .meta { display: flex; justify-content: space-between; gap: 24px;
          border-bottom: 1px solid #000; padding: 8px 0 7px; margin: 0 0 16px; }
  .meta .label { display: block; font-size: 8px; letter-spacing: 1.2px; text-transform: uppercase;
                 color: #666; font-weight: 700; margin-bottom: 2px; }
  .meta .value { font-size: 11px; font-weight: 600; }
  .meta .right { text-align: right; }

  /* A long report has to be able to run over a page break, but never inside a
     row; the head repeats so the columns stay named on every page. */
  table { width: 100%; border-collapse: collapse; font-size: 10.5px; margin-bottom: 20px; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; break-inside: avoid; }
  th { font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.7px; color: #666;
       text-align: right; font-weight: 700; padding: 0 6px 7px; border-bottom: 1px solid #000;
       white-space: nowrap; }
  th.metric { text-align: left; width: 42%; }
  td { padding: 5px 6px; vertical-align: top; }
  td:first-child { text-align: left; padding-left: 0; }
  td:last-child { padding-right: 0; }
  tbody tr:nth-child(even) td { background: #fafafb; }
  .section { font-size: 8.5px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase;
             padding: 16px 0 5px; border-bottom: 1px solid #000; }
  tbody tr:nth-child(even) .section { background: transparent; }

  /* The footnote is the part an investor is told to read, so it is set apart by
     a rule rather than hidden in grey. */
  footer { margin-top: 22px; border-top: 1px solid #ddd; padding-top: 7px;
           font-size: 8px; line-height: 1.45; color: #777; }
  footer .stamp { margin: 0 0 3px; }
  footer .confidential { margin: 0; }
</style>
</head>
<body>
  <div class="eyebrow">Investor Report</div>
  <h1>${escapeHtml(document.company)}</h1>
  <h2>${escapeHtml(document.title)}</h2>
  <div class="brand"></div>

  <div class="meta">
    <div>
      <span class="label">Property</span>
      <span class="value">${escapeHtml(document.property)}</span>
    </div>
    <div class="right">
      <span class="label">Period</span>
      <span class="value">${escapeHtml(longDate(document.start))} – ${escapeHtml(
        longDate(document.end),
      )}</span>
    </div>
  </div>

  ${tables}

  <footer>
    <p class="stamp">Generated ${escapeHtml(
      new Date(document.generatedAt).toLocaleString('en-US', { timeZone: 'UTC' }),
    )} UTC · Figures unaudited · ${escapeHtml(document.company)}</p>
    <p class="confidential">Confidential. Prepared for the investor it was issued to and not for
    circulation. Amounts are in US dollars unless a column states otherwise.</p>
  </footer>
</body>
</html>`
}
