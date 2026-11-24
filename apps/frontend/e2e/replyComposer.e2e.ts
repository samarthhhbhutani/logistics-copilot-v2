import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// "Shipment update 11" and "Shipment update 12" are claimed by this spec alone; the synthetic server
// keeps every send for the whole run, and each send here mints its own id, so nothing a later test
// reads changes.
const rfqSubject = 'RFQ: Mumbai to Rotterdam · 2 × 40ft';
const subject = 'Shipment update 11';
const attachmentsSubject = 'Shipment update 12';

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

test('attaches files as they are picked, carries them again after Gmail refuses, and lists them on the sent reply', async ({
  page,
}) => {
  await signIn(page);
  await messageLink(page, attachmentsSubject).click();
  await expect(page.getByRole('heading', { name: attachmentsSubject, exact: true })).toBeVisible();
  const composer = page.getByRole('region', { name: 'Reply', exact: true });
  const attachedFiles = composer.getByRole('list', { name: 'Attached files' });
  const fileInput = composer.locator('input[type="file"]');

  // Each pick is uploaded at once, in order; the chips show the stored files.
  const uploads: string[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/reply-attachments')) {
      uploads.push(new URL(request.url()).searchParams.get('fileName') ?? '');
    }
  });
  await fileInput.setInputFiles([
    { name: 'rates.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 rates') },
    { name: 'terms.txt', mimeType: 'text/plain', buffer: Buffer.from('Payment within 30 days.') },
  ]);
  await expect(attachedFiles.getByRole('listitem')).toHaveText([
    /rates\.pdf\s*14 bytes/,
    /terms\.txt\s*23 bytes/,
  ]);
  expect(uploads).toEqual(['rates.pdf', 'terms.txt']);

  // A file Gmail would refuse is turned down on the page, before any upload, and the rest stay.
  await fileInput.setInputFiles([
    { name: 'setup.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') },
  ]);
  await expect(composer.getByRole('alert')).toHaveText(
    'setup.exe: Gmail does not deliver files of this type. Zip it with a different name or share it another way.',
  );
  expect(uploads).toEqual(['rates.pdf', 'terms.txt']);

  // Removing a chip deletes the upload.
  const deleted = page.waitForResponse(
    (response) =>
      response.request().method() === 'DELETE' && response.url().includes('/reply-attachments/'),
  );
  await attachedFiles.getByRole('button', { name: 'Remove terms.txt', exact: true }).click();
  expect((await deleted).status()).toBe(204);
  await expect(attachedFiles.getByRole('listitem')).toHaveText([/rates\.pdf/]);

  // Gmail refuses the first send: the API answers 502 with the failed row, and the files it named
  // stay unsent on the page, so the retry under a new id carries the same ids.
  const sendBodies: { sentMailId: string; attachmentIds?: string[] }[] = [];
  await page.route('**/v1/mailbox/emails/*/replies', async (route, request) => {
    const body = request.postDataJSON() as { sentMailId: string; attachmentIds?: string[] };
    sendBodies.push(body);
    if (sendBodies.length > 1) {
      await route.fallback();
      return;
    }
    const now = new Date().toISOString();
    await route.fulfill({
      status: 502,
      json: {
        error: 'send_failed',
        sentMail: {
          id: body.sentMailId,
          kind: 'reply',
          status: 'failed',
          inReplyToEmailId: new URL(request.url()).pathname.split('/').at(-2),
          rfqId: null,
          vendorId: null,
          vendorContactId: null,
          gmailThreadId: 'thread-e2e',
          rfcMessageId: '<e2e@example.com>',
          toRecipients: [{ name: 'Coastal Shipping', address: 'ravi@example.com' }],
          ccRecipients: [],
          subject: `Re: ${attachmentsSubject}`,
          bodyText: 'Attached as discussed.',
          gmailMessageId: null,
          errorCode: 'bad_request',
          attachments: [],
          createdAt: now,
          updatedAt: now,
        },
      },
    });
  });
  await composer.getByLabel('Message', { exact: true }).fill('Attached as discussed.');
  await composer.getByRole('button', { name: 'Send reply', exact: true }).click();
  await expect(composer.getByRole('alert')).toHaveText(
    'Reply not sent. Gmail rejected the message. Check the address and the text.',
  );
  await expect(attachedFiles.getByRole('listitem')).toHaveText([/rates\.pdf/]);

  await composer.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(composer.getByRole('status')).toHaveText(
    'Reply sent to ravi@example.com with 1 file.',
  );
  expect(sendBodies).toHaveLength(2);
  expect(sendBodies[0]!.attachmentIds).toHaveLength(1);
  expect(sendBodies[1]!.attachmentIds).toEqual(sendBodies[0]!.attachmentIds);
  expect(sendBodies[1]!.sentMailId).not.toBe(sendBodies[0]!.sentMailId);
  await expect(composer.getByRole('button', { name: 'Attach files', exact: true })).toBeDisabled();
  await expect(
    attachedFiles.getByRole('button', { name: 'Remove rates.pdf', exact: true }),
  ).toBeDisabled();
  await page.unroute('**/v1/mailbox/emails/*/replies');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await composer.getByRole('button', { name: 'Write another reply', exact: true }).click();
  await expect(attachedFiles).toHaveCount(0);
  await expect(composer.getByRole('button', { name: 'Attach files', exact: true })).toBeEnabled();
});
