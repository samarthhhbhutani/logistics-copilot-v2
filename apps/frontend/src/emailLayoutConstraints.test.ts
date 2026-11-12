// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sanitizeEmailHtml } from './sanitizeEmailHtml.js';
import { constrainEmailLayout } from './emailLayoutConstraints.js';

// jsdom's inert documents do not expose style sheets. Parse only synthetic CSS in
// its active CSSOM for unit tests; Chromium e2e exercises the real inert pipeline.
beforeEach(() => {
  const getSheet = Object.getOwnPropertyDescriptor(HTMLStyleElement.prototype, 'sheet')!.get!;
  vi.spyOn(HTMLStyleElement.prototype, 'sheet', 'get').mockImplementation(function (
    this: HTMLStyleElement,
  ) {
    const sheet = getSheet.call(this) as CSSStyleSheet | null;
    if (sheet) return sheet;
    const style = document.createElement('style');
    style.textContent = this.textContent;
    document.head.append(style);
    const parsed = getSheet.call(style) as CSSStyleSheet;
    style.remove();
    return parsed;
  });
});
afterEach(() => vi.restoreAllMocks());

function sanitizedDocument(html: string) {
  return new DOMParser().parseFromString(sanitizeEmailHtml(html).html, 'text/html');
}

function cssRules(document: Document): CSSStyleRule[] {
  return [...document.querySelectorAll('style')].flatMap((style) =>
    Array.from(style.sheet?.cssRules ?? []),
  ) as CSSStyleRule[];
}

describe('email layout constraints', () => {
  it('bounds table attributes without overriding author styles or column proportions', () => {
    const document = sanitizedDocument(
      '<table width="550"><colgroup><col width="400"><col width="200"></colgroup><tr><td width="400">Route</td><td width="200">Rate</td></tr></table>',
    );
    const table = document.querySelector('table')!;
    expect(table.style.width).toBe('');
    expect(table.getAttribute('width')).toBe('550');
    expect(
      cssRules(document).some(
        (rule) =>
          rule.selectorText.startsWith(':where(') && rule.style.width === 'min(100%, 550px)',
      ),
    ).toBe(true);
    expect(
      [...document.querySelectorAll('td,col')].map((cell) => cell.getAttribute('width')),
    ).toEqual(['400', '200', '400', '200']);
    expect(
      document.querySelector('td[data-email-layout-width], col[data-email-layout-width]'),
    ).toBeNull();
  });

  it('bounds inline widths/minimums and preserves !important, typography and padding', () => {
    const document = sanitizedDocument(
      '<div style="width:1000px!important;min-width:900px!important;padding:0 40px;font-size:15px;color:red">Text</div><table style="width:1456px;min-width:1456px;table-layout:fixed!important"><tr><td style="width:970px">Wide</td><td style="width:486px">Narrow</td></tr></table>',
    );
    const container = document.querySelector('div[style]')! as HTMLElement;
    expect(container.style.width).toBe('min(100%, 1000px)');
    expect(container.style.minWidth).toBe('min(100%, 900px)');
    expect(container.style.getPropertyPriority('width')).toBe('important');
    expect(container.style.padding).toBe('0px 40px');
    expect(container.style.fontSize).toBe('15px');
    expect(container.style.color).toBe('red');
    expect(document.querySelector('table')!.style.width).toBe('min(100%, 1456px)');
    expect(document.querySelector('td')!.style.width).toBe('970px');
    expect(document.querySelector('table')!.style.tableLayout).toBe('auto');
    expect(document.querySelector('table')!.style.getPropertyPriority('table-layout')).toBe(
      'important',
    );
  });

  it('keeps each stylesheet override adjacent and does not promote selector-list specificity', () => {
    const document = new DOMParser().parseFromString(
      constrainEmailLayout(
        '<div id="message"><style>.shared, #special {width:1456px!important;min-width:1456px} .shared {width:600px!important} @media (max-width:700px) {.shared {width:100%!important}}</style><table class="shared"><tr><td class="shared">Rate</td></tr></table></div>',
      ),
      'text/html',
    );
    const rules = cssRules(document);
    expect(rules).toHaveLength(7);
    expect(rules[0]!.style.width).toBe('1456px');
    expect(rules[1]!.style.width).toBe('min(100%, 1456px)');
    expect(rules[1]!.style.getPropertyPriority('width')).toBe('important');
    expect(rules[1]!.selectorText).toContain(':is(.shared):where(');
    expect(rules[1]!.selectorText).not.toMatch(/:is\([^)]*,/);
    expect(rules[2]!.style.minWidth).toBe('min(100%, 1456px)');
    expect(rules[4]!.style.width).toBe('600px');
    expect(rules[5]!.style.width).toBe('min(100%, 600px)');
    const media = rules[6] as unknown as CSSMediaRule;
    expect(media.conditionText.replace(/\s/g, '')).toBe('(max-width:700px)');
    expect((media.cssRules[1] as CSSStyleRule).style.width).toBe('min(100%, 100%)');
  });

  it('does not enlarge small images or trust sender-owned markers, scripts or custom properties', () => {
    const document = sanitizedDocument(
      '<img src="https://images.example/logo.png" width="80" height="40" style="height:40px!important" data-email-layout-width="999" onload="alert(1)"><div style="--preferred:9999px;width:var(--preferred)">Safe</div><script>alert(1)</script>',
    );
    const image = document.querySelector('img')!;
    expect(image.getAttribute('width')).toBe('80');
    expect(image.getAttribute('data-email-layout-width')).toBe('0');
    expect(image.style.height).toBe('auto');
    expect(image.style.getPropertyPriority('height')).toBe('important');
    expect(document.querySelector('script,[onload]')).toBeNull();
    expect(document.body.innerHTML).not.toContain('--preferred');
  });

  it('preserves smaller max-width constraints and escapes serialized CSS end tags', () => {
    const html = constrainEmailLayout(
      String.raw`<div><style>.column {max-width:600px;background:url("https://images.example/a?x=\3c /style\3e ")}</style><div style="max-width:600px">Centered</div><table width="600px"><tr><td>Rate</td></tr></table></div>`,
    );
    const document = new DOMParser().parseFromString(html, 'text/html');
    expect(cssRules(document).some((rule) => rule.style.maxWidth === 'min(100%, 600px)')).toBe(
      true,
    );
    expect((document.querySelector('div[style]') as HTMLElement).style.maxWidth).toBe(
      'min(100%, 600px)',
    );
    expect(html.match(/<\/style>/gi)).toHaveLength(2);
    expect(document.querySelectorAll('style')).toHaveLength(2);
    expect(document.body.textContent).toContain('Centered');
    expect(document.querySelector('table')!.hasAttribute('data-email-layout-width')).toBe(true);
  });

  it('keeps sizing keywords and ignores malformed attributes rather than creating invalid CSS', () => {
    const document = sanitizedDocument(
      '<table width="bad; color:red" style="width:auto"><tr><td>Rate</td></tr></table><div style="width:fit-content">Auto</div><img src="https://images.example/x.png" width="20%">',
    );
    expect(document.querySelector('table')!.style.width).toBe('auto');
    expect(document.querySelector('table')!.hasAttribute('data-email-layout-width')).toBe(false);
    expect((document.querySelector('div[style]') as HTMLElement).style.width).toBe('fit-content');
    expect(cssRules(document).some((rule) => rule.style.width === 'min(100%, 20%)')).toBe(true);
  });
});
