import { Hono } from 'hono'

import {
  DocumentError,
  adminDocuments,
  createAdminDocument,
  deleteAdminDocument,
  documentAudienceUserIds,
  documentUploadSignature,
  documentUrl,
  isDocumentAudience,
} from '../adminDocuments.ts'
import { requireAdmin } from '../auth/session.ts'
import { fail, readJson, text } from '../http.ts'
import { notifyDocumentUpload } from '../notifications.ts'

/**
 * The investor portal's documents, for administrators.
 *
 * Uploading is two steps: `POST /upload` hands back a write-only URL for one
 * server-named blob, and `POST /` records the document once the bytes are in
 * Azure. Reads are signed per document, because the container is private.
 */

export const adminDocumentRoutes = new Hono()

/** GET /api/mobile/admin/documents — newest first. */
adminDocumentRoutes.get('/', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  return c.json({ documents: await adminDocuments() })
})

/** POST /api/mobile/admin/documents/upload   { contentType, fileName? } */
adminDocumentRoutes.post('/upload', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const body = await readJson(c)

  try {
    const upload = documentUploadSignature(text(body.contentType), text(body.fileName) || undefined)
    return c.json({ upload })
  } catch (cause) {
    if (cause instanceof DocumentError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

/**
 * GET /api/mobile/admin/documents/audience?audience=allInvestors&investorId=&locationId=
 *
 * Success: { users }
 *
 * How many investors will see a file filed this way. It is the same rule the
 * Files tab applies to reads, so the upload form can say "12 investors" before
 * anyone saves — and the notification it can send goes to exactly those people.
 */
adminDocumentRoutes.get('/audience', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const audience = c.req.query('audience')
  if (!isDocumentAudience(audience)) return fail(c, 'Choose who may see this file', 400)

  const recipients = await documentAudienceUserIds({
    audience,
    investorId: c.req.query('investorId'),
    locationId: c.req.query('locationId'),
  })

  return c.json({ users: recipients.length })
})

/**
 * POST /api/mobile/admin/documents
 *
 * `{ blobName, name, audience, investorId?, locationId?, folderName?, notify? }`
 *
 * `notify` is optional and, when present, is `{ title, body?, priority }`: the
 * alert the investors who can see the file are sent. It is decided per upload —
 * most documents are filed quietly, and a statement someone should look at today
 * is not.
 */
adminDocumentRoutes.post('/', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const body = await readJson(c)
  const name = text(body.name)
  if (name.length < 4) return fail(c, 'Give the file a name of at least four characters', 400)
  if (!isDocumentAudience(body.audience)) {
    return fail(c, 'Choose who may see this file', 400)
  }

  const notifyInput = body.notify
  const notify =
    notifyInput && typeof notifyInput === 'object'
      ? {
          title: text((notifyInput as Record<string, unknown>).title),
          body: text((notifyInput as Record<string, unknown>).body),
          priority:
            (notifyInput as Record<string, unknown>).priority === 'loud'
              ? ('loud' as const)
              : ('quiet' as const),
        }
      : null

  if (notify && !notify.title) {
    return fail(c, 'Give the notification a title, or leave it off', 400)
  }

  try {
    const document = await createAdminDocument({
      blobName: text(body.blobName),
      name,
      audience: body.audience,
      investorId: text(body.investorId) || undefined,
      locationId: text(body.locationId) || undefined,
      folderName: text(body.folderName) || undefined,
    })

    // The file is recorded first: a notification about something that is not
    // there would be a worse failure than a document posted quietly.
    let notification = null
    if (notify) {
      const recipients = await documentAudienceUserIds({
        audience: document.audience,
        investorId: document.investorId,
        locationId: document.locationId,
      })

      notification = await notifyDocumentUpload({
        documentId: document.id,
        documentName: document.name,
        folder: document.folder,
        recipients,
        title: notify.title,
        body: notify.body,
        priority: notify.priority,
        createdBy: user.userId,
      })
    }

    return c.json({ document, notification }, 201)
  } catch (cause) {
    if (cause instanceof DocumentError) return fail(c, cause.message, cause.status)
    throw cause
  }
})

/** GET /api/mobile/admin/documents/:documentId/url — a signed read URL. */
adminDocumentRoutes.get('/:documentId/url', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const url = await documentUrl(c.req.param('documentId'))
  if (!url) return fail(c, 'That document is not there', 404)

  return c.json(url)
})

/** DELETE /api/mobile/admin/documents/:documentId */
adminDocumentRoutes.delete('/:documentId', async (c) => {
  const user = await requireAdmin(c)
  if (user instanceof Response) return user

  const deleted = await deleteAdminDocument(c.req.param('documentId'))
  if (!deleted) return fail(c, 'That document is not there', 404)

  return c.json({ deleted: true })
})
