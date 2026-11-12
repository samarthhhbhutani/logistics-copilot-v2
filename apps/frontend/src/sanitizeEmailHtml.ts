import DOMPurify from 'dompurify';
import { constrainEmailLayout } from './emailLayoutConstraints.js';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Letter } from 'react-letter';
import { allowedCssProperties } from 'lettersanitizer';
import type { AttachmentSummaryResponse } from '@lc/contract';
import { prepareEmailResponsiveImages } from './emailResponsiveImages.js';
import { isEmailMediaHeightIndependent } from './emailMedia.js';

const allowedTags = [
  'p',
  'br',
  'div',
  'span',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'small',
  'sub',
  'sup',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'blockquote',
  'pre',
  'code',
  'hr',
  'ul',
  'ol',
  'li',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'a',
  'img',
  'picture',
  'source',
  'style',
  'font',
  'center',
  'col',
  'colgroup',
];
const rasterImageTypes = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const MAX_INLINE_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_INLINE_IMAGES = 20;

/** MIME Content-IDs are case-sensitive. Only the cid: scheme is case-insensitive. */
export function normalizeContentId(value: string): string {
  return value
    .trim()
    .replace(/^<(.*)>$/, '$1')
    .trim();
}

function imageContentId(source: string): string | undefined {
  if (!/^cid:/i.test(source)) return undefined;
  try {
    return normalizeContentId(decodeURIComponent(source.slice(4))) || undefined;
  } catch {
    return undefined;
  }
}

function safeLink(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!['https:', 'http:', 'mailto:'].includes(url.protocol) || url.username || url.password)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function safeImageUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // Only the app-owned CID map can supply raster data. Email-supplied data/blob URLs remain blocked.
  if (value.startsWith('data:'))
    return value.length <= Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4 + 64 &&
      /^data:image\/(?:png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value)
      ? value
      : undefined;
  try {
    const url = new URL(value);
    // Only ordinary HTTPS storage origins may enter the iframe's CSP attribute.
    // URL accepts some host punctuation that has separate meaning in CSP or HTML.
    return url.protocol === 'https:' &&
      /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(url.origin) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Remote images are an explicit reader policy, including one-pixel tracking images. */
function remoteImageUrl(value: string): string | undefined {
  try {
    const url = new URL(value.startsWith('//') ? `https:${value}` : value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !/^https?:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(url.origin) ||
      url.username ||
      url.password
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/**
 * Render Letter to a string, never into the parent DOM. Its email-aware CSS sanitizer keeps
 * sender formatting; DOMPurify first removes active markup. Our opaque frame supplies CSP,
 * no-referrer and automatic height, which Letter's built-in iframe cannot configure.
 */
export function sanitizeEmailHtml(
  html: string,
  inlineImageUrls: ReadonlyMap<string, string> = new Map(),
) {
  const purified = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: allowedTags,
    FORCE_BODY: true,
    ALLOWED_ATTR: [
      'href',
      'src',
      'srcset',
      'sizes',
      'media',
      'type',
      'alt',
      'title',
      'colspan',
      'rowspan',
      'dir',
      'lang',
      'style',
      'class',
      'id',
      'width',
      'height',
      'align',
      'valign',
      'bgcolor',
      'border',
      'cellpadding',
      'cellspacing',
      'color',
      'face',
      'size',
    ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  const contentIds = new Set<string>();
  const imageOrigins = new Set<string>();
  const resourceUrls = new Map<string, string>();
  const resourceToken = Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('');
  const tokenPrefix = `https://email-resource.invalid/${resourceToken}/`;
  const resolveImageResource = (value: string): string => {
    const contentId = imageContentId(value);
    if (contentId) contentIds.add(contentId);
    const source = contentId ? safeImageUrl(inlineImageUrls.get(contentId)) : remoteImageUrl(value);
    if (!source) return '';
    imageOrigins.add(source.startsWith('data:') ? 'data:' : new URL(source).origin);
    return source;
  };
  const tokenizeResource = (value: string): string => {
    const source = resolveImageResource(value);
    if (!source) return '';
    const token = `${tokenPrefix}${resourceUrls.size}`;
    resourceUrls.set(token, source);
    return token;
  };
  // Tokenize before Letter: its decodeURI/encodeURI pair otherwise corrupts signed CSS URLs.
  // Parse CSS in an inert document, never in the app DOM; also constrain nested media rules.
  const prepared = new DOMParser().parseFromString(purified, 'text/html');
  const prepareStyle = (style: CSSStyleDeclaration) => {
    for (const property of Array.from(style)) {
      const value = style.getPropertyValue(property);
      if (
        !allowedCssProperties.includes(property) ||
        /(?:\d|\.)\s*(?:[sld]?v|cq)(?:h|b|min|max)\b/i.test(value) ||
        /(?:expression|image-set|var)\s*\(/i.test(value)
      ) {
        style.removeProperty(property);
        continue;
      }
      const rewritten = value.replace(
        /url\(\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\s*\)/gi,
        (
          _match,
          doubleQuoted: string | undefined,
          singleQuoted: string | undefined,
          unquoted: string | undefined,
        ) => {
          const resource = (doubleQuoted ?? singleQuoted ?? unquoted ?? '').trim();
          // Escaped CSS URLs are uncommon; fail closed rather than mis-decoding them.
          return `url("${tokenizeResource(resource.includes('\\') ? '' : resource)}")`;
        },
      );
      style.setProperty(property, rewritten, style.getPropertyPriority(property));
    }
  };
  const prepareRules = (rules: CSSRuleList, insideMedia = false): string =>
    Array.from(rules)
      .flatMap((rule) => {
        if (rule.type === 1) {
          prepareStyle((rule as CSSStyleRule).style);
          return [rule.cssText];
        }
        if (rule.type === 4 && !insideMedia) {
          const media = rule as CSSMediaRule;
          if (!isEmailMediaHeightIndependent(media.conditionText)) return [];
          return [`@media ${media.conditionText} { ${prepareRules(media.cssRules, true)} }`];
        }
        return [];
      })
      .join('\n');
  const responsiveImages = prepareEmailResponsiveImages(
    prepared,
    resolveImageResource,
    `${tokenPrefix}image/`,
  );
  for (const element of prepared.querySelectorAll<HTMLElement>('[style]')) {
    prepareStyle(element.style);
    if (!element.style.length) element.removeAttribute('style');
  }
  for (const element of prepared.querySelectorAll('style')) {
    if (element.sheet) element.textContent = prepareRules(element.sheet.cssRules);
    else element.remove();
  }
  const rendered = renderToStaticMarkup(
    createElement(Letter, {
      html: prepared.documentElement.outerHTML,
      rewriteExternalResources: (token) =>
        resourceUrls.has(token) || responsiveImages.hasMarker(token) ? token : '',
      rewriteExternalLinks: (value) => safeLink(value) ?? '',
    }),
  );
  const fragment = DOMPurify.sanitize(rendered, {
    ADD_TAGS: ['style'],
    RETURN_DOM_FRAGMENT: true,
    ALLOW_DATA_ATTR: false,
  });
  const restoreCssUrls = (value: string): string =>
    value.replace(/https:\/\/email-resource\.invalid\/[a-z0-9-]+\/\d+/g, (token) =>
      (resourceUrls.get(token) ?? '').replace(
        /["\\<]/g,
        (character) => `\\${character.charCodeAt(0).toString(16)} `,
      ),
    );
  for (const element of fragment.querySelectorAll<HTMLElement>('[style]')) {
    element.setAttribute('style', restoreCssUrls(element.getAttribute('style') ?? ''));
  }
  for (const element of fragment.querySelectorAll('style'))
    element.textContent = restoreCssUrls(element.textContent ?? '');
  responsiveImages.restore(fragment);
  for (const link of fragment.querySelectorAll('a')) {
    const target = safeLink(link.getAttribute('href') ?? '');
    if (target) {
      link.setAttribute('href', target);
      link.setAttribute('target', '_blank');
      link.setAttribute('rel', 'noopener noreferrer');
      link.setAttribute('referrerpolicy', 'no-referrer');
    } else {
      link.removeAttribute('href');
    }
  }
  let blockedImageCount = 0;
  for (const image of fragment.querySelectorAll('img')) {
    if (
      image.getAttribute('src') ||
      image.getAttribute('srcset') ||
      (image.parentElement?.tagName === 'PICTURE' &&
        image.parentElement.querySelector('source[srcset]'))
    ) {
      image.setAttribute('referrerpolicy', 'no-referrer');
    } else {
      blockedImageCount += 1;
      const placeholder = fragment.ownerDocument.createElement('span');
      placeholder.textContent = `[${image.getAttribute('alt') || 'Image'} not loaded]`;
      image.replaceWith(placeholder);
    }
  }
  const container = fragment.ownerDocument.createElement('div');
  container.append(fragment);
  return {
    html: constrainEmailLayout(container.innerHTML),
    contentIds: [...contentIds],
    blockedImageCount,
    imageOrigins: [...imageOrigins],
  };
}

/** Fail closed on ambiguous Content-IDs, non-images, unreferenced parts and oversized messages. */
export function selectInlineAttachments(
  attachments: AttachmentSummaryResponse[],
  contentIds: string[],
) {
  const matches = new Map<string, AttachmentSummaryResponse[]>();
  for (const attachment of attachments) {
    if (!attachment.contentId) continue;
    const contentId = normalizeContentId(attachment.contentId);
    if (!contentId) continue;
    const existing = matches.get(contentId) ?? [];
    existing.push(attachment);
    matches.set(contentId, existing);
  }
  return contentIds
    .flatMap((contentId) => {
      const candidates = matches.get(contentId);
      const attachment = candidates?.length === 1 ? candidates[0] : undefined;
      return attachment?.isInline &&
        rasterImageTypes.has(attachment.contentType.toLowerCase()) &&
        attachment.sizeBytes <= MAX_INLINE_IMAGE_BYTES
        ? [{ contentId, attachment }]
        : [];
    })
    .slice(0, MAX_INLINE_IMAGES);
}
