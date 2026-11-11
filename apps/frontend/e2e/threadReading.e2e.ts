import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

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
async function openThread(page: Page) {
  await messageLink(page, subject).click();
  await expect(page.getByRole('heading', { name: subject, exact: true })).toBeVisible();
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
  await expect(page.getByText('Inline images and signatures are hidden.')).toBeVisible();
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

test('renders hostile body as text, provides HTML-only fallback and empty files state', async ({
  page,
}) => {
  await signIn(page);
  await messageLink(page, 'Shipment update 2').click();
  await expect(page.locator('.messageBody')).toContainText('<script>alert(1)</script>');
  await expect(page.locator('.threadView img, .threadView script')).toHaveCount(0);
  await expect(page.getByText('Rate card', { exact: true })).toBeVisible();
  await expect(page.getByText('Sender rule', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Show files' }).click();
  await expect(page.getByText('No attached files.')).toBeVisible();
  await page.getByRole('link', { name: 'Back to All mail' }).click();
  await messageLink(page, '(No subject)').click();
  await expect(page.getByRole('heading', { name: '(No subject)', exact: true })).toBeVisible();
  await expect(page.getByText('Not classified yet')).toBeVisible();
  await expect(page.getByText('No plain-text body is available.', { exact: false })).toBeVisible();
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

test('inline-image sample retains the CID attachment but never loads it in plain-text reading', async ({
  page,
}) => {
  await signIn(page);
  await messageLink(page, 'Clearance charges - Mundra import (inline image sample)').click();
  await expect(page.locator('.messageBody')).toContainText('INR 8,500 per BL plus actuals.');
  const detail = await (
    await page.request.get('/v1/mailbox/emails/00000000-0000-4000-8000-000000000003')
  ).json();
  expect(detail.bodyHtml).toContain('src="cid:logo@swiftcha"');
  const attachments = await (
    await page.request.get('/v1/mailbox/emails/00000000-0000-4000-8000-000000000003/attachments')
  ).json();
  expect(attachments.attachments).toEqual([
    expect.objectContaining({ fileName: 'logo.png', contentType: 'image/png', isInline: true }),
  ]);
  expect(attachments.attachments[0].sizeBytes).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Show files' }).click();
  await expect(page.getByText('Inline images and signatures are hidden.')).toBeVisible();
  await expect(page.locator('.threadView img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download logo.png' })).toHaveCount(0);
});
