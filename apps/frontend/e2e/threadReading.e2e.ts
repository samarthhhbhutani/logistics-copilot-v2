import { expect, test } from '@playwright/test';
import type { Page, Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import AxeBuilder from '@axe-core/playwright';
import { emailFrameLayoutScript, emailFrameLayoutScriptHash } from '../src/emailFrameDocument.js';

const selectedEmailId = '00000000-0000-4000-8000-000000000000';
const subject = 'RFQ: Mumbai to Rotterdam · 2 × 40ft';
function messageLink(page: Page, subject: string) {
  return page.getByRole('link').filter({ has: page.getByText(subject, { exact: true }) });
}
async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill('ops@example.com');
  await page.getByLabel('Password', { exact: true }).fill('frontend-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(messageLink(page, subject)).toBeVisible();
}
const inlineSampleSubject = 'Clearance charges - Mundra import (inline image sample)';
const inlineSampleEmailId = '00000000-0000-4000-8000-000000000003';
const messageFrameSelector = 'iframe[title="Email message body"]';
const storageUrlPattern = 'https://127.0.0.1:4184/**';

function messageFrame(page: Page) {
  return page.frameLocator(messageFrameSelector);
}

function retryImagesButton(page: Page) {
  return page.getByRole('button', { name: 'Retry images', exact: true });
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

// no-store keeps the browser from reusing the parent's decode for the frame's own image load.
function fulfillStoredLogo(route: Route, logoBytes: Buffer) {
  return route.fulfill({
    status: 200,
    contentType: 'image/png',
    headers: { 'Cache-Control': 'no-store' },
    body: logoBytes,
  });
}

function fulfillStorageDenied(route: Route) {
  return route.fulfill({
    status: 403,
    contentType: 'application/xml',
    headers: { 'Cache-Control': 'no-store' },
    body: '<Error><Code>AccessDenied</Code></Error>',
  });
}

function collectRemoteRequests(page: Page): string[] {
  const remoteRequests: string[] = [];
  page.context().on('request', (request) => {
    const url = new URL(request.url());
    if (['http:', 'https:'].includes(url.protocol) && url.hostname !== '127.0.0.1')
      remoteRequests.push(request.url());
  });
  return remoteRequests;
}

function collectSigningRequests(page: Page): string[] {
  const signingRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/download-url')) signingRequests.push(request.url());
  });
  return signingRequests;
}

async function openThread(page: Page) {
  await messageLink(page, subject).click();
  await expect(page.getByRole('heading', { name: subject, exact: true })).toBeVisible();
}

async function expectNoReaderModeControls(page: Page) {
  await expect(
    page.getByRole('button', {
      name: /plain text|formatted|expand|show more|full message|reload inline images/i,
    }),
  ).toHaveCount(0);
}

/** The frame runs exactly the fixed layout helper; email scripts and handlers cannot execute. */
async function expectOnlyLayoutHelperRuns(page: Page) {
  const frameElement = page.locator(messageFrameSelector);
  const sandbox = (await frameElement.getAttribute('sandbox'))?.split(/\s+/) ?? [];
  expect(sandbox).toContain('allow-scripts');
  expect(sandbox).not.toContain('allow-same-origin');
  expect(await frameElement.getAttribute('referrerpolicy')).toBe('no-referrer');
  const frame = messageFrame(page);
  await expect(frame.locator('script')).toHaveCount(1);
  const helperSource = await frame.locator('script').evaluate((script) => script.textContent);
  expect(helperSource).toBe(emailFrameLayoutScript);
  expect(`sha256-${createHash('sha256').update(helperSource!).digest('base64')}`).toBe(
    emailFrameLayoutScriptHash,
  );
  const policy = await frame
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  const directives = policy?.split(';').map((directive) => directive.trim()) ?? [];
  expect(directives).toEqual(
    expect.arrayContaining([
      "default-src 'none'",
      `script-src '${emailFrameLayoutScriptHash}'`,
      "script-src-attr 'none'",
    ]),
  );
  expect(directives.filter((directive) => directive.startsWith('script-src '))).toHaveLength(1);
  const handlerAttributes = await frame
    .locator('html')
    .evaluate((root) =>
      [root, ...root.querySelectorAll('*')].flatMap((element) =>
        [...element.attributes]
          .map((attribute) => attribute.name)
          .filter((name) => name.toLowerCase().startsWith('on')),
      ),
    );
  expect(handlerAttributes).toEqual([]);
  const probe = await frame.locator('body').evaluate(async (body) => {
    const blockedDirectives: string[] = [];
    const recordViolation = (event: SecurityPolicyViolationEvent) =>
      blockedDirectives.push(event.effectiveDirective);
    document.addEventListener('securitypolicyviolation', recordViolation);
    const executed: string[] = [];
    Object.assign(window, { untrustedExecuted: executed });
    const script = document.createElement('script');
    script.textContent = 'window.untrustedExecuted.push("script")';
    const button = document.createElement('button');
    button.setAttribute('onclick', 'window.untrustedExecuted.push("handler")');
    body.append(script, button);
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    script.remove();
    button.remove();
    document.removeEventListener('securitypolicyviolation', recordViolation);
    let parentReadable = true;
    try {
      void parent.document.title;
    } catch {
      parentReadable = false;
    }
    return { executed, blockedDirectives, parentReadable, origin: window.origin };
  });
  expect(probe.executed).toEqual([]);
  expect(probe.blockedDirectives).toEqual(
    expect.arrayContaining(['script-src-elem', 'script-src-attr']),
  );
  expect(probe.parentReadable).toBe(false);
  expect(probe.origin).toBe('null');
}

async function measureMessageFrame(page: Page) {
  const frameHeight = await page
    .locator(messageFrameSelector)
    .evaluate((frame) => frame.getBoundingClientRect().height);
  const content = await messageFrame(page)
    .locator('body')
    .evaluate((body) => {
      const root = document.documentElement;
      const content = [...body.children].filter((child) => child.tagName !== 'SCRIPT');
      return {
        bodyHeight: body.getBoundingClientRect().height,
        contentBottom: Math.max(0, ...content.map((child) => child.getBoundingClientRect().bottom)),
        frameViewportHeight: innerHeight,
        frameViewportWidth: innerWidth,
        rootScrollHeight: root.scrollHeight,
        rootScrollWidth: root.scrollWidth,
        overflowingBlocks: [...body.querySelectorAll('p, pre, blockquote, table, th, td, li')]
          .filter((element) => element.scrollWidth > element.clientWidth + 1)
          .map((element) => element.tagName),
      };
    });
  const pageOverflows = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  return { frameHeight, ...content, pageOverflows };
}

/** Auto-height: the page scrolls the whole message; the frame itself never scrolls or clips. */
async function expectSeamlessMessageFrame(page: Page) {
  await expect
    .poll(async () => {
      const layout = await measureMessageFrame(page);
      return (
        Math.abs(layout.frameHeight - Math.ceil(layout.bodyHeight)) <= 1 &&
        layout.contentBottom <= layout.frameViewportHeight + 1 &&
        layout.rootScrollHeight <= layout.frameViewportHeight + 1
      );
    })
    .toBe(true);
  const layout = await measureMessageFrame(page);
  expect(layout.rootScrollWidth).toBeLessThanOrEqual(layout.frameViewportWidth);
  expect(layout.overflowingBlocks).toEqual([]);
  expect(layout.pageOverflows).toBe(false);
  return layout;
}

async function waitForPaint(page: Page) {
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
}

async function replaceInlineSampleBody(page: Page, bodyHtml: string) {
  await page.route('**/v1/mailbox/threads/1003', async (route) => {
    const response = await route.fetch();
    const thread = await response.json();
    thread.emails[0].bodyHtml = bodyHtml;
    await route.fulfill({ response, json: thread });
  });
}

function longRateSheetHtml() {
  const rows = Array.from(
    { length: 40 },
    (_, index) =>
      `<tr><td>MSKU${String(index).padStart(7, '0')}</td><td>Nhava Sheva to Rotterdam via Colombo transshipment</td><td>USD ${1800 + index * 10}</td><td>BOOKINGREFERENCE${'X'.repeat(48)}${index}</td><td>18 Nov 2026</td><td>Free time 14 days at destination</td></tr>`,
  ).join('');
  return [
    '<h2>Weekly rate sheet</h2>',
    `<p>${'Rates are valid for cargo ready this week and subject to space and equipment. '.repeat(12)}</p>`,
    '<table><thead><tr><th>Container</th><th>Route</th><th>Rate</th><th>Reference</th><th>Sailing</th><th>Terms</th></tr></thead>',
    `<tbody>${rows}</tbody></table>`,
    `<pre>${'UNBROKEN-PRE-FORMATTED-LINE-'.repeat(30)}</pre>`,
    `<blockquote><table><tr><td>Quoted ${'nested-table-cell-'.repeat(20)}</td><td>Earlier offer</td></tr></table></blockquote>`,
    '<p>End of rate sheet.</p>',
  ].join('');
}

test('opens latest-first conversation with labels, recipients and files; keyboard, reload and back work', async ({
  page,
  context,
}, testInfo) => {
  const trackerRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('tracking.invalid')) trackerRequests.push(request.url());
  });
  await signIn(page);
  const conversationLink = messageLink(page, subject);
  await conversationLink.focus();
  await page.keyboard.press('Enter');
  const heading = page.getByRole('heading', { name: subject, exact: true });
  await expect(heading).toBeFocused();
  await expect(page).toHaveURL(new RegExp(`email=${selectedEmailId}$`));
  await expect(page.getByText('3 messages · Latest first · Stored mail only')).toBeVisible();
  const messages = page.locator('.threadMessage');
  await expect(messages).toHaveCount(3);
  const timestamps = await messages
    .locator('time')
    .evaluateAll((elements) => elements.map((element) => element.getAttribute('datetime')));
  expect(timestamps).toEqual([
    '2026-11-09T12:59:00.000Z',
    '2026-11-09T12:55:00.000Z',
    '2026-11-09T12:54:00.000Z',
  ]);
  await expect(messages.nth(0).getByText('Customer reply', { exact: true })).toBeVisible();
  await expect(messages.nth(0).getByText('From this conversation')).toBeVisible();
  await expect(messages.nth(0).getByText('Operations <operations@example.com>')).toBeVisible();
  await expect(messages.nth(0).locator('.messageBody')).toContainText('Thanks for the quote.');
  await messages.nth(1).locator('summary').click();
  await expect(page.getByText('Outbound mail is not classified')).toBeVisible();
  await messages.nth(2).locator('summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('Customer request', { exact: true })).toBeVisible();
  await expect(page.getByText('AI classification · 94% confidence')).toBeVisible();
  await messages.nth(0).getByRole('button', { name: 'Show files' }).click();
  await expect(page.getByText('sailing-offer.pdf', { exact: true })).toBeVisible();
  await expect(page.getByText('signature.png', { exact: true })).toHaveCount(0);
  await expect(
    page.getByText('Stored inline images appear in the message when supported.'),
  ).toBeVisible();
  // This conversation stores only plain-text bodies, so nothing is framed or decoded.
  await expect(page.locator('.threadView img, .threadView iframe, .threadView script')).toHaveCount(
    0,
  );
  expect(trackerRequests).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  // axe temporarily focuses the skip link; restore the reading position before the visual artifact.
  await heading.focus();
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: testInfo.outputPath('threadReading.png'), fullPage: true });

  let downloadedUrl: string | undefined;
  await context.route('https://fake-bucket.example/**', async (route) => {
    downloadedUrl = route.request().url();
    await route.fulfill({
      status: 200,
      contentType: 'application/pdf',
      headers: { 'Content-Disposition': 'attachment; filename="sailing-offer.pdf"' },
      body: 'Synthetic attachment only',
    });
  });
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download sailing-offer.pdf' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('sailing-offer.pdf');
  expect(await download.failure()).toBeNull();
  await download.delete();
  expect(downloadedUrl).toContain('/synthetic/sailing-offer.pdf');
  expect(context.pages()).toHaveLength(1);
  await expect(heading).toBeVisible();
  await page.reload();
  await expect(heading).toBeVisible();
  await page.getByRole('link', { name: 'Back to All mail' }).click();
  await expect(conversationLink).toBeVisible();
  await page.getByRole('button', { name: 'Older', exact: true }).click();
  const pagedUrl = page.url();
  await messageLink(page, 'Shipment update 30').click();
  await expect(
    page.getByRole('heading', { name: 'Shipment update 30', exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(pagedUrl);
  await expect(page.getByText('5 messages on this page')).toBeVisible();
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
});

test('hostile and HTML-only messages read seamlessly without reader toggles and show empty files state', async ({
  page,
}) => {
  const trackerRequests: string[] = [];
  page.context().on('request', (request) => {
    if (request.url().includes('tracking.invalid')) trackerRequests.push(request.url());
  });
  await signIn(page);
  await messageLink(page, 'Shipment update 2').click();
  const hostileFrame = messageFrame(page);
  await expect(hostileFrame.locator('body')).toContainText('Updated shipping details are ready.');
  await expect(hostileFrame.locator('img')).toHaveCount(2);
  await expect
    .poll(() =>
      hostileFrame
        .getByRole('img', { name: 'Promo' })
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expectSeamlessMessageFrame(page);
  await expectOnlyLayoutHelperRuns(page);
  await expect(page.locator('.threadView img, .threadView script')).toHaveCount(0);
  await expect(page.locator('.threadView .messageBody')).toHaveCount(0);
  await expectNoReaderModeControls(page);
  await expect(page.getByText('Rate card', { exact: true })).toBeVisible();
  await expect(page.getByText('Sender rule', { exact: true })).toBeVisible();
  await expectSeamlessMessageFrame(page);
  const showFiles = page.getByRole('button', { name: 'Show files' });
  await showFiles.scrollIntoViewIfNeeded();
  await expect(showFiles).toBeVisible();
  await showFiles.click();
  await expect(page.getByRole('button', { name: 'Hide files' })).toBeVisible();
  await expect(page.getByText('No attached files.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to All mail' }).click();
  await messageLink(page, '(No subject)').click();
  await expect(page.getByRole('heading', { name: '(No subject)', exact: true })).toBeVisible();
  await expect(page.getByText('Not classified yet')).toBeVisible();
  const htmlOnlyFrame = messageFrame(page);
  await expect(htmlOnlyFrame.locator('body')).toContainText('MSC Aurora');
  await expect(htmlOnlyFrame.locator('img')).toHaveCount(2);
  await expectNoReaderModeControls(page);
  await expect(retryImagesButton(page)).toHaveCount(0);
  await expectSeamlessMessageFrame(page);
  expect(trackerRequests).toEqual([]);
});

test('thread loading, failures, retry, cached refresh, 404 and expired-session states', async ({
  page,
}) => {
  await signIn(page);
  let releaseThread: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseThread = resolve;
  });
  await page.route('**/v1/mailbox/threads/*', async (route) => {
    await gate;
    await route.fulfill({ status: 503, json: { error: 'unavailable' } });
  });
  await messageLink(page, subject).click();
  await expect(page.getByRole('status')).toContainText('Opening conversation');
  releaseThread();
  await expect(
    page.getByRole('heading', { name: 'Conversation could not be loaded' }),
  ).toBeVisible();
  await page.unroute('**/v1/mailbox/threads/*');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: subject, exact: true })).toBeVisible();
  await page.route('**/v1/mailbox/threads/*', (route) =>
    route.fulfill({ status: 503, json: { error: 'unavailable' } }),
  );
  await page.getByRole('button', { name: 'Refresh conversation' }).click();
  await expect(page.getByRole('alert')).toContainText('Showing saved messages');
  await expect(page.locator('.messageBody')).toContainText('Thanks for the quote.');
  await page.unroute('**/v1/mailbox/threads/*');
  await page.goto('/mailbox?email=not-a-uuid');
  await expect(page.getByRole('heading', { name: 'Conversation unavailable' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to All mail' }).click();
  await openThread(page);
  await page.route(`**/v1/mailbox/emails/${selectedEmailId}`, (route) =>
    route.fulfill({ status: 401, json: { error: 'not_authenticated' } }),
  );
  await page.getByRole('button', { name: 'Refresh conversation' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.locator('.messageBody')).toHaveCount(0);
});

test('file errors retry and downloads do not continue after navigating away', async ({ page }) => {
  const downloadedFiles: string[] = [];
  page.on('download', (download) => downloadedFiles.push(download.suggestedFilename()));
  await signIn(page);
  await openThread(page);
  await page.route('**/attachments', (route) =>
    route.fulfill({ status: 503, json: { error: 'unavailable' } }),
  );
  await page.getByRole('button', { name: 'Show files' }).click();
  await expect(page.getByRole('alert')).toContainText('Files could not be loaded');
  await page.unroute('**/attachments');
  await page.getByRole('button', { name: 'Retry files' }).click();
  await page.route('**/download-url', (route) =>
    route.fulfill({ status: 503, json: { error: 'attachments_unavailable' } }),
  );
  await page.getByRole('button', { name: 'Download sailing-offer.pdf' }).click();
  await expect(page.getByRole('alert')).toContainText('Downloads are temporarily unavailable');
  await page.unroute('**/download-url');
  let finishDownload: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    finishDownload = resolve;
  });
  await page.route('**/download-url', async (route) => {
    await gate;
    await route.fulfill({
      json: { url: 'https://fake-bucket.example/aborted', expiresAt: '2026-11-10T10:05:00.000Z' },
    });
  });
  const requestStarted = page.waitForRequest('**/download-url');
  await page.getByRole('button', { name: 'Download sailing-offer.pdf' }).click();
  await requestStarted;
  await page.getByRole('link', { name: 'Back to All mail' }).click();
  finishDownload();
  await expect(page.getByRole('heading', { name: 'All mail', exact: true })).toBeVisible();
  expect(downloadedFiles).toEqual([]);
});

test('cross-tab switch between detail and thread rejects another mailbox with the same Gmail thread id', async ({
  page,
}) => {
  await signIn(page);
  const session = await (await page.request.get('/v1/me')).json();
  await page.route('**/v1/me', (route) => route.fulfill({ json: session }));
  await page.route('**/v1/mailbox/threads/abc123', async (route) => {
    // Cookies are shared across tabs. Switch precisely between the detail and thread requests.
    await page.request.post('/v1/auth/login', {
      data: { email: 'sales@example.com', password: 'frontend-test-password' },
    });
    await route.continue();
  });
  await page.evaluate(() => {
    document.documentElement.dataset.privateBodyRendered = 'false';
    new MutationObserver(() => {
      if (document.body.textContent?.includes('Sales-only private message body'))
        document.documentElement.dataset.privateBodyRendered = 'true';
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  await messageLink(page, subject).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  expect(await page.locator('html').getAttribute('data-private-body-rendered')).toBe('false');
});

test('switching accounts before opening an old row signs out rather than claiming mail is missing', async ({
  page,
}) => {
  await signIn(page);
  await page.request.post('/v1/auth/login', {
    data: { email: 'sales@example.com', password: 'frontend-test-password' },
  });
  await messageLink(page, subject).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Conversation unavailable' })).toHaveCount(0);
  await expect(page.locator('.messageBody')).toHaveCount(0);
});

test('All mail and Inbox show each classification, retain it after reload and refresh, and do not fetch details', async ({
  page,
}, testInfo) => {
  const detailRequests: string[] = [];
  page.on('request', (request) => {
    if (/\/v1\/mailbox\/(emails\/|threads\/)/.test(request.url()))
      detailRequests.push(request.url());
  });
  await signIn(page);
  const expectedLabels = [
    [subject, 'Customer reply'],
    ['(No subject)', 'Not classified yet'],
    ['Shipment update 2', 'Rate card'],
    ['Clearance charges - Mundra import (inline image sample)', 'General'],
    ['Shipment update 5', 'Customer request'],
  ];
  for (const folder of ['All mail', 'Inbox']) {
    await page.getByRole('button', { name: folder, exact: true }).click();
    for (const [messageSubject, label] of expectedLabels) {
      await expect(messageLink(page, messageSubject!).locator('.classificationBadge')).toHaveText(
        label!,
      );
    }
    if (folder === 'All mail') {
      await expect(
        messageLink(page, 'Shipment update 4').locator('.classificationBadge'),
      ).toHaveText('Not classified');
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.evaluate(() => {
      (document.activeElement as HTMLElement)?.blur();
      window.scrollTo(0, 0);
    });
    await page.screenshot({
      path: testInfo.outputPath(`${folder === 'Inbox' ? 'inbox' : 'allMail'}Classifications.png`),
    });
  }
  await page.reload();
  await expect(messageLink(page, subject).locator('.classificationBadge')).toHaveText(
    'Customer reply',
  );
  await page.route('**/v1/mailbox/emails?**', async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.emails[0].classification = {
      ...body.emails[0].classification,
      label: 'general',
      source: 'user',
    };
    await route.fulfill({ response, json: body });
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(messageLink(page, subject).locator('.classificationBadge')).toHaveText('General');
  expect(detailRequests).toEqual([]);
});

test('inline-image sample shows the stored CID logo from storage without remote requests or referrer', async ({
  page,
}) => {
  const logoBytes = await syntheticInlineLogoPng();
  const bucketReferrers: (string | null)[] = [];
  const remoteRequests = collectRemoteRequests(page);
  await page.context().route(storageUrlPattern, async (route) => {
    bucketReferrers.push(await route.request().headerValue('referer'));
    await fulfillStoredLogo(route, logoBytes);
  });
  await signIn(page);
  await messageLink(page, inlineSampleSubject).click();
  const body = messageFrame(page);
  await expect(body.locator('body')).toContainText('INR 8,500 per BL plus actuals.');
  const logo = body.getByRole('img', { name: 'Swift CHA' });
  await expect(logo).toHaveAttribute(
    'src',
    /^https:\/\/127\.0\.0\.1:4184\/synthetic\/inlineImage\/logo\.png/,
  );
  await expect(logo).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect
    .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expectOnlyLayoutHelperRuns(page);
  await expectSeamlessMessageFrame(page);
  await expect(page.getByText('Loading images…')).toHaveCount(0);
  await expect(retryImagesButton(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expectNoReaderModeControls(page);
  await expect(page.locator('.threadView img')).toHaveCount(0);
  expect(bucketReferrers.length).toBeGreaterThan(0);
  expect(bucketReferrers).toEqual(bucketReferrers.map(() => null));
  expect(remoteRequests.filter((url) => !url.startsWith('https://127.0.0.1:4184/'))).toEqual([]);
  await page.getByRole('button', { name: 'Show files' }).click();
  await expect(
    page.getByText('Stored inline images appear in the message when supported.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download logo.png' })).toHaveCount(0);
});

test('long table-heavy HTML auto-sizes across width changes without clipping, overflow or forged resizes', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await replaceInlineSampleBody(page, longRateSheetHtml());
  await messageLink(page, inlineSampleSubject).click();
  const frame = messageFrame(page);
  await expect(frame.locator('body')).toContainText('End of rate sheet.');
  await expectOnlyLayoutHelperRuns(page);
  await expectNoReaderModeControls(page);
  await expect(retryImagesButton(page)).toHaveCount(0);
  const wide = await expectSeamlessMessageFrame(page);
  expect(wide.frameHeight).toBeGreaterThan(page.viewportSize()!.height);

  const original = page.viewportSize()!;
  await page.setViewportSize({
    width: Math.max(320, Math.round(original.width / 2)),
    height: original.height,
  });
  await expect
    .poll(async () => (await measureMessageFrame(page)).frameHeight)
    .toBeGreaterThan(wide.frameHeight);
  await expectSeamlessMessageFrame(page);
  await page.setViewportSize(original);
  await expect
    .poll(async () => Math.abs((await measureMessageFrame(page)).frameHeight - wide.frameHeight))
    .toBeLessThanOrEqual(1);
  const restored = await expectSeamlessMessageFrame(page);

  // The parent only trusts layout messages whose source is this frame's window and origin is opaque.
  await page.evaluate(async () => {
    const forgedLayout = {
      type: 'emailFrameLayout',
      height: 7,
      failedImageCount: 3,
      forged: true,
    };
    let forgedDelivered = 0;
    const delivered = new Promise<void>((resolve) =>
      addEventListener('message', (event: MessageEvent) => {
        if (event.data?.forged && ++forgedDelivered === 2) resolve();
      }),
    );
    postMessage(forgedLayout, '*');
    const forger = document.createElement('iframe');
    forger.sandbox.add('allow-scripts');
    forger.srcdoc = `<script>parent.postMessage(${JSON.stringify(forgedLayout)}, '*')</script>`;
    document.body.append(forger);
    await delivered;
    forger.remove();
  });
  await waitForPaint(page);
  expect((await measureMessageFrame(page)).frameHeight).toBe(restored.frameHeight);
  await expect(retryImagesButton(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await waitForPaint(page);
  await page.screenshot({ path: testInfo.outputPath('longHtmlMessage.png'), fullPage: true });
});

test('hostile HTML allows images but blocks active content; safe links open without opener or referrer', async ({
  page,
}) => {
  const remoteRequests = collectRemoteRequests(page);
  const carrierReferrers: (string | null)[] = [];
  const dialogs: string[] = [];
  page.on('dialog', async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await page.context().route('https://carrier.example/**', async (route) => {
    carrierReferrers.push(await route.request().headerValue('referer'));
    await route.fulfill({ contentType: 'text/html', body: '<title>Synthetic carrier</title>' });
  });
  await signIn(page);
  await messageLink(page, 'Shipment update 2').click();
  const hostile = messageFrame(page);
  await expect(hostile.locator('body')).toContainText('Styled block');
  await expect(
    hostile
      .locator('body')
      .locator('link, iframe, object, svg, form, input, base, meta[http-equiv="refresh"], [ping]'),
  ).toHaveCount(0);
  await expectOnlyLayoutHelperRuns(page);
  await expect(hostile.locator('img')).toHaveCount(2);
  await expect
    .poll(() =>
      hostile
        .locator('img')
        .first()
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(hostile.getByText('[Promo not loaded]')).toHaveCount(0);
  await expect
    .poll(() =>
      hostile
        .getByRole('img', { name: 'Promo' })
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(retryImagesButton(page)).toHaveCount(0);
  await expect(page.getByText('Some images are blocked or unavailable.')).toHaveCount(0);

  await page.getByRole('link', { name: 'Back to All mail' }).click();
  await messageLink(page, '(No subject)').click();
  const htmlOnly = messageFrame(page);
  const trackLink = htmlOnly.getByRole('link', { name: 'Track booking BK-1001' });
  await expect(trackLink).toHaveAttribute('target', '_blank');
  await expect(trackLink).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(trackLink).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expect(htmlOnly.getByText('Unsafe link')).not.toHaveAttribute('href', /.*/);
  const popupPromise = page.waitForEvent('popup');
  await trackLink.click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(popup.url()).toBe('https://carrier.example/track?booking=BK-1001');
  expect(await popup.evaluate(() => window.opener)).toBeNull();
  await popup.close();
  expect(carrierReferrers).toEqual([null]);
  expect(remoteRequests.filter((url) => !url.startsWith('https://carrier.example/'))).toEqual([]);
  expect(dialogs).toEqual([]);
});

test('failed inline image signing keeps a placeholder until Retry images signs fresh links', async ({
  page,
}) => {
  const logoBytes = await syntheticInlineLogoPng();
  const bucketRequests: string[] = [];
  await page.context().route(storageUrlPattern, async (route) => {
    bucketRequests.push(route.request().url());
    await fulfillStoredLogo(route, logoBytes);
  });
  await signIn(page);
  await page.route('**/download-url', (route) =>
    route.fulfill({ status: 503, json: { error: 'attachments_unavailable' } }),
  );
  await messageLink(page, inlineSampleSubject).click();
  const body = messageFrame(page);
  await expect(page.getByRole('alert')).toContainText('Some images could not be loaded.');
  await expect(page.getByRole('alert')).toContainText('Downloads are temporarily unavailable');
  await expect(body.getByText('[Swift CHA not loaded]')).toBeVisible();
  await expect(body.locator('img')).toHaveCount(0);
  await expect(retryImagesButton(page)).toBeVisible();
  expect(bucketRequests).toEqual([]);

  await page.unroute('**/download-url');
  await retryImagesButton(page).click();
  const logo = body.getByRole('img', { name: 'Swift CHA' });
  await expect
    .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(retryImagesButton(page)).toHaveCount(0);
  expect(bucketRequests.length).toBeGreaterThan(0);
});

test('a delayed storage 403 shows Loading images…, then Retry images until a later fetch decodes the logo', async ({
  page,
}) => {
  const logoBytes = await syntheticInlineLogoPng();
  let storageDenies = true;
  let releaseStorage: () => void = () => {};
  const storageGate = new Promise<void>((resolve) => {
    releaseStorage = resolve;
  });
  await page.context().route(storageUrlPattern, async (route) => {
    await storageGate;
    await (storageDenies ? fulfillStorageDenied(route) : fulfillStoredLogo(route, logoBytes));
  });
  await signIn(page);
  const storageRequested = page.waitForRequest(storageUrlPattern);
  await messageLink(page, inlineSampleSubject).click();
  await storageRequested;
  const imageStatus = page.locator('.htmlEmailBody').getByRole('status');
  await expect(imageStatus).toHaveText('Loading images…');
  await expect(retryImagesButton(page)).toHaveCount(0);
  const body = messageFrame(page);
  await expect(body.locator('body')).toContainText('INR 8,500 per BL plus actuals.');

  releaseStorage();
  await expect(page.getByRole('alert')).toContainText('Some images could not be loaded.');
  await expect(imageStatus).toHaveCount(0);
  await expect(body.getByText('[Swift CHA not loaded]')).toBeVisible();
  await expect(body.locator('img')).toHaveCount(0);
  await expectSeamlessMessageFrame(page);

  storageDenies = false;
  await retryImagesButton(page).click();
  const logo = body.getByRole('img', { name: 'Swift CHA' });
  await expect
    .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(retryImagesButton(page)).toHaveCount(0);
  await expectSeamlessMessageFrame(page);
});

test('missing, ambiguous and non-image CIDs stay placeholders and are never signed', async ({
  page,
}) => {
  const signingRequests = collectSigningRequests(page);
  const remoteRequests = collectRemoteRequests(page);
  await signIn(page);
  await page.route('**/v1/mailbox/threads/1003', async (route) => {
    const response = await route.fetch();
    const thread = await response.json();
    thread.emails[0].bodyHtml = [
      '<p>Charges attached below.</p>',
      '<img src="cid:missing@swiftcha" alt="Missing logo">',
      '<img src="cid:duplicate@swiftcha" alt="Duplicate logo">',
      '<img src="cid:ratesheet@swiftcha" alt="Rate sheet">',
    ].join('');
    await route.fulfill({ response, json: thread });
  });
  const inlinePart = {
    fileName: 'part.png',
    contentType: 'image/png',
    sizeBytes: 68,
    isInline: true,
  };
  await page.route(`**/v1/mailbox/emails/${inlineSampleEmailId}/attachments`, (route) =>
    route.fulfill({
      json: {
        emailId: inlineSampleEmailId,
        attachments: [
          {
            ...inlinePart,
            id: '00000000-0000-4000-8000-000000000401',
            contentId: 'duplicate@swiftcha',
          },
          {
            ...inlinePart,
            id: '00000000-0000-4000-8000-000000000402',
            contentId: '<duplicate@swiftcha>',
          },
          {
            ...inlinePart,
            id: '00000000-0000-4000-8000-000000000403',
            fileName: 'rates.pdf',
            contentType: 'application/pdf',
            contentId: 'ratesheet@swiftcha',
          },
        ],
      },
    }),
  );
  const attachmentsListed = page.waitForResponse(
    `**/v1/mailbox/emails/${inlineSampleEmailId}/attachments`,
  );
  await messageLink(page, inlineSampleSubject).click();
  await attachmentsListed;
  const body = messageFrame(page);
  await expect(body.locator('body')).toContainText('Charges attached below.');
  for (const alt of ['Missing logo', 'Duplicate logo', 'Rate sheet'])
    await expect(body.getByText(`[${alt} not loaded]`)).toBeVisible();
  await expect(body.locator('img')).toHaveCount(0);
  await expect(page.getByText('Loading images…')).toHaveCount(0);
  await expect(retryImagesButton(page)).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(signingRequests).toEqual([]);
  expect(remoteRequests).toEqual([]);
});

test('inline image loading stops when the message collapses and restarts fresh when it reopens', async ({
  page,
}) => {
  const logoBytes = await syntheticInlineLogoPng();
  const bucketRequests: string[] = [];
  await page.context().route(storageUrlPattern, async (route) => {
    bucketRequests.push(route.request().url());
    await fulfillStoredLogo(route, logoBytes);
  });
  await signIn(page);
  let releaseSigning: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseSigning = resolve;
  });
  let signingSettled: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    signingSettled = resolve;
  });
  await page.route('**/download-url', async (route) => {
    await gate;
    // The browser has usually aborted this request by now; that is the behaviour under test.
    await route.continue().catch(() => {});
    signingSettled();
  });
  const signingStarted = page.waitForRequest('**/download-url');
  await messageLink(page, inlineSampleSubject).click();
  await signingStarted;
  await expect(page.locator('.htmlEmailBody').getByRole('status')).toHaveText('Loading images…');
  await page.locator('.threadMessage summary').click();
  await expect(page.locator(messageFrameSelector)).toHaveCount(0);
  releaseSigning();
  await settled;
  expect(bucketRequests).toEqual([]);

  await page.unroute('**/download-url');
  await page.locator('.threadMessage summary').click();
  const logo = messageFrame(page).getByRole('img', { name: 'Swift CHA' });
  await expect
    .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
});

test('a session switch while listing inline images signs out without signing or loading images', async ({
  page,
}) => {
  const signingRequests = collectSigningRequests(page);
  const bucketRequests: string[] = [];
  await page.context().route(storageUrlPattern, async (route) => {
    bucketRequests.push(route.request().url());
    await route.abort();
  });
  await signIn(page);
  await page.route(`**/v1/mailbox/emails/${inlineSampleEmailId}/attachments`, async (route) => {
    // Cookies are shared across tabs. Switch accounts exactly between the body and its image list.
    await page.request.post('/v1/auth/login', {
      data: { email: 'sales@example.com', password: 'frontend-test-password' },
    });
    await route.continue();
  });
  await messageLink(page, inlineSampleSubject).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.locator(messageFrameSelector)).toHaveCount(0);
  expect(signingRequests).toEqual([]);
  expect(bucketRequests).toEqual([]);
});

test('react-letter preserves sender CSS and loads remote logos, tracking pixels and backgrounds', async ({
  page,
}, testInfo) => {
  await signIn(page);
  await messageLink(page, '(No subject)').click();
  const frame = messageFrame(page);
  await expect(frame.getByRole('heading', { name: 'Booking confirmed' })).toHaveCSS(
    'color',
    'rgb(23, 96, 135)',
  );
  await expect(frame.getByRole('heading', { name: 'Booking confirmed' })).toHaveCSS(
    'padding',
    testInfo.project.name === 'mobile' ? '10px' : '18px',
  );
  const logo = frame.getByRole('img', { name: 'Remote booking logo' });
  await expect
    .poll(() => logo.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  const tracker = frame.locator('img[width="1"]');
  await expect
    .poll(() => tracker.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  await expect(tracker).toHaveAttribute('referrerpolicy', 'no-referrer');
  await expectOnlyLayoutHelperRuns(page);
  await expectSeamlessMessageFrame(page);
  await expect(retryImagesButton(page)).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('reactLetterRemoteImages.png'),
    fullPage: true,
  });
  await page.reload();
  await expect
    .poll(() =>
      messageFrame(page)
        .locator('img[width="1"]')
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await page.getByRole('link', { name: 'Back to All mail' }).click();
  await messageLink(page, 'Shipment update 2').click();
  await expect(messageFrame(page).getByText('Styled block')).toHaveCSS(
    'background-image',
    /inlineBackground/,
  );
});

test('viewport CSS cannot grow the frame indefinitely and encoded CSS image URLs stay exact', async ({
  page,
}) => {
  const imageUrl =
    'https://127.0.0.1:4184/synthetic/inlineImage/logo.png?signature=a%2Fb%20c&name=logo(1)';
  await replaceInlineSampleBody(
    page,
    `<style>@media (min-width: 1px) { @media (min-width: 1px) { .viewportBlock { height: 100dvh; position: fixed; color: rgb(23, 96, 135); } } }</style><p>Before</p><div class="viewportBlock" style="height:100vh;background-image:url('${imageUrl}')">Background</div><img src="${imageUrl}" alt="Encoded logo"><p>After</p>`,
  );
  await signIn(page);
  await messageLink(page, inlineSampleSubject).click();
  const frame = messageFrame(page);
  await expect(frame.getByRole('img', { name: 'Encoded logo' })).toHaveJSProperty(
    'naturalWidth',
    1,
  );
  await expect(frame.getByText('Background')).toHaveCSS('background-image', `url("${imageUrl}")`);
  await expect(frame.getByText('Background')).toHaveCSS('position', 'static');
  await expectSeamlessMessageFrame(page);
  const firstHeight = (await measureMessageFrame(page)).frameHeight;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let remaining = 20;
        const nextFrame = () => {
          remaining -= 1;
          if (remaining) requestAnimationFrame(nextFrame);
          else resolve();
        };
        requestAnimationFrame(nextFrame);
      }),
  );
  const finalHeight = (await measureMessageFrame(page)).frameHeight;
  expect(finalHeight).toBe(firstHeight);
  expect(finalHeight).toBeLessThan(300);
  const output = await frame.locator('body').innerHTML();
  expect(output).not.toMatch(/100(?:d)?vh|position: fixed|%252F|%2520|\.viewportBlock/);
});

test('height-dependent stylesheet media cannot make the email frame oscillate', async ({
  page,
}) => {
  await replaceInlineSampleBody(
    page,
    '<style>@media (max-height: 400px) { .block { height: 800px; } } @media (orientation: portrait) { .block { height: 900px; } } @media (min-aspect-ratio: 1/1) { .block { height: 1000px; } } @media (min-width: 1px) { .block { color: rgb(23, 96, 135); } }</style><div class="block">Stable message</div>',
  );
  await signIn(page);
  await messageLink(page, inlineSampleSubject).click();
  const frame = messageFrame(page);
  await expect(frame.getByText('Stable message')).toHaveCSS('color', 'rgb(23, 96, 135)');
  const styles = await frame.locator('style').allTextContents();
  expect(styles.join('\n')).toContain('min-width');
  expect(styles.join('\n')).not.toMatch(/max-height|orientation|aspect-ratio/);
  await expectSeamlessMessageFrame(page);
  const heights = await page.locator(messageFrameSelector).evaluate(
    (element) =>
      new Promise<number[]>((resolve) => {
        const measurements: number[] = [];
        const measureNextFrame = () => {
          measurements.push(element.getBoundingClientRect().height);
          if (measurements.length < 30) requestAnimationFrame(measureNextFrame);
          else resolve(measurements);
        };
        requestAnimationFrame(measureNextFrame);
      }),
  );
  expect(new Set(heights).size).toBe(1);
  expect(heights[0]).toBeLessThan(300);
});

test('srcset-only images select density and width candidates; picture switches source on resize', async ({
  page,
}) => {
  const imageUrl = 'https://127.0.0.1:4184/synthetic/inlineImage/logo.png?kind=responsive';
  await replaceInlineSampleBody(
    page,
    `<p>Responsive message</p><img alt="Density" srcset="${imageUrl}Density1 1x, ${imageUrl}Density2 2x" width="160"><img alt="Width" srcset="${imageUrl}WidthSmall 160w, ${imageUrl}WidthLarge 640w" sizes="100px"><picture><source media="(max-width: 600px)" type="image/png" srcset="${imageUrl}Narrow 1x"><img alt="Picture" srcset="${imageUrl}Wide 1x" width="160"></picture><picture><source srcset="${imageUrl}SourceOnly 1x"><img alt="Source only" width="160"></picture>`,
  );
  await signIn(page);
  await messageLink(page, inlineSampleSubject).click();
  const frame = messageFrame(page);
  const ratio = await frame.locator('body').evaluate(() => devicePixelRatio);
  await expect(frame.getByRole('img', { name: 'Density', exact: true })).toHaveJSProperty(
    'currentSrc',
    `${imageUrl}Density${ratio > 1 ? 2 : 1}`,
  );
  await expect(frame.getByRole('img', { name: 'Width', exact: true })).toHaveJSProperty(
    'currentSrc',
    `${imageUrl}Width${ratio > 1.6 ? 'Large' : 'Small'}`,
  );
  for (const name of ['Density', 'Width', 'Picture', 'Source only']) {
    await expect
      .poll(() =>
        frame
          .getByRole('img', { name, exact: true })
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect(frame.getByRole('img', { name, exact: true })).toHaveAttribute(
      'referrerpolicy',
      'no-referrer',
    );
  }
  await page.setViewportSize({ width: 480, height: 900 });
  await expect(frame.getByRole('img', { name: 'Picture', exact: true })).toHaveJSProperty(
    'currentSrc',
    `${imageUrl}Narrow`,
  );
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(frame.getByRole('img', { name: 'Picture', exact: true })).toHaveJSProperty(
    'currentSrc',
    `${imageUrl}Wide`,
  );
  await expectOnlyLayoutHelperRuns(page);
  await expectSeamlessMessageFrame(page);
  await expect(retryImagesButton(page)).toHaveCount(0);
  await page.reload();
  await expect
    .poll(() =>
      messageFrame(page)
        .getByRole('img', { name: 'Density', exact: true })
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
});

test('srcset resolves scoped CID attachments and discards unsafe candidates', async ({ page }) => {
  const signingRequests = collectSigningRequests(page);
  const remoteRequests = collectRemoteRequests(page);
  await replaceInlineSampleBody(
    page,
    '<picture><source srcset="javascript:alert(1) 1x, data:image/png;base64,abc 2x"><img alt="CID candidates" srcset="cid:logo@swiftcha 1x, cid:missing 2x, /v1/me 3x, https://user:pass@evil.invalid/image 4x, blob:https://evil.invalid/x 5x" onerror="alert(1)"></picture>',
  );
  await signIn(page);
  await messageLink(page, inlineSampleSubject).click();
  const frame = messageFrame(page);
  const image = frame.getByRole('img', { name: 'CID candidates' });
  await expect
    .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
    .toBeGreaterThan(0);
  await expect(image).toHaveAttribute(
    'srcset',
    /^https:\/\/127\.0\.0\.1:4184\/synthetic\/inlineImage\/logo\.png\?fileName=logo\.png 1x$/,
  );
  await expect(frame.locator('source')).toHaveCount(0);
  expect(signingRequests).toHaveLength(1);
  expect(remoteRequests).toEqual([]);
  await expectOnlyLayoutHelperRuns(page);
  await expect(retryImagesButton(page)).toHaveCount(0);
});
