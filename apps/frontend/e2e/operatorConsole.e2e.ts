import { expect, test } from '@playwright/test';

test.describe('operator console', () => {
  test('operator signs in, creates a tenant, then a mailbox whose owner can log in', async ({
    page,
  }) => {
    await page.goto('/operator');
    await page.getByLabel('Operator email').fill('operator@example.com');
    await page.getByLabel('Password', { exact: true }).fill('operator-test-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByText('Signed in as operator@example.com')).toBeVisible();

    await page.getByLabel('Desk name').fill('Playwright Desk');
    await page
      .getByLabel('Google OAuth client id')
      .fill('playwright-client.apps.googleusercontent.com');
    await page.getByLabel('Google OAuth client secret').fill('GOCSPX-playwright');
    await page
      .getByLabel('Pub/Sub topic')
      .fill('projects/playwright-mail/topics/gmail-notifications');
    await page
      .getByLabel('Push service account email')
      .fill('logistics-copilot-push@playwright-mail.iam.gserviceaccount.com');
    await page.getByRole('button', { name: 'Create tenant', exact: true }).click();
    const tenantStatus = page.getByRole('status').filter({ hasText: 'Tenant created:' });
    await expect(tenantStatus).toBeVisible();
    const tenantId = (await tenantStatus.locator('code').textContent()) ?? '';
    await expect(page.getByLabel('Tenant id')).toHaveValue(tenantId);

    const mailboxEmail = `desk-${Date.now()}@playwright.example`;
    await page.getByLabel('Mailbox email').fill(mailboxEmail);
    await page.getByLabel('Initial password').fill('owner-initial-password');
    await page.getByRole('button', { name: 'Create mailbox', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Mailbox created:' })).toBeVisible();

    // The operator cookie is not a mailbox session: /mailbox still asks the owner to sign in.
    await page.goto('/login');
    await page.getByLabel('Work email').fill(mailboxEmail);
    await page.getByLabel('Password', { exact: true }).fill('owner-initial-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(/\/mailbox/);
  });

  test('a wrong operator password is refused without a session', async ({ page }) => {
    await page.goto('/operator');
    await page.getByLabel('Operator email').fill('operator@example.com');
    await page.getByLabel('Password', { exact: true }).fill('not-the-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('do not match');
    await expect(page.getByLabel('Desk name')).toHaveCount(0);
  });
});
