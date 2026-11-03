import puppeteer, { type Browser } from 'puppeteer'

/**
 * HTML → PDF, for the reports.
 *
 * One headless Chrome is shared by every request and reused: launching a browser
 * takes about a second, which is longer than the render itself. Pages are
 * created per call and always closed, so a failed render cannot leak one. When
 * nothing has printed for a while the browser is closed and the next call starts
 * a fresh one, so an idle API is not holding a few hundred megabytes.
 *
 * The caller's HTML is rendered as given. It cannot reach the API's data: there
 * are no cookies, no session and no filesystem access unless the deployment
 * explicitly relaxes Chrome's sandbox.
 */

const IDLE_CLOSE_MS = 5 * 60 * 1000

/** Report HTML is large, but not this large. */
export const MAX_HTML_BYTES = 2 * 1024 * 1024

let browserPromise: Promise<Browser> | null = null
let idleTimer: NodeJS.Timeout | null = null

function launch(): Promise<Browser> {
  const args = ['--disable-dev-shm-usage']
  // A container without user namespaces cannot start Chrome's sandbox; the
  // deployment opts out explicitly rather than this file weakening every host.
  if (process.env.PUPPETEER_NO_SANDBOX === '1') args.push('--no-sandbox')

  return puppeteer.launch({
    headless: true,
    args,
    ...(process.env.PUPPETEER_EXECUTABLE_PATH
      ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
      : {}),
  })
}

async function browser(): Promise<Browser> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }

  const current = browserPromise ? await browserPromise.catch(() => null) : null
  if (current?.connected) return current

  browserPromise = launch()
  return browserPromise
}

function scheduleIdleClose() {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    idleTimer = null
    void closePdfBrowser()
  }, IDLE_CLOSE_MS)
  // Never hold the process open for the sake of the timer.
  idleTimer.unref()
}

/** Closes the shared browser. Called on shutdown and when it has been idle. */
export async function closePdfBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }

  const pending = browserPromise
  browserPromise = null
  if (!pending) return

  try {
    const current = await pending
    await current.close()
  } catch (cause) {
    console.error('[pdf] could not close the browser', cause)
  }
}

export interface PdfOptions {
  /** `Letter` by default; report tables fit it without shrinking the type. */
  landscape?: boolean
}

export class PdfError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfError'
  }
}

/**
 * Renders one document and returns the PDF bytes.
 *
 * `printBackground` is on because the reports shade their totals; without it
 * every rule and fill prints white.
 */
export async function htmlToPdf(html: string, options: PdfOptions = {}): Promise<Uint8Array> {
  let page: Awaited<ReturnType<Browser['newPage']>> | null = null

  try {
    const instance = await browser()
    page = await instance.newPage()

    await page.setContent(html, { waitUntil: 'load', timeout: 30_000 })
    await page.emulateMediaType('print')

    return await page.pdf({
      format: 'Letter',
      landscape: options.landscape ?? false,
      printBackground: true,
      margin: { top: '0.5in', bottom: '0.5in', left: '0.4in', right: '0.4in' },
    })
  } catch (cause) {
    // A dead browser (out of memory, host restarted it) must not poison every
    // later request: drop the cached instance so the next call launches fresh.
    console.error('[pdf] render failed', cause)
    await closePdfBrowser()
    throw new PdfError('The PDF could not be produced just now.')
  } finally {
    await page?.close().catch(() => {})
    scheduleIdleClose()
  }
}

/** A `Content-Disposition` value that cannot break out of the header. */
export function attachmentName(name: string, fallback = 'report.pdf'): string {
  const cleaned = name
    .replace(/[\r\n"\\]/g, '')
    .replace(/[^\w.\- ]+/g, '-')
    .trim()
    .slice(0, 90)

  if (!cleaned) return fallback
  return cleaned.toLowerCase().endsWith('.pdf') ? cleaned : `${cleaned}.pdf`
}
