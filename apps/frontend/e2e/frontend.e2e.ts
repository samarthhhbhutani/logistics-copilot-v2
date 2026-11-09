import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

async function signIn(page: Page, email = 'ops@example.com') {
  await page.goto('/login');
  await page.getByLabel('Work email').fill(email);
  await page.getByLabel('Password', { exact: true }).fill('frontend-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'All mail', exact: true })).toBeVisible();
}

test('password login, cookie session, paging, folder reset, browser back and account isolation', async ({
  page,
  context,
}) => {
  await page.goto('/login');
  await page.getByLabel('Work email').fill('ops@example.com');
  await page.getByLabel('Password', { exact: true }).fill('wrong-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('do not match');
  await expect(page.getByLabel('Password', { exact: true })).toBeFocused();
  await page.getByLabel('Password', { exact: true }).fill('frontend-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText('RFQ: Mumbai to Rotterdam')).toBeVisible();
  await expect(page.getByText('Sales mailbox private conversation')).toHaveCount(0);
  await expect(page.getByText('Unknown sender', { exact: true })).toBeVisible();
  await expect(page.getByText('(No subject)', { exact: true })).toBeVisible();
  await expect(page.locator('.emailRows img')).toHaveCount(0);
  expect((await context.cookies()).find((cookie) => cookie.name === 'lc_session')?.httpOnly).toBe(
    true,
  );
  expect(await page.evaluate(() => window.localStorage.length)).toBe(0);
  await expect(page.getByText('30 messages on this page')).toBeVisible();
  await page.getByRole('button', { name: 'Older', exact: true }).click();
  await expect(page.getByText('5 messages on this page')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Older', exact: true })).toBeDisabled();
  await page.goBack();
  await expect(page.getByText('30 messages on this page')).toBeVisible();
  await page.getByRole('button', { name: 'Sent', exact: true }).click();
  await expect(page).toHaveURL(/label=sent$/);
  await expect(page.getByText('7 messages on this page')).toBeVisible();
  await expect(page.locator('.emailSender').first()).toContainText('To: Ocean Freight Desk');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sent', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await signIn(page, 'sales@example.com');
  await expect(page.getByText('Sales mailbox private conversation')).toBeVisible();
  await expect(page.getByText('RFQ: Mumbai to Rotterdam')).toHaveCount(0);
});

test('connect, real callback redirect, success confirmation and cancelled consent', async ({
  page,
}) => {
  await signIn(page, 'new@example.com');
  await page.request.delete('/v1/mailbox/gmail');
  await page.reload();
  await expect(page.getByText('Connect Gmail to start receiving mail')).toBeVisible();
  await page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Connect your mailbox' })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.route('https://accounts.google.com/**', async (route) => {
    const state = new URL(route.request().url()).searchParams.get('state');
    await route.fulfill({
      status: 302,
      headers: {
        location: `http://127.0.0.1:4180/v1/mailbox/gmail/callback?state=${encodeURIComponent(state ?? '')}&code=synthetic`,
      },
      body: '',
    });
  });
  await page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connection successful' })).toBeVisible();
  await expect(page.locator('.mailboxIdentity')).toContainText('new@example.com');
  await page.getByRole('button', { name: 'Continue to mailbox' }).click();
  await expect(page.getByText('Gmail connected', { exact: true })).toBeVisible();
  await page.goto('/mailbox?error=denied');
  await expect(page.getByRole('heading', { name: 'Connection failed' })).toBeVisible();
  await expect(page.getByText('Google access was cancelled.', { exact: false })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connection successful' })).toBeVisible();
});

test('reconnect banner preserves stored mail; mismatch uses session mailbox, not query text', async ({
  page,
}) => {
  await page.route('**/v1/mailbox', async (route) => {
    const response = await route.fetch();
    const mailbox = await response.json();
    await route.fulfill({ json: { ...mailbox, gmailConnectionStatus: 'needs_reconnect' } });
  });
  await signIn(page);
  await expect(page.getByText('Reconnect Gmail to receive new mail')).toBeVisible();
  await expect(page.getByText('RFQ: Mumbai to Rotterdam')).toBeVisible();
  await page.goto('/mailbox?error=email_mismatch&expectedEmail=attacker@example.com');
  await expect(page.locator('.mailboxIdentity')).toContainText('ops@example.com');
  await expect(page.getByText('attacker@example.com')).toHaveCount(0);
});

test('expired session clears mail and network errors retry', async ({ page }) => {
  await signIn(page);
  await page.route('**/v1/mailbox/emails?**', (route) =>
    route.fulfill({ status: 503, json: { error: 'unavailable' } }),
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Showing saved messages');
  await expect(page.getByText('RFQ: Mumbai to Rotterdam')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeFocused();
  await page.unroute('**/v1/mailbox/emails?**');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('RFQ: Mumbai to Rotterdam')).toBeVisible();
  await page.route('**/v1/mailbox/emails?**', (route) =>
    route.fulfill({ status: 401, json: { error: 'not_authenticated' } }),
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByText('RFQ: Mumbai to Rotterdam')).toHaveCount(0);
});

test('login and inbox are keyboard accessible, have no serious accessibility issues or horizontal overflow', async ({
  page,
}) => {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await signIn(page);
  await expect(page.getByText('RFQ: Mumbai to Rotterdam')).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.keyboard.press('Tab');
  await expect(page.locator(':focus')).toBeVisible();
});

test('query-string success is not accepted for a disconnected mailbox', async ({ page }) => {
  await signIn(page, 'new@example.com');
  await page.request.delete('/v1/mailbox/gmail');
  await page.goto('/mailbox?connected=1');
  await expect(page.getByRole('heading', { name: 'Connection failed' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Connection successful' })).toHaveCount(0);
});

for (const trigger of ['mailbox', 'emails'] as const) {
  test(`cross-tab account switch rejects another account's ${trigger} before rendering`, async ({
    page,
    context,
  }) => {
    await signIn(page);
    await expect(page.getByText('RFQ: Mumbai to Rotterdam')).toBeVisible();
    const session = await (await page.request.get('/v1/me')).json();
    // Keep /me on the original identity to force the race where a resource responds first.
    await page.route('**/v1/me', (route) => route.fulfill({ json: session }));
    await page.evaluate(() => {
      document.documentElement.dataset.wrongAccountRendered = 'false';
      new MutationObserver(() => {
        if (document.body.textContent?.includes('Sales mailbox private conversation')) {
          document.documentElement.dataset.wrongAccountRendered = 'true';
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
    });
    const otherTab = await context.newPage();
    await otherTab.goto('/mailbox');
    await expect(otherTab.getByText('RFQ: Mumbai to Rotterdam')).toBeVisible();
    await otherTab.getByRole('button', { name: 'Sign out', exact: true }).click();
    await signIn(otherTab, 'sales@example.com');
    await expect(otherTab.getByText('Sales mailbox private conversation')).toBeVisible();
    if (trigger === 'mailbox') {
      // Only mailbox metadata responds. Its identity must also be checked independently.
      await page.route('**/v1/mailbox/emails?**', (route) => route.abort());
      await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    } else {
      // Folder navigation reads mail without refetching cached mailbox metadata.
      await page.getByRole('button', { name: 'Inbox', exact: true }).click();
    }
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
    await expect(page.getByText('Sales mailbox private conversation')).toHaveCount(0);
    expect(await page.locator('html').getAttribute('data-wrong-account-rendered')).toBe('false');
  });
}

test('focus checks the session immediately after sign-out in another tab', async ({
  page,
  context,
}) => {
  await signIn(page);
  await expect(page.getByText('RFQ: Mumbai to Rotterdam')).toBeVisible();
  const otherTab = await context.newPage();
  await otherTab.request.post('/v1/auth/logout');
  const sessionCheck = page.waitForResponse('**/v1/me');
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await sessionCheck;
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.getByText('RFQ: Mumbai to Rotterdam')).toHaveCount(0);
});

test('background session and mailbox failures preserve cached mail', async ({ page }) => {
  await signIn(page);
  await expect(page.getByText('RFQ: Mumbai to Rotterdam')).toBeVisible();
  await page.route('**/v1/me', (route) =>
    route.fulfill({ status: 503, json: { error: 'unavailable' } }),
  );
  const sessionCheck = page.waitForResponse('**/v1/me');
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')));
  await sessionCheck;
  await expect(page.getByRole('alert')).toContainText('Session check failed');
  await expect(page.getByText('RFQ: Mumbai to Rotterdam')).toBeVisible();
  await page.route('**/v1/mailbox', (route) =>
    route.fulfill({ status: 503, json: { error: 'unavailable' } }),
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Mailbox refresh failed.', { exact: false })).toBeVisible();
  await expect(page.getByText('RFQ: Mumbai to Rotterdam')).toBeVisible();
});

test('first-load mail failures show a retry screen', async ({ page }) => {
  await page.route('**/v1/mailbox/emails?**', (route) =>
    route.fulfill({ status: 503, json: { error: 'unavailable' } }),
  );
  await signIn(page);
  await expect(page.getByRole('heading', { name: 'Mail could not be loaded' })).toBeVisible();
  await page.unroute('**/v1/mailbox/emails?**');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByText('RFQ: Mumbai to Rotterdam')).toBeVisible();
});

test('Google redirect stays guarded until navigation, and browser cache restore permits retry', async ({
  page,
}) => {
  await signIn(page, 'new@example.com');
  await page.goto('/mailbox?setup=1');
  await expect(page.getByRole('heading', { name: 'Connect your mailbox' })).toBeVisible();
  // A 204 cancels document replacement, keeping redirecting React state observable.
  // Emit the persisted pageshow event explicitly; bfcache eligibility varies under automation.
  await page.route('https://accounts.google.com/**', (route) => route.fulfill({ status: 204 }));
  let connectRequests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith('/v1/mailbox/gmail/connect')) connectRequests += 1;
  });
  await page.getByRole('button', { name: 'Connect Gmail', exact: true }).click();
  const openingGoogle = page.getByRole('button', { name: 'Opening Google…', exact: true });
  await expect(openingGoogle).toBeDisabled();
  await openingGoogle.focus();
  await page.keyboard.press('Enter');
  expect(connectRequests).toBe(1);
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  await expect(page.getByRole('button', { name: 'Connect Gmail', exact: true })).toBeEnabled();
});
