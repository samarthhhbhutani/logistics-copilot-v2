import sanitizeHtml from 'sanitize-html';
import { htmlToPlainText } from '../utils/mime/htmlToPlainText.js';

/**
 * What an HTML signature may contain once stored: text formatting, links, simple table layout and
 * inline images. Images must be `cid:` references to the mailbox's own uploaded images, so a
 * signature can never load a remote tracking pixel into every mail we send; links may only be
 * http(s) or mailto. Everything else (scripts, event handlers, remote images, iframes, forms,
 * unknown styles) is dropped, not escaped.
 */
function signatureHtmlRules(allowedImageContentIds: ReadonlySet<string>): sanitizeHtml.IOptions {
  return {
    allowedTags: [
      'p',
      'br',
      'b',
      'strong',
      'i',
      'em',
      'u',
      'a',
      'span',
      'div',
      'table',
      'tbody',
      'tr',
      'td',
      'img',
    ],
    allowedAttributes: {
      a: ['href', 'style'],
      img: ['src', 'alt', 'width', 'height', 'style'],
      table: ['width', 'cellpadding', 'cellspacing', 'border', 'style'],
      td: ['width', 'valign', 'align', 'style'],
      p: ['style'],
      span: ['style'],
      div: ['style'],
      tr: ['style'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: ['cid'], a: ['http', 'https', 'mailto'] },
    allowProtocolRelative: false,
    allowedStyles: {
      '*': {
        color: [/^#[0-9a-fA-F]{3,8}$/, /^rgb\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*\)$/, /^[a-zA-Z]+$/],
        'font-size': [/^\d+(\.\d+)?(px|pt|em|rem|%)$/],
        'font-weight': [/^(normal|bold|[1-9]00)$/],
        'font-family': [/^[\w\s,'"-]+$/],
        'font-style': [/^(normal|italic)$/],
        'text-decoration': [/^(none|underline)$/],
        'text-align': [/^(left|right|center)$/],
        'line-height': [/^\d+(\.\d+)?(px|em|%)?$/],
        margin: [/^[\d.\s]+(px|em)?(\s[\d.]+(px|em)?){0,3}$/],
        padding: [/^[\d.\s]+(px|em)?(\s[\d.]+(px|em)?){0,3}$/],
        'border-collapse': [/^collapse$/],
        width: [/^\d+(px|%)?$/],
        height: [/^\d+(px|%)?$/],
        display: [/^(block|inline|inline-block)$/],
        'vertical-align': [/^(top|middle|bottom)$/],
      },
    },
    disallowedTagsMode: 'discard',
    // An image that is not one of the mailbox's own uploads (`cid:<imageId>`) is dropped whole,
    // not left as an empty <img>: a remote URL, a typo, or another mailbox's id.
    exclusiveFilter: (frame) =>
      frame.tag === 'img' && !allowedImageContentIds.has(contentIdOf(frame.attribs['src'])),
  };
}

function contentIdOf(imageSrc: string | undefined): string {
  return imageSrc?.startsWith('cid:') ? imageSrc.slice('cid:'.length) : '';
}

/** The `cid:` references an HTML signature makes, in document order, without the `cid:` prefix. */
export function listSignatureImageContentIds(signatureHtml: string): string[] {
  return [...signatureHtml.matchAll(/<img\b[^>]*\bsrc="cid:([^"]+)"/g)].map((match) => match[1]!);
}

export interface SanitizedSignature {
  /** The HTML as it will be stored and sent; null when nothing visible survived sanitising. */
  signatureHtml: string | null;
  /** The text part of the same signature; null together with signatureHtml. */
  signature: string | null;
}

/**
 * The stored form of what an operator submitted: sanitised HTML plus the plain text derived from
 * it. Only images among `allowedImageContentIds` (the mailbox's uploaded signature images) stay.
 * Markup with no text and no image (an empty paragraph, a stray tag) clears the signature.
 */
export function sanitizeSignatureHtml(
  submittedHtml: string | null,
  allowedImageContentIds: Iterable<string>,
): SanitizedSignature {
  if (submittedHtml === null) return { signatureHtml: null, signature: null };
  const signatureHtml = sanitizeHtml(
    submittedHtml,
    signatureHtmlRules(new Set(allowedImageContentIds)),
  ).trim();
  const signature = htmlToPlainText(signatureHtml);
  const hasImage = listSignatureImageContentIds(signatureHtml).length > 0;
  if (!signature && !hasImage) return { signatureHtml: null, signature: null };
  return { signatureHtml, signature: signature || null };
}
