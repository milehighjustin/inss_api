/**
 * The page the QuickBooks connection lands on.
 *
 * The browser, not the app, finishes the OAuth flow, so this is what the
 * administrator sees: same flat, type-led language as the magic-link page, one
 * accent bar, and a plain instruction to go back. No script, no redirect — the
 * app refreshes its status when the window is focused again.
 */
export function integrationPage({
  title,
  message,
  detail,
  tone = 'success',
}: {
  title: string
  message: string
  detail?: string
  tone?: 'success' | 'error'
}): string {
  const accent = tone === 'error' ? '#D64545' : '#208AEF'
  const escape = (value: string) =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escape(title)} · INSS Support</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        background: #111315;
        color: #ffffff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
      }
      main { width: 100%; max-width: 440px; background: #1B1E21; }
      .bar { height: 8px; background: ${accent}; }
      .body { padding: 32px; }
      .eyebrow {
        margin: 0;
        font-size: 12px;
        letter-spacing: 2px;
        text-transform: uppercase;
        color: #9AA0A6;
      }
      h1 { margin: 8px 0 0; font-size: 34px; line-height: 40px; font-weight: 600; }
      p { margin: 16px 0 0; font-size: 16px; line-height: 24px; color: #C6CACF; }
      .detail {
        margin-top: 20px;
        padding-top: 16px;
        border-top: 1px solid #2C3034;
        font-size: 13px;
        line-height: 20px;
        color: #9AA0A6;
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <main>
      <div class="bar"></div>
      <div class="body">
        <p class="eyebrow">INSS Support · Integrations</p>
        <h1>${escape(title)}</h1>
        <p>${escape(message)}</p>
        ${detail ? `<p class="detail">${escape(detail)}</p>` : ''}
      </div>
      <div class="bar"></div>
    </main>
  </body>
</html>`
}
