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
  const sendRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().includes('/replies'),
  );
  await sendButton.click();
  const body = (await sendRequest).postDataJSON() as { sentMailId: string; text: string };
  expect(body.text).toBe('Dear team,\n\nNoted, thank you.');
  expect(body.sentMailId).toMatch(/^[0-9a-f-]{36}$/);

  await expect(composer.getByRole('status')).toHaveText('Reply sent to ravi@example.com.');
  await expect(message).toBeDisabled();
  await expect(sendButton).toHaveCount(0);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  await composer.getByRole('button', { name: 'Write another reply', exact: true }).click();
  await expect(message).toBeEnabled();
  await expect(message).toHaveValue('');
});
