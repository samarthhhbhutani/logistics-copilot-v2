import { htmlToText } from 'html-to-text';
import type { HtmlToTextOptions, SelectorDefinition } from 'html-to-text';

/**
 * Markup mail clients use for quoted history. Gmail wraps it in `div.gmail_quote`, Apple Mail and
 * most others in `<blockquote>`. Skipped only when the caller asks, so a forward keeps its content.
 */
const QUOTED_HISTORY_SELECTORS: SelectorDefinition[] = [
  { selector: 'blockquote', format: 'skip' },
  { selector: 'div.gmail_quote', format: 'skip' },
];

/**
 * Outlook web puts the original message after an `#appendonsend` marker / `#divRplyFwdMsg` header
 * block as plain siblings, which CSS selectors here cannot express ("everything after"), so the
 * markup is cut at the marker before parsing.
 */
const OUTLOOK_QUOTED_HISTORY_START = /<div\b[^>]*\bid="(appendonsend|divRplyFwdMsg)"[\s\S]*$/i;

/** Options for text meant to be read by people and models, not rendered: no wrapping, no link noise. */
const MAIL_TEXT_OPTIONS: HtmlToTextOptions = {
  wordwrap: false,
  preserveNewlines: false,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    // Rate cards arrive as tables; keep each row on one line with cells separated by two spaces.
    { selector: 'table', format: 'dataTable', options: { colSpacing: 2, rowSpacing: 0 } },
    { selector: 'h1', options: { uppercase: false } },
    { selector: 'h2', options: { uppercase: false } },
    { selector: 'h3', options: { uppercase: false } },
    { selector: 'h4', options: { uppercase: false } },
    { selector: 'h5', options: { uppercase: false } },
    { selector: 'h6', options: { uppercase: false } },
  ],
};

export interface HtmlToPlainTextOptions {
  /** Drop the quoted earlier messages the client marked up as such. Default false. */
  removeQuotedHistory?: boolean;
}

/**
 * Plain text for an HTML-only body, used for display fallback, classification and extraction.
 * Delegates to html-to-text (a real parser); this file only fixes the options for mail.
 */
export function htmlToPlainText(
  html: string,
  { removeQuotedHistory = false }: HtmlToPlainTextOptions = {},
): string {
  const selectors = removeQuotedHistory
    ? [...(MAIL_TEXT_OPTIONS.selectors ?? []), ...QUOTED_HISTORY_SELECTORS]
    : MAIL_TEXT_OPTIONS.selectors;
  const markup = removeQuotedHistory ? html.replace(OUTLOOK_QUOTED_HISTORY_START, '') : html;
  return collapseWhitespace(htmlToText(markup, { ...MAIL_TEXT_OPTIONS, selectors }));
}

/** Trims every line, drops runs of more than one blank line, and normalises non-breaking spaces. */
export function collapseWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
