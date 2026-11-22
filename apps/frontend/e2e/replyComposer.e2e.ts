import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// "Shipment update 11" is claimed by this spec alone; the synthetic server keeps every send for the
// whole run, and each send here mints its own id, so nothing a later test reads changes.
const rfqSubject = 'RFQ: Mumbai to Rotterdam · 2 × 40ft';
const subject = 'Shipment update 11';

function messageLink(page: Page, subject: string) {
  return page.getByRole('link').filter({ has: page.getByText(subject, { exact: true }) });
}

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel('Work email').fill('ops@example.com');
  await page.getByLabel('Password', { exact: true }).fill('frontend-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(messageLink(page, rfqSubject)).toBeVisible();
}

test('replies to the newest inbound mail of a conversation from under the messages', async ({
  page,
}) => {
  await signIn(page);
  await messageLink(page, subject).click();
  await expect(page.getByRole('heading', { name: subject, exact: true })).toBeVisible();

  const composer = page.getByRole('region', { name: 'Reply', exact: true });
  await expect(composer.getByText('To Coastal Shipping <ravi@example.com>')).toBeVisible();
  const sendButton = composer.getByRole('button', { name: 'Send reply', exact: true });

  // Empty text is refused on the page, before any request.
  await sendButton.click();
  await expect(composer.getByRole('alert')).toHaveText('Write the reply before sending.');

  const message = composer.getByLabel('Message', { exact: true });
  await message.fill('Dear team,\n\nNoted, thank you.');
  // A Cc entry that is not an address is refused on the page too.
  const ccField = composer.getByLabel('Cc', { exact: true });
  await ccField.fill('priya@example.com, vikram.example.com');
  await sendButton.click();
  await expect(composer.getByRole('alert')).toHaveText(
    '"vikram.example.com" is not an email address.',
  );
  await ccField.fill('priya@example.com, Vikram Joshi <vikram@example.com>');
  const sendRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().includes('/replies'),
  );
  const sendResponse = page.waitForResponse(
    (response) => response.request().method() === 'POST' && response.url().includes('/replies'),
  );
  await sendButton.click();
  const body = (await sendRequest).postDataJSON() as {
    sentMailId: string;
    text: string;
    cc: { name: string; address: string }[];
  };
  expect(body.text).toBe('Dear team,\n\nNoted, thank you.');
  expect(body.sentMailId).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.cc).toEqual([
    { name: '', address: 'priya@example.com' },
    { name: 'Vikram Joshi', address: 'vikram@example.com' },
  ]);
  const sentMail = (await (await sendResponse).json()) as { rfcMessageId: string };

  // Ingestion files our sent copy a few seconds after the send. Stand in for it here, on the
  // second read after the send, so the page is seen to keep polling until the copy is there; the
  // synthetic mailbox itself stays as seeded for every other spec.
  let threadReadsAfterSend = 0;
  await page.route('**/v1/mailbox/threads/*', async (route) => {
    const response = await route.fetch();
    const thread = (await response.json()) as { gmailThreadId: string; emails: object[] };
    threadReadsAfterSend += 1;
    if (threadReadsAfterSend >= 2) {
      thread.emails.push({
        id: '00000000-0000-4000-8000-00000000e2e1',
        gmailThreadId: thread.gmailThreadId,
        gmailLabel: 'sent',
        sender: { name: '', email: 'ops@example.com' },
        toRecipients: [{ name: 'Coastal Shipping', address: 'ravi@example.com' }],
        ccRecipients: [
          { name: '', address: 'priya@example.com' },
          { name: 'Vikram Joshi', address: 'vikram@example.com' },
        ],
        subject: `Re: ${subject}`,
        snippet: 'Noted, thank you.',
        receivedAt: new Date().toISOString(),
        classification: null,
        rfcMessageId: sentMail.rfcMessageId,
        bodyText: 'Dear team,\n\nNoted, thank you.',
        bodyHtml: null,
      });
    }
    await route.fulfill({ response, json: thread });
  });

  await expect(composer.getByRole('status')).toHaveText(
    'Reply sent to ravi@example.com, cc priya@example.com, vikram@example.com.',
  );
  await expect(ccField).toBeDisabled();
  await expect(message).toBeDisabled();
  await expect(sendButton).toHaveCount(0);

  // Picked up on the page's own re-read, newest first, without a reload.
  await expect(page.getByText('2 messages · Latest first · Stored mail only')).toBeVisible({
    timeout: 10_000,
  });
  expect(threadReadsAfterSend).toBe(2);
  const newestSummary = page.locator('.threadMessages > li').first().locator('summary');
  await expect(newestSummary.getByText('Sent', { exact: true })).toBeVisible();
  await expect(newestSummary.locator('strong')).toHaveText('ops@example.com');
  await page.unroute('**/v1/mailbox/threads/*');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await composer.getByRole('button', { name: 'Write another reply', exact: true }).click();
  await expect(message).toBeEnabled();
  await expect(message).toHaveValue('');
});
