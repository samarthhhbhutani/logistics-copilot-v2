/**
 * Fold the quoted history of a reply behind a "Show quoted text" toggle, the way mail clients do,
 * so a one-line reply is not followed by a screen of text the reader already has one message down.
 * Runs on sanitized HTML, in an inert document; the toggle is a plain <details>, no script needed
 * (the frame's layout helper re-measures the body when it opens).
 *
 * Recognised, in order: Gmail (`gmail_quote_container` / `gmail_quote` class), Outlook (`divRplyFwdMsg`
 * or `appendonsend` id and everything after it), Apple Mail / Thunderbird (`blockquote[type=cite]`),
 * then any last blockquote introduced by an "On … wrote:" or "----- Original Message -----" line.
 * Gmail scopes the class and id names of mail it stores (`msg_<token>_gmail_quote`), so the client
 * markers are matched by substring rather than exact name.
 * Nothing is folded when the message has no text of its own before the quote (a bare forward).
 */
export const QUOTED_HISTORY_CLASS = 'quotedHistory';

const GMAIL_QUOTE_SELECTOR = '[class*="gmail_quote"]';
const OUTLOOK_HEADER_SELECTOR = '[id*="divRplyFwdMsg"], [id*="appendonsend"]';
const CITE_BLOCKQUOTE_SELECTOR = 'blockquote[type="cite"]';
/** A short standalone "Name <addr> wrote:" line, a dashed Original/Forwarded Message rule, or "On … wrote:". */
const ATTRIBUTION_PATTERN =
  /(^.{0,80}\bwrote:\s*$)|(^-{2,}\s*(original|forwarded) message\s*-{2,}$)|(^on .{3,200}wrote:?$)/i;

export function collapseQuotedHistory(sanitizedHtml: string): string {
  const document = new DOMParser().parseFromString(`<body>${sanitizedHtml}</body>`, 'text/html');
  const body = document.body;
  const region = findQuotedRegion(body);
  if (!region) return sanitizedHtml;
  if (!hasOwnTextBefore(body, region[0]!)) return sanitizedHtml;

  const details = document.createElement('details');
  details.className = QUOTED_HISTORY_CLASS;
  const summary = document.createElement('summary');
  const show = document.createElement('span');
  show.className = 'show';
  show.textContent = 'Show quoted text';
  const hide = document.createElement('span');
  hide.className = 'hide';
  hide.textContent = 'Hide quoted text';
  summary.append(show, hide);
  details.append(summary);
  const first = region[0]!;
  first.parentNode!.insertBefore(details, first);
  for (const node of region) details.append(node);
  return body.innerHTML;
}

/** The nodes making up the quote, attribution line included, in document order; undefined when none. */
function findQuotedRegion(body: HTMLElement): Node[] | undefined {
  const gmail = body.querySelector(GMAIL_QUOTE_SELECTOR);
  if (gmail) return withAttribution(gmail);

  const outlookHeader = body.querySelector(OUTLOOK_HEADER_SELECTOR);
  if (outlookHeader) return [outlookHeader, ...followingSiblings(outlookHeader)];

  const cited = body.querySelector(CITE_BLOCKQUOTE_SELECTOR);
  if (cited) return withAttribution(cited);

  const blockquotes = body.querySelectorAll('blockquote');
  const last = blockquotes[blockquotes.length - 1];
  if (!last) return undefined;
  const attribution = precedingAttribution(last);
  return attribution ? [attribution, last, ...followingSiblings(last)] : undefined;
}

/** The quote plus the "On … wrote:" line right before it, when the sender's client put one there. */
function withAttribution(quote: Element): Node[] {
  const attribution = precedingAttribution(quote);
  return attribution ? [attribution, quote] : [quote];
}

function precedingAttribution(quote: Element): Element | undefined {
  let previous = quote.previousElementSibling;
  while (previous && !(previous.textContent ?? '').trim())
    previous = previous.previousElementSibling;
  if (!previous) return undefined;
  const text = (previous.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= 300 && ATTRIBUTION_PATTERN.test(text) ? previous : undefined;
}

function followingSiblings(element: Element): Node[] {
  const siblings: Node[] = [];
  for (let next = element.nextSibling; next; next = next.nextSibling) siblings.push(next);
  return siblings;
}

/** True when some visible text precedes the quote: the reply said something of its own. */
function hasOwnTextBefore(body: HTMLElement, regionStart: Node): boolean {
  const range = body.ownerDocument.createRange();
  range.setStart(body, 0);
  range.setEndBefore(regionStart);
  return range.toString().trim().length > 0;
}
