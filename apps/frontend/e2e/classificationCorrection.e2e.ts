import { expect, test } from '@playwright/test';
import type { Locator, Page, Request } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Writes go to the synthetic server, which keeps them for the whole run (both projects, retries).
// So every writing test owns one otherwise-unused "Shipment update N" mail and resets it through
// the real API first; the RFQ thread other specs assert on is only ever read here.
const rfqSubject = 'RFQ: Mumbai to Rotterdam · 2 × 40ft';
const labelTitles = ['General', 'Customer request', 'Customer reply', 'Rate card'];
const unknownSaveWarning =
  'We could not confirm whether the classification was saved. Refresh the conversation before trying again.';

function syntheticEmailId(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function syntheticThreadId(index: number) {
  return (0x1000 + index).toString(16);
}

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

async function resetToGeneral(page: Page, index: number) {
  const response = await page.request.post(
    `/v1/mailbox/emails/${syntheticEmailId(index)}/classifications`,
    { data: { label: 'general' } },
  );
  expect(response.status()).toBe(201);
}

async function openShipmentThread(page: Page, index: number) {
  await messageLink(page, `Shipment update ${index}`).click();
  await expect(
    page.getByRole('heading', { name: `Shipment update ${index}`, exact: true }),
  ).toBeVisible();
  const message = page.locator('.threadMessage');
  await expect(message).toHaveCount(1);
  return message;
}

async function signInWithGeneralShipment(page: Page, index: number) {
  await signIn(page);
  await resetToGeneral(page, index);
  return openShipmentThread(page, index);
}

function collectClassificationPosts(page: Page): Request[] {
  const posts: Request[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/classifications'))
      posts.push(request);
  });
  return posts;
}

function postedLabels(posts: Request[]) {
  return posts.map((request) => (request.postDataJSON() as { label: string }).label);
}

async function routeClassificationPost(
  page: Page,
  index: number,
  handler: Parameters<Page['route']>[1],
) {
  await page.route(
    `**/v1/mailbox/emails/${syntheticEmailId(index)}/classifications`,
    (route, request) => (request.method() === 'POST' ? handler(route, request) : route.continue()),
  );
}

/** Shows a different stored classification for one mail until the first correction is sent. */
async function overrideStoredClassification(page: Page, index: number, classification: unknown) {
  const emailId = syntheticEmailId(index);
  let correctionSent = false;
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith(`${emailId}/classifications`))
      correctionSent = true;
  });
  const rewrite = (email: { id: string; classification: unknown }) =>
    email.id === emailId ? { ...email, classification } : email;
  await page.route(`**/v1/mailbox/emails/${emailId}`, async (route) => {
    const response = await route.fetch();
    if (correctionSent) return route.fulfill({ response });
    return route.fulfill({ response, json: rewrite(await response.json()) });
  });
  await page.route(`**/v1/mailbox/threads/${syntheticThreadId(index)}`, async (route) => {
    const response = await route.fetch();
    if (correctionSent) return route.fulfill({ response });
    const thread = await response.json();
    return route.fulfill({ response, json: { ...thread, emails: thread.emails.map(rewrite) } });
  });
}

function correctionTrigger(message: Locator) {
  return message.getByRole('button', { name: 'Correct classification', exact: true });
}

function correctionForm(message: Locator) {
  return message.getByRole('form', { name: 'Correct classification' });
}

function classificationSelect(message: Locator) {
  return correctionForm(message).getByLabel('Classification', { exact: true });
}

function saveButton(message: Locator) {
  return correctionForm(message).getByRole('button', { name: 'Save classification', exact: true });
}

function confirmButton(message: Locator) {
  return correctionForm(message).getByRole('button', {
    name: 'Confirm classification',
    exact: true,
  });
}

function cancelButton(message: Locator) {
  return correctionForm(message).getByRole('button', { name: 'Cancel', exact: true });
}

function messageBadge(message: Locator) {
  return message.locator('.messageClassification .classificationBadge');
}

function statusMessage(page: Page, text: string) {
  return page.getByRole('status').filter({ hasText: text });
}

async function openCorrectionForm(message: Locator) {
  await correctionTrigger(message).click();
  await expect(correctionForm(message)).toBeVisible();
}

async function expectSignedOut(page: Page) {
  await expect(page.getByRole('heading', { name: 'Welcome back.' })).toBeVisible();
  await expect(page.locator('.threadMessage')).toHaveCount(0);
  await expect(page.locator('.messageBody')).toHaveCount(0);
  await expect(statusMessage(page, 'Classification saved.')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.length)).toBe(0);
}

async function expectStoredBadge(page: Page, index: number, title: string) {
  await signIn(page);
  const message = await openShipmentThread(page, index);
  await expect(messageBadge(message)).toHaveText(title);
}

test('each expanded inbound message has its own correction form; sent mail has none; cancel writes nothing', async ({
  page,
}) => {
  const posts = collectClassificationPosts(page);
  await signIn(page);
  await messageLink(page, rfqSubject).click();
  await expect(page.getByRole('heading', { name: rfqSubject, exact: true })).toBeVisible();
  const messages = page.locator('.threadMessages .threadMessage');
  await expect(messages).toHaveCount(3);
  await messages.nth(1).locator('summary').click();
  await messages.nth(2).locator('summary').click();
  const [latestReply, sentOffer, firstRequest] = [
    messages.nth(0),
    messages.nth(1),
    messages.nth(2),
  ];
  await expect(sentOffer.getByText('Outbound mail is not classified')).toBeVisible();
  await expect(correctionTrigger(sentOffer)).toHaveCount(0);
  await expect(correctionTrigger(latestReply)).toHaveCount(1);
  await expect(correctionTrigger(firstRequest)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Correct classification' })).toHaveCount(2);

  await openCorrectionForm(firstRequest);
  await expect(page.getByRole('form', { name: 'Correct classification' })).toHaveCount(1);
  await expect(correctionForm(latestReply)).toHaveCount(0);
  const select = classificationSelect(firstRequest);
  expect(
    (await select.locator('option').allTextContents()).map((text) => text.trim()).sort(),
  ).toEqual([...labelTitles].sort());
  await expect(select.locator('option:checked')).toHaveText('Customer request');
  await expect(confirmButton(firstRequest)).toBeVisible();
  await expect(saveButton(firstRequest)).toHaveCount(0);
  await select.selectOption({ label: 'Rate card' });
  await expect(saveButton(firstRequest)).toBeVisible();
  await expect(confirmButton(firstRequest)).toHaveCount(0);
  await select.selectOption({ label: 'Customer request' });
  await expect(confirmButton(firstRequest)).toBeVisible();
  await expect(cancelButton(firstRequest)).toBeVisible();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await select.selectOption({ label: 'Rate card' });
  await cancelButton(firstRequest).click();
  await expect(correctionForm(firstRequest)).toHaveCount(0);
  await expect(correctionTrigger(firstRequest)).toBeFocused();
  await expect(messageBadge(firstRequest)).toHaveText('Customer request');
  await expect(firstRequest.getByText('AI classification · 94% confidence')).toBeVisible();
  await openCorrectionForm(firstRequest);
  await expect(classificationSelect(firstRequest).locator('option:checked')).toHaveText(
    'Customer request',
  );
  await cancelButton(firstRequest).click();
  await expect(correctionTrigger(firstRequest)).toBeFocused();

  await openCorrectionForm(latestReply);
  await expect(classificationSelect(latestReply).locator('option:checked')).toHaveText(
    'Customer reply',
  );
  await cancelButton(latestReply).click();
  await expect(correctionTrigger(latestReply)).toBeFocused();
  await expect(messageBadge(latestReply)).toHaveText('Customer reply');
  await expect(latestReply.getByText('From this conversation')).toBeVisible();
  expect(posts).toEqual([]);
});

test('every label can be saved and each save updates the badge and source', async ({ page }) => {
  const message = await signInWithGeneralShipment(page, 6);
  const posts = collectClassificationPosts(page);
  await openCorrectionForm(message);
  await expect(confirmButton(message)).toBeVisible();
  await cancelButton(message).click();
  for (const title of ['Customer request', 'Customer reply', 'Rate card', 'General']) {
    await openCorrectionForm(message);
    await classificationSelect(message).selectOption({ label: title });
    await saveButton(message).click();
    await expect(statusMessage(page, 'Classification saved.')).toBeVisible();
    await expect(correctionForm(message)).toHaveCount(0);
    await expect(messageBadge(message)).toHaveText(title);
    await expect(message.getByText('Operator correction')).toBeVisible();
  }
  expect(postedLabels(posts)).toEqual([
    'customer_request',
    'customer_reply',
    'rate_card',
    'general',
  ]);
});

test('a changed label survives going back to All mail and Inbox, reloads and reopening', async ({
  page,
}) => {
  const message = await signInWithGeneralShipment(page, 7);
  await openCorrectionForm(message);
  await classificationSelect(message).selectOption({ label: 'Rate card' });
  await saveButton(message).click();
  await expect(statusMessage(page, 'Classification saved.')).toBeVisible();
  await expect(messageBadge(message)).toHaveText('Rate card');
  const listBadge = messageLink(page, 'Shipment update 7').locator('.classificationBadge');
  await page.getByRole('link', { name: 'Back to All mail' }).click();
  await expect(listBadge).toHaveText('Rate card');
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await expect(listBadge).toHaveText('Rate card');
  await page.reload();
  await expect(listBadge).toHaveText('Rate card');
  const reopened = await openShipmentThread(page, 7);
  await expect(messageBadge(reopened)).toHaveText('Rate card');
  await expect(reopened.getByText('Operator correction')).toBeVisible();
  await page.reload();
  await expect(messageBadge(page.locator('.threadMessage'))).toHaveText('Rate card');
  await expect(page.locator('.threadMessage').getByText('Operator correction')).toBeVisible();
});

test('confirming the unchanged label records an operator confirmation', async ({ page }) => {
  await signIn(page);
  await resetToGeneral(page, 8);
  await overrideStoredClassification(page, 8, {
    label: 'general',
    source: 'llm',
    confidence: 0.81,
    classifiedAt: '2026-11-09T13:00:00.000Z',
  });
  const posts = collectClassificationPosts(page);
  const message = await openShipmentThread(page, 8);
  await expect(message.getByText('AI classification · 81% confidence')).toBeVisible();
  await openCorrectionForm(message);
  await expect(classificationSelect(message).locator('option:checked')).toHaveText('General');
  await expect(saveButton(message)).toHaveCount(0);
  await confirmButton(message).click();
  await expect(statusMessage(page, 'Classification confirmed.')).toBeVisible();
  await expect(statusMessage(page, 'Classification saved.')).toHaveCount(0);
  await expect(correctionForm(message)).toHaveCount(0);
  await expect(messageBadge(message)).toHaveText('General');
  await expect(message.getByText('Operator correction')).toBeVisible();
  expect(postedLabels(posts)).toEqual(['general']);
});

test('an unclassified inbound message can be classified', async ({ page }) => {
  await signIn(page);
  await resetToGeneral(page, 10);
  await overrideStoredClassification(page, 10, null);
  const posts = collectClassificationPosts(page);
  const message = await openShipmentThread(page, 10);
  await expect(message.getByText('Not classified yet')).toBeVisible();
  await expect(messageBadge(message)).toHaveCount(0);
  await openCorrectionForm(message);
  await expect(confirmButton(message)).toHaveCount(0);
  await classificationSelect(message).selectOption({ label: 'General' });
  await expect(saveButton(message)).toBeVisible();
  await expect(confirmButton(message)).toHaveCount(0);
  await classificationSelect(message).selectOption({ label: 'Rate card' });
  await saveButton(message).click();
  await expect(statusMessage(page, 'Classification saved.')).toBeVisible();
  await expect(messageBadge(message)).toHaveText('Rate card');
  await expect(message.getByText('Operator correction')).toBeVisible();
  await expect(message.getByText('Not classified yet')).toHaveCount(0);
  expect(postedLabels(posts)).toEqual(['rate_card']);
});

test('the correction form works from the keyboard and cancel returns focus to its trigger', async ({
  page,
}) => {
  const message = await signInWithGeneralShipment(page, 11);
  const posts = collectClassificationPosts(page);
  const trigger = correctionTrigger(message);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(correctionForm(message)).toBeVisible();
  const select = classificationSelect(message);
  await expect(select).toBeFocused();
  await select.selectOption({ label: 'Customer request' });
  await expect(select).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(saveButton(message)).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancelButton(message)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(correctionForm(message)).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(messageBadge(message)).toHaveText('General');
  expect(posts).toEqual([]);

  await page.keyboard.press('Enter');
  await expect(classificationSelect(message)).toBeFocused();
  await expect(classificationSelect(message).locator('option:checked')).toHaveText('General');
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await classificationSelect(message).focus();
  await classificationSelect(message).selectOption({ label: 'Customer request' });
  await page.keyboard.press('Tab');
  await expect(saveButton(message)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(statusMessage(page, 'Classification saved.')).toBeVisible();
  await expect(messageBadge(message)).toHaveText('Customer request');
  expect(postedLabels(posts)).toEqual(['customer_request']);
});

test('a pending save cannot be submitted twice', async ({ page }) => {
  const message = await signInWithGeneralShipment(page, 12);
  const posts = collectClassificationPosts(page);
  let releasePost: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releasePost = resolve;
  });
  await routeClassificationPost(page, 12, async (route) => {
    await gate;
    await route.continue();
  });
  await openCorrectionForm(message);
  await classificationSelect(message).selectOption({ label: 'Rate card' });
  const postStarted = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/classifications'),
  );
  await saveButton(message).click();
  await postStarted;
  const submit = correctionForm(message).locator('button[type="submit"]');
  await expect(submit).toBeDisabled();
  await correctionForm(message).evaluate((form) => (form as HTMLFormElement).requestSubmit());
  await page.keyboard.press('Enter');
  expect(posts).toHaveLength(1);
  releasePost();
  await expect(statusMessage(page, 'Classification saved.')).toBeVisible();
  await expect(messageBadge(message)).toHaveText('Rate card');
  await page.waitForTimeout(500);
  expect(postedLabels(posts)).toEqual(['rate_card']);
});

test('a 401 from the save signs out and clears the conversation', async ({ page }) => {
  const message = await signInWithGeneralShipment(page, 13);
  const posts = collectClassificationPosts(page);
  await routeClassificationPost(page, 13, (route) =>
    route.fulfill({ status: 401, json: { error: 'not_authenticated' } }),
  );
  await openCorrectionForm(message);
  await classificationSelect(message).selectOption({ label: 'Rate card' });
  await saveButton(message).click();
  await expectSignedOut(page);
  expect(posts).toHaveLength(1);
  await page.unroute('**/classifications');
  // The mocked 401 did not expire the synthetic cookie. Clear it before signing back in.
  expect((await page.request.post('/v1/auth/logout')).status()).toBe(204);
  await expectStoredBadge(page, 13, 'General');
});

test('a mailbox switched in another tab before saving signs out without sending the save', async ({
  page,
}) => {
  const message = await signInWithGeneralShipment(page, 20);
  const posts = collectClassificationPosts(page);
  await openCorrectionForm(message);
  await classificationSelect(message).selectOption({ label: 'Rate card' });
  // Cookies are shared across tabs, so this stands in for another tab signing in elsewhere.
  await page.request.post('/v1/auth/login', {
    data: { email: 'sales@example.com', password: 'frontend-test-password' },
  });
  const sessionCheck = page.waitForResponse('**/v1/me');
  await saveButton(message).click();
  await sessionCheck;
  await expectSignedOut(page);
  await expect(page.getByText('Sales-only private message body')).toHaveCount(0);
  expect(posts).toEqual([]);
  expect((await page.request.post('/v1/auth/logout')).status()).toBe(204);
  await expectStoredBadge(page, 20, 'General');
});

test('a mailbox switched while the save is in flight signs out instead of reporting success', async ({
  page,
}) => {
  const message = await signInWithGeneralShipment(page, 15);
  const posts = collectClassificationPosts(page);
  await routeClassificationPost(page, 15, async (route) => {
    await page.request.post('/v1/auth/login', {
      data: { email: 'sales@example.com', password: 'frontend-test-password' },
    });
    await route.continue();
  });
  await openCorrectionForm(message);
  await classificationSelect(message).selectOption({ label: 'Rate card' });
  await saveButton(message).click();
  await expectSignedOut(page);
  await expect(page.getByText('Sales-only private message body')).toHaveCount(0);
  expect(posts).toHaveLength(1);
});

for (const failure of ['503', 'network'] as const) {
  test(`a ${failure} save failure is never replayed and warns that the outcome is unknown`, async ({
    page,
  }) => {
    const index = failure === '503' ? 16 : 17;
    const message = await signInWithGeneralShipment(page, index);
    const posts = collectClassificationPosts(page);
    await routeClassificationPost(page, index, (route) =>
      failure === '503'
        ? route.fulfill({ status: 503, json: { error: 'unavailable' } })
        : route.abort('connectionreset'),
    );
    await openCorrectionForm(message);
    await classificationSelect(message).selectOption({ label: 'Rate card' });
    await saveButton(message).click();
    await expect(page.getByText(unknownSaveWarning)).toBeVisible();
    await expect(statusMessage(page, 'Classification saved.')).toHaveCount(0);
    await expect(messageBadge(message)).toHaveText('General');
    // Longer than the transport's whole replay backoff (500 ms + 1 s).
    await page.waitForTimeout(2_000);
    expect(posts).toHaveLength(1);
    await expect(correctionTrigger(message)).toBeDisabled();
    const refreshFromForm = correctionForm(message).getByRole('button', {
      name: 'Refresh conversation',
    });
    await expect(refreshFromForm).toBeFocused();
    await page.unroute('**/classifications');
    await refreshFromForm.click();
    await expect(correctionForm(message)).toHaveCount(0);
    await expect(messageBadge(page.locator('.threadMessage'))).toHaveText('General');
    expect(posts).toHaveLength(1);
  });
}

for (const recovery of ['navigation', 'refresh'] as const) {
  test(`a committed save with a lost response is recovered by ${recovery} without replaying`, async ({
    page,
  }) => {
    const index = recovery === 'navigation' ? 21 : 22;
    await signIn(page);
    await resetToGeneral(page, index);
    // Prime the list cache with the reset value, including on the second browser project.
    await page.reload();
    await expect(
      messageLink(page, `Shipment update ${index}`).locator('.classificationBadge'),
    ).toHaveText('General');
    const message = await openShipmentThread(page, index);
    const posts = collectClassificationPosts(page);
    await routeClassificationPost(page, index, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(201);
      expect((await response.json()).label).toBe('rate_card');
      await route.abort('connectionreset');
    });
    await openCorrectionForm(message);
    await classificationSelect(message).selectOption({ label: 'Rate card' });
    await saveButton(message).click();
    await expect(page.getByText(unknownSaveWarning)).toBeVisible();
    await expect(statusMessage(page, 'Classification saved.')).toHaveCount(0);
    await expect(messageBadge(message)).toHaveText('General');
    if (recovery === 'navigation') {
      await page.getByRole('link', { name: 'Back to All mail' }).click();
      await expect(
        messageLink(page, `Shipment update ${index}`).locator('.classificationBadge'),
      ).toHaveText('Rate card');
      await openShipmentThread(page, index);
    } else {
      await correctionForm(message).getByRole('button', { name: 'Refresh conversation' }).click();
    }
    await expect(correctionForm(message)).toHaveCount(0);
    await expect(messageBadge(message)).toHaveText('Rate card');
    await expect(message.getByText('Operator correction')).toBeVisible();
    expect(postedLabels(posts)).toEqual(['rate_card']);
  });
}

for (const [status, error, text] of [
  [404, 'not_found', 'This message is no longer available in your mailbox.'],
  [409, 'not_inbound', 'This message is no longer available for classification.'],
] as const) {
  test(`a ${status} save shows "${text}" without changing the badge`, async ({ page }) => {
    const message = await signInWithGeneralShipment(page, 18);
    const posts = collectClassificationPosts(page);
    await routeClassificationPost(page, 18, (route) => route.fulfill({ status, json: { error } }));
    await openCorrectionForm(message);
    await classificationSelect(message).selectOption({ label: 'Rate card' });
    await saveButton(message).click();
    await expect(page.getByText(text)).toBeVisible();
    await expect(classificationSelect(message)).toBeFocused();
    await expect(statusMessage(page, 'Classification saved.')).toHaveCount(0);
    await expect(messageBadge(message)).toHaveText('General');
    await expect(page.getByRole('heading', { name: 'Welcome back.' })).toHaveCount(0);
    expect(posts).toHaveLength(1);
  });
}
