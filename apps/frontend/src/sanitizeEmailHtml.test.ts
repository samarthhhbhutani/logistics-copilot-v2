// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { AttachmentSummaryResponse } from '@lc/contract';
import { createEmailDocument, emailFrameLayoutScriptHash } from './emailFrameDocument.js';
import {
  MAX_INLINE_IMAGE_BYTES,
  MAX_INLINE_IMAGES,
  sanitizeEmailHtml,
  selectInlineAttachments,
} from './sanitizeEmailHtml.js';

function parse(html: string) {
  return new DOMParser().parseFromString(html, 'text/html');
}
const attachment: AttachmentSummaryResponse = {
  id: '00000000-0000-4000-8000-000000000001',
  fileName: 'logo.png',
  contentType: 'image/png',
  sizeBytes: 100,
  isInline: true,
  contentId: '<Logo@company>',
};

describe('sanitizeEmailHtml', () => {
  it('keeps email formatting but removes active content, clobbering and embedded documents', () => {
    const result =
      sanitizeEmailHtml(`<base href="https://tracker.invalid"><meta http-equiv="refresh" content="0;url=https://tracker.invalid">
      <style>@import 'https://tracker.invalid';</style><script>alert(1)</script>
      <p id="location" name="cookie" class="hidden" style="background:url(https://tracker.invalid)" onclick="alert(1)">Hello <strong>world</strong></p>
      <table background="https://tracker.invalid"><tr><td colspan="2">Rate</td></tr></table>
      <form action="https://tracker.invalid"><input autofocus onfocus="alert(1)"></form>
      <iframe src="https://tracker.invalid"></iframe><object data="https://tracker.invalid"></object>
      <svg><a xlink:href="javascript:alert(1)">SVG</a></svg><math><mtext>Math</mtext></math>
      <video poster="https://tracker.invalid"><source src="https://tracker.invalid"></video>`);
    const document = parse(result.html);
    expect(document.body.textContent).toContain('Hello world');
    expect(document.querySelector('strong')?.textContent).toBe('world');
    expect(document.querySelector('td')?.getAttribute('colspan')).toBe('2');
    expect(
      document.querySelector(
        'script, base, meta, form, input, iframe, object, svg, math, video, source',
      ),
    ).toBeNull();
    expect(result.html).not.toMatch(/onclick|onfocus|name=|@import/);
    expect(document.querySelector('#location')).toBeNull();
  });

  it('loads remote and protocol-relative images, including trackers and CSS images', () => {
    const result = sanitizeEmailHtml(`<img src="https://tracker.invalid/pixel" width="1" height="1">
      <img src="//cdn.example/logo.png"><img src="http://cdn.example/banner.png">
      <div style="background-image:url(https://images.example/background.png)">Background</div>`);
    const document = parse(result.html);
    expect(document.querySelectorAll('img')).toHaveLength(3);
    expect(document.querySelector('img')?.getAttribute('width')).toBe('1');
    expect(document.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(result.imageOrigins).toEqual([
      'https://tracker.invalid',
      'https://cdn.example',
      'http://cdn.example',
      'https://images.example',
    ]);
    expect(document.querySelector('[style]')?.getAttribute('style')).toContain('background-image');
    expect(result.blockedImageCount).toBe(0);
  });

  it('rejects relative, data, blob and executable image URLs, including srcset', () => {
    const result = sanitizeEmailHtml(
      `<img src="/v1/me"><img src="data:image/png;base64,abc"><img src="blob:https://app.invalid/id"><img src="javascript:alert(1)"><img srcset="javascript:alert(1) 1x, /v1/me 2x">`,
    );
    expect(parse(result.html).querySelector('img')).toBeNull();
    expect(result.blockedImageCount).toBe(5);
    expect(result.imageOrigins).toEqual([]);
  });

  it('preserves safe srcset-only images, sizes and picture media selection', () => {
    const result = sanitizeEmailHtml(
      `<picture onclick="alert(1)"><source media="(max-width: 600px)" type="image/png" sizes="100vw" srcset="//mobile.example/small.png 400w, https://mobile.example/large.png 800w" onerror="alert(1)"><img srcset="https://desktop.example/a,b.png?sig=%2F 1x, https://desktop.example/large.png 2x" sizes="50vw" alt="Promo"></picture>`,
    );
    const document = parse(result.html);
    expect(document.querySelectorAll('picture > source')).toHaveLength(1);
    expect(document.querySelector('source')?.getAttribute('media')).toBe('(max-width: 600px)');
    expect(document.querySelector('source')?.getAttribute('type')).toBe('image/png');
    expect(document.querySelector('source')?.getAttribute('sizes')).toBe('100vw');
    expect(document.querySelector('source')?.getAttribute('srcset')).toBe(
      'https://mobile.example/small.png 400w, https://mobile.example/large.png 800w',
    );
    expect(document.querySelector('img')?.getAttribute('srcset')).toBe(
      'https://desktop.example/a,b.png?sig=%2F 1x, https://desktop.example/large.png 2x',
    );
    expect(document.querySelector('img')?.getAttribute('sizes')).toBe('50vw');
    expect(document.querySelector('img')?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(result.imageOrigins).toEqual(['https://mobile.example', 'https://desktop.example']);
    expect(result.blockedImageCount).toBe(0);
    expect(result.html).not.toMatch(/onclick|onerror|email-resource/);
  });

  it('resolves CID candidates in img and picture, keeps missing CIDs out of output', () => {
    const html =
      '<picture><source srcset="cid:Logo@company 1x, cid:missing 2x"><img srcset="CID:Logo%40company 1x" alt="Logo"></picture>';
    const pending = sanitizeEmailHtml(html);
    expect(pending.contentIds).toEqual(['Logo@company', 'missing']);
    expect(pending.blockedImageCount).toBe(1);
    const result = sanitizeEmailHtml(
      html,
      new Map([['Logo@company', 'https://storage.example/a%20b.png?sig=%2F&x=1']]),
    );
    expect(parse(result.html).querySelector('img')?.getAttribute('srcset')).toBe(
      'https://storage.example/a%20b.png?sig=%2F&x=1 1x',
    );
    expect(parse(result.html).querySelector('source')?.getAttribute('srcset')).toBe(
      'https://storage.example/a%20b.png?sig=%2F&x=1 1x',
    );
    expect(result.imageOrigins).toEqual(['https://storage.example']);
    expect(result.blockedImageCount).toBe(0);
  });

  it('filters unsafe candidates without losing a usable fallback or enabling orphan sources', () => {
    const result = sanitizeEmailHtml(
      `<source srcset="https://orphan.example/x 1x"><picture><source srcset="javascript:alert(1) 1x, data:image/png;base64,abc 2x, /v1/me 3x, https://user:password@evil.example/x 4x, blob:https://evil.example/x 5x"><img src="https://safe.example/fallback.png" srcset="https://safe.example/double.png 2x, javascript:alert(1) 3x"><source srcset="https://after.example/x 1x"></picture>`,
    );
    expect(parse(result.html).querySelector('source')).toBeNull();
    expect(parse(result.html).querySelector('img')?.getAttribute('src')).toBe(
      'https://safe.example/fallback.png',
    );
    expect(parse(result.html).querySelector('img')?.getAttribute('srcset')).toBe(
      'https://safe.example/double.png 2x',
    );
    expect(result.imageOrigins).toEqual(['https://safe.example']);
    expect(result.html).not.toMatch(
      /javascript:|data:|blob:|evil.example|orphan.example|after.example/,
    );
  });

  it('keeps an img backed only by picture sources and isolates picture metadata per image', () => {
    const result = sanitizeEmailHtml(
      '<picture><source srcset="https://a.example/logo.png 1x"><img alt="Picture only"></picture><img src="https://b.example/other.png" alt="Other">',
    );
    const document = parse(result.html);
    expect(document.querySelector('picture > img')?.getAttribute('alt')).toBe('Picture only');
    expect(document.querySelectorAll('img')).toHaveLength(2);
    expect(document.querySelector('img[alt="Other"]')?.parentElement?.tagName).not.toBe('PICTURE');
    expect(result.blockedImageCount).toBe(0);
  });

  it('does not sign discarded candidates or preserve height-dependent picture selection', () => {
    const result = sanitizeEmailHtml(
      `<picture><source media="(max-height: 400px)" srcset="cid:height 1x"><source media="(max-width: 600px)" sizes="(max-height:400px) 2000px, 10px" srcset="https://safe.example/narrow 1x"><img src="https://safe.example/fallback" sizes="100vh" srcset="cid:first 1x, cid:duplicate 1x, https://safe.example/b 2x"></picture><img srcset="cid:mixed 400w, cid:mixedToo 2x">`,
    );
    expect(result.contentIds).toEqual(['first']);
    const document = parse(result.html);
    expect(document.querySelector('source')?.getAttribute('media')).toBe('(max-width: 600px)');
    expect(document.querySelector('source')?.hasAttribute('sizes')).toBe(false);
    expect(document.querySelector('img')?.hasAttribute('sizes')).toBe(false);
    expect(document.querySelectorAll('source')).toHaveLength(1);
  });

  it.each([
    String.raw`100v\68`,
    String.raw`(max-h\65 ight: 400px) 50px, 10px`,
    '100cqh',
    '100cqb',
    '100cqmin',
    '100cqmax',
    'calc(100cqh)',
  ])('drops escaped or container-height-dependent responsive attributes: %s', (value) => {
    const result = sanitizeEmailHtml(
      `<picture><source media="${value}" srcset="cid:blocked 1x"><img src="https://safe.example/image" sizes="${value}"></picture>`,
    );
    const document = parse(result.html);
    expect(document.querySelector('source')).toBeNull();
    expect(document.querySelector('img')?.hasAttribute('sizes')).toBe(false);
    expect(result.contentIds).toEqual([]);
  });

  it('keeps readable text with malformed percent escapes in CSS', () => {
    expect(
      parse(
        sanitizeEmailHtml(
          '<p style="background:url(https://images.example/%XX)">Still readable</p>',
        ).html,
      ).body.textContent,
    ).toContain('Still readable');
  });

  it('does not require randomUUID or a secure browser context for resource tokens', () => {
    const randomUuid = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => {
      throw new Error('unavailable');
    });
    try {
      expect(sanitizeEmailHtml('<p>Hello</p>').html).toContain('Hello');
      expect(randomUuid).not.toHaveBeenCalled();
    } finally {
      randomUuid.mockRestore();
    }
  });

  it('preserves encoded and parenthesized resource URLs in images and CSS', () => {
    const result = sanitizeEmailHtml(
      `<img src="https://images.example/a(1).png"><p style="background-image:url('https://images.example/a%20b.png?x=%2F')">Remote</p><div style="background-image:url(cid:logo)">CID</div>`,
      new Map([['logo', 'https://storage.example/a%20b.png?sig=%2F']]),
    );
    const document = parse(result.html);
    expect(document.querySelector('img')?.getAttribute('src')).toBe(
      'https://images.example/a(1).png',
    );
    expect(document.querySelector('p')?.getAttribute('style')).toContain('a%20b.png?x=%2F');
    expect(result.html).toContain('a%20b.png?sig=%2F');
    expect(result.html).not.toContain('%25');
    expect(result.contentIds).toEqual(['logo']);
  });

  it.each([
    '100vh',
    '10dvh',
    '20svh',
    '100lvh',
    '10vmin',
    '20vmax',
    '20vb',
    '100cqh',
    '100cqb',
    '100cqmin',
    '100cqmax',
    'calc(2px + 100vh)',
  ])('removes viewport-height CSS that would feed back into iframe autoheight: %s', (height) => {
    const document = parse(
      sanitizeEmailHtml(`<div style="height:${height};color:red">Hello</div>`).html,
    );
    expect(document.querySelector('[style]')?.getAttribute('style')).not.toContain('height');
    expect(document.querySelector('[style]')?.getAttribute('style')).toContain('color');
  });

  it('only substitutes known cid images, decoding URL escapes without folding Content-ID case', () => {
    const result = sanitizeEmailHtml(
      '<img src="CID:%3CLogo%40company%3E" alt="Logo"><img src="cid:logo@company"><img src="cid:%XX">',
      new Map([['Logo@company', 'https://storage.example/image?signature=a&x=b']]),
    );
    const images = parse(result.html).querySelectorAll('img');
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute('src')).toBe('https://storage.example/image?signature=a&x=b');
    expect(images[0]?.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(result.contentIds).toEqual(['Logo@company', 'logo@company']);
    expect(result.imageOrigins).toEqual(['https://storage.example']);
    expect(result.blockedImageCount).toBe(2);
  });

  it.each([
    'http://storage.example/x',
    'javascript:alert(1)',
    'https://user:password@storage.example/x',
    'data:image/svg+xml,x',
    'https://a;b/image',
    'https://a"b/image',
    "https://a'b/image",
  ])('rejects unsafe resolved URL %s', (url) => {
    expect(
      parse(sanitizeEmailHtml('<img src="cid:logo">', new Map([['logo', url]])).html).querySelector(
        'img',
      ),
    ).toBeNull();
  });

  it('only allows explicit web and mailto links with no opener, referrer or app navigation', () => {
    const document = parse(
      sanitizeEmailHtml(`<a href="https://carrier.example/quote" target="_top" ping="https://tracker.invalid">Carrier</a>
      <a href="mailto:desk@example.com">Email</a><a href="javascript:alert(1)">Bad</a>
      <a href="/v1/auth/logout">Relative</a><a href="https://user@carrier.example">Credentials</a>`)
        .html,
    );
    expect(
      [...document.querySelectorAll('a[href]')].map((link) => link.getAttribute('href')),
    ).toEqual(['https://carrier.example/quote', 'mailto:desk@example.com']);
    for (const link of document.querySelectorAll('a[href]')) {
      expect(link.getAttribute('target')).toBe('_blank');
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(link.hasAttribute('ping')).toBe(false);
    }
  });

  it('builds a restrictive document policy and never interpolates the raw HTML', () => {
    const document = parse(
      createEmailDocument(sanitizeEmailHtml('<meta http-equiv="refresh"><p>Safe</p>')),
    );
    expect(
      document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
    ).toContain("img-src 'none'");
    expect(
      document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content'),
    ).toContain(`script-src '${emailFrameLayoutScriptHash}'`);
    expect(document.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(document.querySelector('p')?.textContent).toBe('Safe');
  });
});

describe('selectInlineAttachments', () => {
  it('matches only referenced safe raster inline parts, normalizing angle brackets', () => {
    expect(selectInlineAttachments([attachment], ['Logo@company'])).toEqual([
      { contentId: 'Logo@company', attachment },
    ]);
    expect(selectInlineAttachments([attachment], ['logo@company', 'unknown'])).toEqual([]);
    for (const fields of [
      { isInline: false },
      { contentId: null },
      { contentType: 'image/svg+xml' },
      { contentType: 'text/html' },
      { contentType: 'application/pdf' },
      { sizeBytes: MAX_INLINE_IMAGE_BYTES + 1 },
    ]) {
      expect(selectInlineAttachments([{ ...attachment, ...fields }], ['Logo@company'])).toEqual([]);
    }
  });
  it('never matches an empty Content-ID', () => {
    expect(sanitizeEmailHtml('<img src="cid:%3C%3E">').contentIds).toEqual([]);
    expect(selectInlineAttachments([{ ...attachment, contentId: '<>' }], [''])).toEqual([]);
  });
  it('rejects duplicate Content-IDs rather than choosing the wrong stored file', () => {
    expect(
      selectInlineAttachments([attachment, { ...attachment, id: 'other' }], ['Logo@company']),
    ).toEqual([]);
  });
  it('caps automatically loaded parts', () => {
    const attachments = Array.from({ length: MAX_INLINE_IMAGES + 1 }, (_, index) => ({
      ...attachment,
      contentId: `logo${index}`,
    }));
    expect(
      selectInlineAttachments(
        attachments,
        attachments.map((item) => item.contentId),
      ),
    ).toHaveLength(MAX_INLINE_IMAGES);
  });
});

describe('downloaded raster CID images', () => {
  it('rejects oversized app-supplied data before matching base64', () => {
    const dataUrl = `data:image/png;base64,${'A'.repeat(Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4 + 64)}`;
    const result = sanitizeEmailHtml('<img src="cid:logo">', new Map([['logo', dataUrl]]));
    expect(parse(result.html).querySelector('img')).toBeNull();
    expect(result.imageOrigins).toEqual([]);
  });

  it('permits app-supplied raster data for CID src, srcset and CSS only', () => {
    const dataUrl = 'data:image/png;base64,cG5n';
    const result = sanitizeEmailHtml(
      '<img src="cid:logo"><img srcset="cid:logo 1x"><div style="background-image:url(cid:logo)">Logo</div><img src="data:image/png;base64,cG5n">',
      new Map([['logo', dataUrl]]),
    );
    const document = parse(result.html);
    expect(document.querySelectorAll('img')).toHaveLength(2);
    expect(document.querySelector('img')?.getAttribute('src')).toBe(dataUrl);
    expect(document.querySelector('[srcset]')?.getAttribute('srcset')).toBe(`${dataUrl} 1x`);
    expect(document.querySelector('[style]')?.getAttribute('style')).toContain(dataUrl);
    expect(result.imageOrigins).toEqual(['data:']);
    expect(result.blockedImageCount).toBe(1);
    expect(createEmailDocument(result)).toContain('img-src data:');
    expect(createEmailDocument(result)).toContain("default-src 'none'");
  });
  it.each([
    'data:image/svg+xml;base64,PHN2Zz4=',
    'data:text/html;base64,PHNjcmlwdD4=',
    'data:image/png;base64,abc" onclick="alert(1)',
    'blob:https://app.example/id',
  ])('rejects non-raster or malformed app-supplied data %s', (dataUrl) => {
    expect(
      parse(
        sanitizeEmailHtml('<img src="cid:logo">', new Map([['logo', dataUrl]])).html,
      ).querySelector('img'),
    ).toBeNull();
  });
});
