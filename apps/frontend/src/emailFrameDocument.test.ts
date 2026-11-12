// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createEmailDocument,
  emailFrameLayoutScript,
  emailFrameLayoutScriptHash,
  MAX_EMAIL_FRAME_HEIGHT,
  parseEmailFrameLayout,
} from './emailFrameDocument.js';
import { sanitizeEmailHtml } from './sanitizeEmailHtml.js';

afterEach(() => vi.unstubAllGlobals());

describe('email frame document', () => {
  it('permits exactly the immutable layout helper and no email executable content', () => {
    const document = new DOMParser().parseFromString(
      createEmailDocument(
        sanitizeEmailHtml(
          '<p onclick="parent.alert(1)">Hello</p><script>parent.alert(1)</script><script src="https://evil.example/x"></script>',
        ),
      ),
      'text/html',
    );
    const scripts = document.querySelectorAll('script');
    expect(scripts).toHaveLength(1);
    expect(scripts[0]?.textContent).toBe(emailFrameLayoutScript);
    expect(emailFrameLayoutScriptHash).toBe(
      `sha256-${createHash('sha256').update(emailFrameLayoutScript).digest('base64')}`,
    );
    const policy = document
      .querySelector('meta[http-equiv="Content-Security-Policy"]')
      ?.getAttribute('content');
    expect(policy).toContain(`script-src '${emailFrameLayoutScriptHash}'`);
    expect(policy).toContain("script-src-attr 'none'");
    expect(policy).not.toMatch(/script-src[^;]*unsafe-inline|unsafe-eval|nonce-/);
    expect(document.querySelector('[onclick]')).toBeNull();
    expect(document.body.textContent).not.toContain('parent.alert');
  });

  it.each([
    undefined,
    null,
    [],
    {},
    { type: 'other', height: 80, failedImageCount: 0 },
    { type: 'emailFrameLayout', height: Infinity, failedImageCount: 0 },
    { type: 'emailFrameLayout', height: -1, failedImageCount: 0 },
    { type: 'emailFrameLayout', height: 10.5, failedImageCount: 0 },
    { type: 'emailFrameLayout', height: MAX_EMAIL_FRAME_HEIGHT + 1, failedImageCount: 0 },
    { type: 'emailFrameLayout', height: '100', failedImageCount: 0 },
    { type: 'emailFrameLayout', height: 100, failedImageCount: -1 },
    { type: 'emailFrameLayout', height: 100, failedImageCount: Infinity },
    { type: 'emailFrameLayout', height: 100, failedImageCount: 0, body: 'unexpected' },
  ])('rejects malformed or excessive layout payload %#', (value) => {
    expect(parseEmailFrameLayout(value)).toBeUndefined();
  });

  it('accepts bounded intrinsic height including empty documents', () => {
    expect(
      parseEmailFrameLayout({ type: 'emailFrameLayout', height: 350, failedImageCount: 1 }),
    ).toEqual({ height: 350, failedImageCount: 1 });
    expect(
      parseEmailFrameLayout({ type: 'emailFrameLayout', height: 0, failedImageCount: 0 })?.height,
    ).toBe(1);
  });

  it('reports only dimensions and image failure count on initial layout, resize and image events', () => {
    const message = vi.fn();
    const observe = vi.fn();
    const bodyEvents = new Map<string, () => void>();
    let resized: () => void = () => {};
    let intrinsicHeight = 200.2;
    const body = {
      getBoundingClientRect: () => ({ height: intrinsicHeight }),
      querySelectorAll: () => [
        { complete: true, naturalWidth: 0 },
        { complete: false, naturalWidth: 0 },
        { complete: true, naturalWidth: 400 },
      ],
      addEventListener: (name: string, listener: () => void) => bodyEvents.set(name, listener),
    };
    class TestResizeObserver {
      constructor(callback: () => void) {
        resized = callback;
      }
      observe = observe;
    }
    vi.stubGlobal('document', { body });
    vi.stubGlobal('parent', { postMessage: message });
    vi.stubGlobal('ResizeObserver', TestResizeObserver);
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => callback());
    vi.stubGlobal('addEventListener', vi.fn());
    // Execute only the fixed app source, never email HTML.
    new Function(emailFrameLayoutScript)();
    expect(observe).toHaveBeenCalledWith(body);
    expect(message).toHaveBeenLastCalledWith(
      { type: 'emailFrameLayout', height: 201, failedImageCount: 1 },
      '*',
    );
    intrinsicHeight = 500;
    resized();
    expect(message).toHaveBeenLastCalledWith(
      { type: 'emailFrameLayout', height: 500, failedImageCount: 1 },
      '*',
    );
    bodyEvents.get('load')?.();
    bodyEvents.get('error')?.();
    expect(message).toHaveBeenCalledTimes(4);
  });
});
