import { expect, test } from '@playwright/test';
import type { Page, Request, Route } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const appOrigin = 'http://127.0.0.1:4180';
const subject = 'RFQ: Mumbai to Rotterdam · 2 × 40ft';
const inlineSampleSubject = 'Clearance charges - Mundra import (inline image sample)';
const storageUrlPattern = 'https://127.0.0.1:4184/**';
const bucketUrlPattern = 'https://fake-bucket.example/**';
const corsHeaders = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': appOrigin };

function messageLink(page: Page, linkSubject: string) {
  return page.getByRole('link').filter({ has: page.getByText(linkSubject, { exact: true }) });
}

function retryImagesButton(page: Page) {
  return page.getByRole('button', { name: 'Retry images', exact: true });
}

async function fillLogin(page: Page, password = 'frontend-test-password') {
  await page.getByLabel('Work email').fill('ops@example.com');
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}

async function signIn(page: Page) {
  await page.goto('/login');
  await fillLogin(page);
  await expect(messageLink(page, subject)).toBeVisible();
}

function collectRequests(page: Page, matches: (request: Request) => boolean): Request[] {
  const requests: Request[] = [];
  page.context().on('request', (request) => {
    if (matches(request)) requests.push(request);
  });
  return requests;
}

/** Decoded PNG bytes of the logo part in the synthetic MIME fixture the API seeds from. */
async function syntheticInlineLogoPng(): Promise<Buffer> {
  const mime = await readFile(
    new URL(
      '../../../packages/core/src/utils/mime/fixtures/inlineLogoSignature.eml',
      import.meta.url,
    ),
    'utf8',
  );
  const logoPart = mime
    .split('--rel-boundary')
    .find((part) => part.includes('Content-ID: <logo@swiftcha>'));
  const base64 = logoPart?.split(/\r?\n\r?\n/)[1]?.replace(/\s+/g, '');
  if (!base64) throw new Error('logo part missing from inlineLogoSignature.eml');
  return Buffer.from(base64, 'base64');
}

function fulfillStoredLogo(route: Route, logoBytes: Buffer) {
  return route.fulfill({
    status: 200,
    contentType: 'image/png',
    headers: corsHeaders,
    body: logoBytes,
  });
}

function fulfillStorageStatus(route: Route, status: number) {
  return route.fulfill({
    status,
    contentType: 'application/xml',
    headers: corsHeaders,
    body: `<Error><Code>${status === 403 ? 'AccessDenied' : 'SlowDown'}</Code></Error>`,
  });
}

async function expectInlineLogoRendered(page: Page) {
  const logo = page
    .frameLocator('iframe[title="Email message body"]')
    .getByRole('img', { name: 'Swift CHA' });
  await expect(logo).toHaveAttribute('src', /^data:image\/png;base64,/, { timeout: 30_000 });
  await expect
    .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(retryImagesButton(page)).toHaveCount(0);
}

test('first mail load retries two transient API failures without a user click', async ({
  page,
}) => {
  const listRequests = collectRequests(page, (request) =>
    request.url().includes('/v1/mailbox/emails?'),
  );
  let failuresLeft = 2;
  await page.route('**/v1/mailbox/emails?**', async (route) => {
    failuresLeft -= 1;
    if (failuresLeft === 1) await route.fulfill({ status: 503, json: { error: 'unavailable' } });
    else if (failuresLeft === 0) await route.abort('connectionreset');
    else await route.continue();
  });
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Mail could not be loaded' })).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(listRequests).toHaveLength(3);
});

test('login replays two transient failures but never replays rejected credentials', async ({
  page,
}) => {
  const loginRequests = collectRequests(
    page,
    (request) => request.method() === 'POST' && request.url().endsWith('/v1/auth/login'),
  );
  await page.goto('/login');
  await fillLogin(page, 'wrong-password');
  await expect(page.getByRole('alert')).toContainText('do not match');
  // Longer than both backoff delays, so a mistaken replay would have been sent by now.
  await page.waitForTimeout(1_600);
  expect(loginRequests).toHaveLength(1);

  let transientFailuresLeft = 2;
  await page.route('**/v1/auth/login', async (route) => {
    if (transientFailuresLeft-- > 0)
      await route.fulfill({ status: 503, json: { error: 'unavailable' } });
    else await route.continue();
  });
  await fillLogin(page);
  await expect(messageLink(page, subject)).toBeVisible();
  expect(loginRequests).toHaveLength(4);
});

test('CID image survives two storage connection resets and the frame never refetches storage', async ({
  page,
}) => {
  const logoBytes = await syntheticInlineLogoPng();
  const signingRequests = collectRequests(page, (request) =>
    request.url().endsWith('/download-url'),
  );
  const storageReferrers: (string | null)[] = [];
  await page.context().route(storageUrlPattern, async (route) => {
    storageReferrers.push(await route.request().headerValue('referer'));
    if (storageReferrers.length <= 2) await route.abort('connectionreset');
    else await fulfillStoredLogo(route, logoBytes);
  });
  await signIn(page);
  await messageLink(page, inlineSampleSubject).click();
  await expectInlineLogoRendered(page);
  await page.waitForTimeout(500);
  expect(storageReferrers).toEqual([null, null, null]);
  expect(signingRequests).toHaveLength(1);
});

test('a stalled storage response times out after five seconds and the retry renders the logo', async ({
  page,
}) => {
  test.setTimeout(30_000);
  const logoBytes = await syntheticInlineLogoPng();
  const storageRequestTimes: number[] = [];
  await page.context().route(storageUrlPattern, async (route) => {
    storageRequestTimes.push(Date.now());
    if (storageRequestTimes.length > 1) {
      await fulfillStoredLogo(route, logoBytes);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    // The client has abandoned this attempt by now; a late reply has nowhere to go.
    await fulfillStoredLogo(route, logoBytes).catch(() => {});
  });
  await signIn(page);
  await messageLink(page, inlineSampleSubject).click();
  await expect(page.locator('.htmlEmailBody').getByRole('status')).toHaveText('Loading images…');
  await expect(retryImagesButton(page)).toHaveCount(0);
  await expectInlineLogoRendered(page);
  expect(storageRequestTimes).toHaveLength(2);
  const retryGapMs = storageRequestTimes[1]! - storageRequestTimes[0]!;
  expect(retryGapMs).toBeGreaterThanOrEqual(4_500);
  expect(retryGapMs).toBeLessThan(10_000);
});

test('a storage body that stalls after its headers is abandoned at the total deadline and retried', async ({
  page,
}, testInfo) => {
  test.setTimeout(45_000);
  const retryCase = `${testInfo.project.name}-${Date.now()}`;
  // The deadline starts at fetch(), before browser queuing and the network request event.
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const attempts: { startedAt: number; abortedAt?: number }[] = [];
    Object.assign(window, { storageFetchAttempts: attempts });
    window.fetch = (input, options) => {
      if (typeof input === 'string' && input.includes('retryScenario=slowBody')) {
        const attempt: { startedAt: number; abortedAt?: number } = { startedAt: performance.now() };
        attempts.push(attempt);
        options?.signal?.addEventListener(
          'abort',
          () => {
            attempt.abortedAt = performance.now();
          },
          { once: true },
        );
      }
      return originalFetch(input, options);
    };
  });
  await page.route('**/download-url', async (route) => {
    const response = await route.fetch();
    const signed = await response.json();
    const url = new URL(signed.url);
    url.searchParams.set('retryScenario', 'slowBody');
    url.searchParams.set('retryCase', retryCase);
    await route.fulfill({ response, json: { ...signed, url: url.toString() } });
  });
  const storageRequests: { startedAt: number; request: Request }[] = [];
  const storageResponses: number[] = [];
  page.context().on('request', (request) => {
    if (request.url().includes(`retryCase=${retryCase}`))
      storageRequests.push({ startedAt: Date.now(), request });
  });
  page.context().on('response', (response) => {
    if (response.url().includes(`retryCase=${retryCase}`)) storageResponses.push(response.status());
  });
  await signIn(page);
  await messageLink(page, inlineSampleSubject).click();
  await expect.poll(() => storageResponses).toEqual([200]);
  await expect(page.locator('.htmlEmailBody').getByRole('status')).toHaveText('Loading images…');
  await expect(retryImagesButton(page)).toHaveCount(0);
  await expect.poll(() => storageRequests.length, { timeout: 30_000 }).toBe(2);
  const fetchAttempts = await page.evaluate(
    () =>
      (
        window as typeof window & {
          storageFetchAttempts: { startedAt: number; abortedAt?: number }[];
        }
      ).storageFetchAttempts,
  );
  const firstAttempt = fetchAttempts[0]!;
  expect(firstAttempt.abortedAt).toBeDefined();
  expect(firstAttempt.abortedAt! - firstAttempt.startedAt).toBeGreaterThanOrEqual(19_000);
  expect(firstAttempt.abortedAt! - firstAttempt.startedAt).toBeLessThanOrEqual(25_000);
  const retryGapMs = fetchAttempts[1]!.startedAt - firstAttempt.startedAt;
  expect(retryGapMs).toBeGreaterThanOrEqual(20_000);
  expect(retryGapMs).toBeLessThanOrEqual(26_000);
  await expectInlineLogoRendered(page);
  expect(storageRequests.map(({ request }) => request.method())).toEqual(['GET', 'GET']);
});

test('three transient storage failures show Retry images; a 403 is requested only once', async ({
  page,
}) => {
  let storageStatus = 503;
  const storageRequests: string[] = [];
  await page.context().route(storageUrlPattern, async (route) => {
    storageRequests.push(route.request().url());
    await fulfillStorageStatus(route, storageStatus);
  });
  await signIn(page);
  await messageLink(page, inlineSampleSubject).click();
  const body = page.frameLocator('iframe[title="Email message body"]');
  await expect(page.getByRole('alert')).toContainText('Some images could not be loaded.');
  await expect(body.getByText('[Swift CHA not loaded]')).toBeVisible();
  await expect(retryImagesButton(page)).toBeVisible();
  expect(storageRequests).toHaveLength(3);

  storageStatus = 403;
  await retryImagesButton(page).click();
  await expect.poll(() => storageRequests.length).toBe(4);
  await expect(retryImagesButton(page)).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('Some images could not be loaded.');
  await page.waitForTimeout(1_600);
  expect(storageRequests).toHaveLength(4);
});

test('storage responses without CORS approval fail closed after three attempts', async ({
  page,
}) => {
  // route.fulfill adds ACAO automatically. Use the real HTTPS fixture to exercise browser CORS.
  await page.route('**/download-url', async (route) => {
    const response = await route.fetch();
    const signed = await response.json();
    const url = new URL(signed.url);
    url.searchParams.set('retryScenario', 'corsDenied');
    await route.fulfill({ response, json: { ...signed, url: url.toString() } });
  });
  const storageRequests = collectRequests(page, (request) =>
    request.url().includes('retryScenario=corsDenied'),
  );
  await signIn(page);
  await messageLink(page, inlineSampleSubject).click();
  const body = page.frameLocator('iframe[title="Email message body"]');
  await expect(page.getByRole('alert')).toContainText('Some images could not be loaded.');
  await expect(body.getByText('[Swift CHA not loaded]')).toBeVisible();
  await expect(body.locator('img')).toHaveCount(0);
  await expect(retryImagesButton(page)).toBeVisible();
  await page.waitForTimeout(1_600);
  expect(storageRequests).toHaveLength(3);
});

test('file download survives two storage resets and sends no referrer or cookies', async ({
  page,
  context,
}) => {
  await context.addCookies([
    {
      name: 'bucketProbe',
      value: 'synthetic',
      domain: 'fake-bucket.example',
      path: '/',
      secure: true,
    },
  ]);
  const bucketRequestHeaders: Record<string, string>[] = [];
  await context.route(bucketUrlPattern, async (route) => {
    bucketRequestHeaders.push(await route.request().allHeaders());
    if (bucketRequestHeaders.length <= 2) {
      await route.abort('connectionreset');
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      headers: {
        ...corsHeaders,
        'Content-Disposition': 'attachment; filename="sailing-offer.pdf"',
      },
      body: 'Synthetic attachment only',
    });
  });
  const signingRequests = collectRequests(page, (request) =>
    request.url().endsWith('/download-url'),
  );
  await signIn(page);
  await messageLink(page, subject).click();
  await page.getByRole('button', { name: 'Show files' }).first().click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download sailing-offer.pdf' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('sailing-offer.pdf');
  expect(await download.failure()).toBeNull();
  expect(await readFile((await download.path())!, 'utf8')).toBe('Synthetic attachment only');
  await download.delete();
  expect(bucketRequestHeaders).toHaveLength(3);
  for (const headers of bucketRequestHeaders) {
    expect(headers['referer']).toBeUndefined();
    expect(headers['cookie']).toBeUndefined();
  }
  expect(signingRequests).toHaveLength(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('a mailbox switch while file bytes transfer signs out without saving the file', async ({
  page,
  context,
}) => {
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await context.route(bucketUrlPattern, async (route) => {
    // Cookies are shared across tabs: another tab signs in to a different mailbox mid-transfer.
    await context.request.post('/v1/auth/login', {
      data: { email: 'sales@example.com', password: 'frontend-test-password' },
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      headers: {
        ...corsHeaders,
        'Content-Disposition': 'attachment; filename="sailing-offer.pdf"',
      },
      body: 'Synthetic attachment only',
    });
  });
  await signIn(page);
  await messageLink(page, subject).click();
  await page.getByRole('button', { name: 'Show files' }).first().click();
  await page.getByRole('button', { name: 'Download sailing-offer.pdf' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByText('Thanks for the quote.')).toHaveCount(0);
  expect(downloads).toEqual([]);
});

test('navigating away during retry backoff stops further download requests', async ({ page }) => {
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  const signingRequests = collectRequests(page, (request) =>
    request.url().endsWith('/download-url'),
  );
  // Retry-After stretches the backoff so navigation reliably lands inside it.
  await page.route('**/download-url', (route) =>
    route.fulfill({
      status: 503,
      headers: { 'Retry-After': '2' },
      json: { error: 'attachments_unavailable' },
    }),
  );
  await signIn(page);
  await messageLink(page, subject).click();
  await page.getByRole('button', { name: 'Show files' }).first().click();
  const firstFailure = page.waitForResponse('**/download-url');
  await page.getByRole('button', { name: 'Download sailing-offer.pdf' }).click();
  await firstFailure;
  await page.getByRole('link', { name: 'Back to All mail' }).click();
  await expect(page.getByRole('heading', { name: 'All mail', exact: true })).toBeVisible();
  await page.waitForTimeout(3_000);
  expect(signingRequests).toHaveLength(1);
  expect(downloads).toEqual([]);
});
