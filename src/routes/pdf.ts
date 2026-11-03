import { Hono } from 'hono'

import { requireUser } from '../auth/session.ts'
import { fail, readJson, text } from '../http.ts'
import { MAX_HTML_BYTES, PdfError, attachmentName, htmlToPdf } from '../pdf.ts'

/**
 * The one PDF endpoint.
 *
 * A caller sends a document and gets a PDF back; it knows nothing about reports,
 * so the same endpoint prints any page the app can describe. The PDF is
 * generated here rather than on the device because the app already has the
 * markup for each report, and mobile browsers cannot print to a file.
 */

export const pdfRoutes = new Hono()

/**
 * POST /api/mobile/pdf   { html, filename?, landscape? }
 *
 * Success: the PDF itself, `application/pdf`, as an attachment.
 *
 * Any signed-in user may print: the document is theirs, and this endpoint reads
 * nothing from the database.
 */
pdfRoutes.post('/', async (c) => {
  const user = await requireUser(c)
  if (user instanceof Response) return user

  const body = await readJson(c)
  const html = typeof body.html === 'string' ? body.html : ''

  if (!html.trim()) return fail(c, 'Send the html to print', 400)
  if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
    return fail(c, 'That document is too large to print', 413)
  }

  let bytes: Uint8Array
  try {
    bytes = await htmlToPdf(html, { landscape: body.landscape === true })
  } catch (cause) {
    if (cause instanceof PdfError) return fail(c, cause.message, 500)
    throw cause
  }

  const name = attachmentName(text(body.filename) || 'report.pdf')
  return c.body(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${name}"`,
    'Content-Length': String(bytes.byteLength),
  })
})
