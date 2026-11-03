/**
 * The page a magic-link email lands on.
 *
 * It hands the sign-in token to the app through the `inssappv2://` scheme, and
 * shows the same link as a button for browsers that block custom-scheme
 * redirects. Styling follows the Metro language used by both apps: flat colour
 * fields, square corners, one accent colour, large type.
 */
export function landingPage({
  title,
  message,
  deepLink,
  tone = 'neutral',
}: {
  title: string
  message: string
  deepLink?: string
  tone?: 'neutral' | 'error'
}): string {
  const accent = tone === 'error' ? '#D64545' : '#208AEF'
  const safeLink = deepLink
    ? deepLink.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    : ''

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${title} · INSS Support</title>
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
      a.open {
        display: block;
        margin-top: 24px;
        padding: 16px 24px;
        background: ${accent};
        color: #ffffff;
        text-align: center;
        text-decoration: none;
        font-size: 16px;
        font-weight: 600;
      }
      .hint { margin-top: 16px; font-size: 13px; line-height: 20px; color: #9AA0A6; word-break: break-all; }
    </style>
  </head>
  <body>
    <main>
      <div class="bar"></div>
      <div class="body">
        <p class="eyebrow">INSS Support</p>
        <h1>${title}</h1>
        <p>${message}</p>
        ${safeLink ? `<a class="open" href="${safeLink}" id="open">Open the app</a>` : ''}
        ${safeLink ? `<p class="hint">Nothing happened? Open this page on the device with the app installed, then tap the button again.</p>` : ''}
      </div>
      <div class="bar"></div>
    </main>
    ${
      safeLink
        ? `<script>
      (function () {
        var link = ${JSON.stringify(safeLink)};
        // Give the browser a moment to paint the fallback button first.
        setTimeout(function () { window.location.href = link; }, 250);
      })();
    </script>`
        : ''
    }
  </body>
</html>`
}
