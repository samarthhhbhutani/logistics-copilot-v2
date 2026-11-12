import type { sanitizeEmailHtml } from './sanitizeEmailHtml.js';

/** The only executable code in the opaque frame. Never interpolate email content into this script. */
export const emailFrameLayoutScript = `(() => {
  const body = document.body;
  let scheduled = false;
  const reportLayout = () => {
    scheduled = false;
    const height = Math.ceil(body.getBoundingClientRect().height);
    const failedImageCount = Array.from(body.querySelectorAll('img')).filter(
      image => image.complete && image.naturalWidth === 0
    ).length;
    parent.postMessage({ type: 'emailFrameLayout', height, failedImageCount }, '*');
  };
  const scheduleLayout = () => {
    if (!scheduled) {
      scheduled = true;
      requestAnimationFrame(reportLayout);
    }
  };
  new ResizeObserver(scheduleLayout).observe(body);
  body.addEventListener('load', scheduleLayout, true);
  body.addEventListener('error', scheduleLayout, true);
  addEventListener('load', scheduleLayout);
  scheduleLayout();
})();`;

// This exact-source CSP hash is checked by the unit test. Email-provided code gets no nonce/hash.
export const emailFrameLayoutScriptHash = 'sha256-79rwiB0UwWKMyIBfV78OAXgAPamKL+DWXkhDQlufdpM=';
export const MAX_EMAIL_FRAME_HEIGHT = 1_000_000;

export function parseEmailFrameLayout(
  value: unknown,
): { height: number; failedImageCount: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const layout = value as Record<string, unknown>;
  if (Object.keys(layout).length !== 3) return undefined;
  if (
    layout.type !== 'emailFrameLayout' ||
    typeof layout.height !== 'number' ||
    !Number.isInteger(layout.height) ||
    layout.height < 0 ||
    layout.height > MAX_EMAIL_FRAME_HEIGHT ||
    typeof layout.failedImageCount !== 'number' ||
    !Number.isInteger(layout.failedImageCount) ||
    layout.failedImageCount < 0 ||
    layout.failedImageCount > 100_000
  )
    return undefined;
  return { height: Math.max(1, layout.height), failedImageCount: layout.failedImageCount };
}

/** No same-origin access. CSP permits only the fixed layout helper, never email scripts/handlers. */
export function createEmailDocument(sanitized: ReturnType<typeof sanitizeEmailHtml>): string {
  const imageSources = sanitized.imageOrigins.length ? sanitized.imageOrigins.join(' ') : "'none'";
  const policy = `default-src 'none'; script-src '${emailFrameLayoutScriptHash}'; script-src-attr 'none'; style-src 'unsafe-inline'; img-src ${imageSources}; base-uri 'none'; form-action 'none'; object-src 'none'`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="${policy}"><style>
    :root { color-scheme: light; overflow: hidden; } body { display: flow-root; margin: 0; padding: 0; color: #263e30; background: transparent; font: 15px/1.75 sans-serif; overflow-wrap: anywhere; }
    img { max-width: 100% !important; height: auto !important; } table { max-width: 100% !important; table-layout: auto; border-collapse: collapse; } :where(table:not([width]):not([style*="width"])) { width: 100%; } td, th { overflow-wrap: anywhere; }
    :where(div, p, pre, blockquote, center, ul, ol, li, h1, h2, h3, h4, h5, h6) { max-width: 100%; box-sizing: border-box !important; }
    pre { white-space: pre-wrap; } blockquote { margin: 12px 0; padding-left: 14px; border-left: 2px solid #dce2d7; } a { color: #24583c; } p:first-child { margin-top: 0; } p:last-child { margin-bottom: 0; }
  </style></head><body>${sanitized.html}<script>${emailFrameLayoutScript}</script></body></html>`;
}
