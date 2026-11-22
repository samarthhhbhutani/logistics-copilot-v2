import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// "Shipment update 13" is claimed by this spec alone (see replyComposer.e2e.ts for the rule).
const rfqSubject = 'RFQ: Mumbai to Rotterdam · 2 × 40ft';
const subject = 'Shipment update 13';

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

test('asks the copilot for a reply, waits for it, and puts the proposal into the message', async ({
  page,
}) => {
  await signIn(page);
  await messageLink(page, subject).click();
  await expect(page.getByRole('heading', { name: subject, exact: true })).toBeVisible();

  const composer = page.getByRole('region', { name: 'Reply', exact: true });
  const instruction = composer.getByLabel('Ask the copilot', { exact: true });
  await instruction.fill('keep it short');
  const startRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/mailbox/agent/runs'),
  );
  await composer.getByRole('button', { name: 'Ask the copilot', exact: true }).click();
  expect((await startRequest).postDataJSON()).toEqual({
    gmailThreadId: (0x1000 + 13).toString(16),
    instruction: 'keep it short',
  });
  await expect(composer.getByRole('button', { name: /^Working… \d+s$/ })).toBeVisible();
  await expect(instruction).toBeDisabled();

  const proposal = composer.getByRole('region', { name: 'Proposed reply', exact: true });
  await expect(proposal).toBeVisible({ timeout: 10_000 });
  await expect(proposal.locator('pre')).toContainText('Thank you for the update on 100d.');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);

  // Citations: the answered mail (in this conversation, opens it) and one not stored here (plain).
  const chips = proposal.locator('.citedChip');
  await expect(chips).toHaveCount(2);
  await expect(chips.nth(0)).toHaveText(/^Coastal Shipping · .+ · Shipment update 13$/);
  await expect(chips.nth(1)).toHaveText('A mail not stored here');
  await chips.nth(0).click();
  const citedMessage = page.locator('details.threadMessage').first();
  await expect(citedMessage).toHaveJSProperty('open', true);
  await expect(citedMessage.locator('summary')).toBeFocused();

  await proposal.getByRole('button', { name: 'Use this reply', exact: true }).click();
  const message = composer.getByLabel('Message', { exact: true });
  await expect(message).toHaveValue(
    /^Dear Coastal Shipping,\n\nThank you for the update on 100d\./,
  );
  await expect(message).toBeFocused();
  await expect(proposal.getByRole('status')).toHaveText(
    'In the message below; edit it before sending.',
  );
  await expect(composer.getByRole('button', { name: 'Ask again', exact: true })).toBeVisible();
});
