import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { emailFrameLayoutScriptHash } from '../src/emailFrameDocument.js';
import {
  cellTexts,
  delayedImageUrl,
  deniedImageUrl,
  finalLine,
  fixedWidthLayoutHtml,
  senderCascadeHtml,
} from './laptopEmailLayoutFixtures.js';
import type { WidthStyleSource } from './laptopEmailLayoutFixtures.js';

const laptopWidths = [1280, 1366, 1440];
const inlineSampleSubject = 'Clearance charges - Mundra import (inline image sample)';
const messageFrameSelector = 'iframe[title="Email message body"]';
const frameSandbox = 'allow-scripts allow-popups allow-popups-to-escape-sandbox';

test.skip(({ isMobile }) => isMobile, 'Laptop layout acceptance only');

async function openSyntheticEmail(page: Page, bodyHtml: string) {
  await page.route('**/v1/mailbox/threads/1003', async (route) => {
    const response = await route.fetch();
    const thread = await response.json();
    thread.emails[0].bodyHtml = bodyHtml;
    await route.fulfill({ response, json: thread });
  });
  await page.goto('/login');
  await page.getByLabel('Work email').fill('ops@example.com');
  await page.getByLabel('Password', { exact: true }).fill('frontend-test-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('link').filter({ hasText: inlineSampleSubject }).click();
  await expect(page.frameLocator(messageFrameSelector).getByText(finalLine)).toBeVisible();
}

/** Every reason the rendered email does not fit; an empty list is a pass. */
async function findLayoutProblems(page: Page): Promise<string[]> {
  const frameElement = page.locator(messageFrameSelector);
  const frameHeight = await frameElement.evaluate((frame) => frame.getBoundingClientRect().height);
  const pageOverflows = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  const frameProblems = await page
    .frameLocator(messageFrameSelector)
    .locator('body')
    .evaluate(
      (body, { frameHeight, cellTexts, finalLine }) => {
        const problems: string[] = [];
        const describe = (element: Element) =>
          `${element.tagName.toLowerCase()}${element.className ? `.${element.className}` : ''}`;
        const bodyHeight = body.getBoundingClientRect().height;
        if (Math.abs(frameHeight - Math.ceil(bodyHeight)) > 1)
          problems.push(`frame height ${frameHeight} != body height ${bodyHeight}`);
        if (document.documentElement.scrollWidth > innerWidth + 1)
          problems.push(`root scrollWidth ${document.documentElement.scrollWidth} > ${innerWidth}`);
        if (document.documentElement.scrollHeight > innerHeight + 1)
          problems.push(
            `root scrollHeight ${document.documentElement.scrollHeight} > ${innerHeight}`,
          );
        for (const element of body.querySelectorAll('*')) {
          if (['SCRIPT', 'STYLE', 'COL', 'COLGROUP'].includes(element.tagName)) continue;
          const bounds = element.getBoundingClientRect();
          let container = element.parentElement!;
          // Inline parents such as a linked image's <a> report line fragments, not a box.
          while (getComputedStyle(container).display === 'inline')
            container = container.parentElement!;
          const parentBounds = container.getBoundingClientRect();
          if (bounds.left < -1 || bounds.right > innerWidth + 1)
            problems.push(
              `${describe(element)} spans ${bounds.left}..${bounds.right} of ${innerWidth}`,
            );
          else if (bounds.right > parentBounds.right + 1)
            problems.push(
              `${describe(element)} right ${bounds.right} > parent ${parentBounds.right}`,
            );
          const style = getComputedStyle(element);
          // Chromium gives replaced <img> elements overflow: clip by default.
          if (
            element.tagName !== 'IMG' &&
            ['hidden', 'clip', 'scroll', 'auto'].includes(style.overflowX)
          )
            problems.push(`${describe(element)} overflow-x ${style.overflowX}`);
          if (style.transform !== 'none' || style.zoom !== '1' || style.visibility !== 'visible')
            problems.push(`${describe(element)} transform/zoom/visibility workaround`);
        }
        const cells = [...body.querySelectorAll('td td')];
        const cellText = cells.map((cell) => (cell as HTMLElement).innerText).join('\n');
        for (const text of cellTexts)
          if (!cellText.includes(text)) problems.push(`cell text missing: ${text.slice(0, 24)}`);
        for (const cell of cells) {
          if (cell.scrollWidth > cell.clientWidth + 1 || cell.scrollHeight > cell.clientHeight + 1)
            problems.push(`cell clips content: ${(cell as HTMLElement).innerText.slice(0, 24)}`);
          if (getComputedStyle(cell).fontSize !== '15px')
            problems.push(`cell font-size ${getComputedStyle(cell).fontSize}`);
        }
        const lastParagraph = [...body.querySelectorAll('p')].at(-1)!;
        if (lastParagraph.textContent !== finalLine) problems.push('final line missing');
        else if (lastParagraph.getBoundingClientRect().bottom > bodyHeight + 1)
          problems.push('final line below frame');
        for (const image of body.querySelectorAll('img')) {
          const bounds = image.getBoundingClientRect();
          if (image.naturalWidth > 0) {
            const renderedRatio = bounds.width / bounds.height;
            const naturalRatio = image.naturalWidth / image.naturalHeight;
            if (Math.abs(renderedRatio / naturalRatio - 1) > 0.02)
              problems.push(`${image.alt} ratio ${renderedRatio} != ${naturalRatio}`);
          }
          const intendedWidth = image.alt === 'Small logo' ? 80 : 1100;
          if (bounds.width > intendedWidth + 0.5)
            problems.push(`${image.alt} upscaled to ${bounds.width}`);
          if (image.alt === 'Small logo' && Math.abs(bounds.width - 80) > 0.5)
            problems.push(`small logo resized to ${bounds.width}`);
        }
        return problems;
      },
      { frameHeight, cellTexts, finalLine },
    );
  return pageOverflows ? ['outer page overflows', ...frameProblems] : frameProblems;
}

async function expectLaptopLayoutFits(page: Page) {
  await expect.poll(() => findLayoutProblems(page)).toEqual([]);
}

async function expectSandboxUnchanged(page: Page) {
  const frameElement = page.locator(messageFrameSelector);
  await expect(frameElement).toHaveAttribute('sandbox', frameSandbox);
  await expect(frameElement).toHaveAttribute('referrerpolicy', 'no-referrer');
  const frame = page.frameLocator(messageFrameSelector);
  await expect(frame.locator('script')).toHaveCount(1);
  await expect(frame.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
    'content',
    new RegExp(
      `script-src '${emailFrameLayoutScriptHash.replace(/[+/=]/g, '\\$&')}'; script-src-attr 'none'`,
    ),
  );
}

async function expectImagesDecoded(page: Page) {
  const images = page.frameLocator(messageFrameSelector).locator('img');
  await expect(images).toHaveCount(2);
  for (const image of await images.all())
    await expect
      .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
      .toBe(160);
}

// Auto layout preserves preferred proportions approximately; cell padding and text also need space.
async function wideToNarrowColumnRatio(page: Page) {
  return page
    .frameLocator(messageFrameSelector)
    .locator('td td')
    .first()
    .evaluate(
      (wideCell) =>
        wideCell.getBoundingClientRect().width /
        wideCell.nextElementSibling!.getBoundingClientRect().width,
    );
}

test('measured nested fixed-width table and linked banner fit laptop widths while resizing', async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSyntheticEmail(page, fixedWidthLayoutHtml('htmlAttributes'));
  await expectSandboxUnchanged(page);
  await expectImagesDecoded(page);
  for (const width of laptopWidths) {
    await page.setViewportSize({ width, height: 900 });
    await expectLaptopLayoutFits(page);
    expect(await wideToNarrowColumnRatio(page)).toBeGreaterThan(1.8);
    expect(await wideToNarrowColumnRatio(page)).toBeLessThan(2.2);
    await page.screenshot({ path: testInfo.outputPath(`laptopEmailLayout${width}.png`) });
  }
});

const otherWidthSources: WidthStyleSource[] = ['inlineStyles', 'importantStylesheet'];

for (const source of otherWidthSources) {
  test(`fixed widths from ${source} fit every laptop width and keep approximately 2:1 columns`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSyntheticEmail(page, fixedWidthLayoutHtml(source));
    await expectImagesDecoded(page);
    for (const width of laptopWidths) {
      await page.setViewportSize({ width, height: 900 });
      await expectLaptopLayoutFits(page);
      expect(await wideToNarrowColumnRatio(page), `${source} at ${width}`).toBeGreaterThan(1.8);
      expect(await wideToNarrowColumnRatio(page), `${source} at ${width}`).toBeLessThan(2.2);
    }
    await expectSandboxUnchanged(page);
  });
}

test('fitted layout survives reload and collapsing then expanding the message', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 900 });
  await openSyntheticEmail(page, fixedWidthLayoutHtml('htmlAttributes'));
  await expectLaptopLayoutFits(page);
  await page.reload();
  await expect(page.frameLocator(messageFrameSelector).getByText(finalLine)).toBeVisible();
  await expectImagesDecoded(page);
  await expectLaptopLayoutFits(page);
  await page.locator('.threadMessage summary').click();
  await expect(page.locator(messageFrameSelector)).toHaveCount(0);
  await page.locator('.threadMessage summary').click();
  await expect(page.frameLocator(messageFrameSelector).getByText(finalLine)).toBeVisible();
  await expectLaptopLayoutFits(page);
  await expectSandboxUnchanged(page);
});

test('layout fits when the banner is denied, including after Retry images', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSyntheticEmail(page, fixedWidthLayoutHtml('htmlAttributes', deniedImageUrl));
  await expect(page.getByRole('alert')).toContainText('Some images could not be loaded.');
  await expectLaptopLayoutFits(page);
  await page.getByRole('button', { name: 'Retry images', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Some images could not be loaded.');
  await expectLaptopLayoutFits(page);
  await expectSandboxUnchanged(page);
});

test('layout fits while the banner downloads and stays stable once it loads', async ({
  page,
}, testInfo) => {
  test.setTimeout(45_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  const retryCase = `laptop-${testInfo.retry}-${Date.now()}`;
  await openSyntheticEmail(
    page,
    fixedWidthLayoutHtml('htmlAttributes', delayedImageUrl(retryCase)),
  );
  const delayedBanner = page
    .frameLocator(messageFrameSelector)
    .getByRole('img', { name: 'Linked banner' });
  await expect(delayedBanner).toHaveJSProperty('complete', false);
  await expectLaptopLayoutFits(page);
  await expect(delayedBanner).toHaveJSProperty('complete', false);

  // The synthetic server releases the delayed body after 30 seconds.
  await expect
    .poll(() => delayedBanner.evaluate((image: HTMLImageElement) => image.naturalWidth), {
      timeout: 40_000,
    })
    .toBe(160);
  await expectLaptopLayoutFits(page);
  const heights = await page.locator(messageFrameSelector).evaluate(
    (frame) =>
      new Promise<number[]>((resolve) => {
        const measurements: number[] = [];
        const measureNextFrame = () => {
          measurements.push(frame.getBoundingClientRect().height);
          if (measurements.length < 3) requestAnimationFrame(measureNextFrame);
          else resolve(measurements);
        };
        requestAnimationFrame(measureNextFrame);
      }),
  );
  expect(new Set(heights).size).toBe(1);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

async function measureSenderCascade(page: Page) {
  return page
    .frameLocator(messageFrameSelector)
    .locator('body')
    .evaluate(() => {
      const tables = [...document.querySelectorAll('table')];
      const sharedCells = [...tables[1]!.querySelectorAll('td')];
      const maximumContainer = [...document.querySelectorAll('p')].find(
        (paragraph) => paragraph.textContent === 'Container keeps its sender maximum.',
      )!.parentElement!;
      return {
        frameWidth: innerWidth,
        maxWidthContainer: maximumContainer.getBoundingClientRect().width,
        stylesheetWidthTable: tables[0]!.getBoundingClientRect().width,
        sharedClassTable: tables[1]!.getBoundingClientRect().width,
        sharedCellWidths: sharedCells.map((cell) => cell.getBoundingClientRect().width),
        mediaWidthTable: tables[2]!.getBoundingClientRect().width,
      };
    });
}

test('sender max-width, stylesheet precedence, shared classes and media widths survive fitting', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSyntheticEmail(page, senderCascadeHtml);
  for (const { width, mediaTableWidth } of [
    { width: 1440, mediaTableWidth: 800 },
    { width: 1280, mediaTableWidth: 500 },
    { width: 1440, mediaTableWidth: 800 },
  ]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(async () => (await measureSenderCascade(page)).mediaWidthTable, `media at ${width}`)
      .toBeCloseTo(mediaTableWidth, 0);
    const cascade = await measureSenderCascade(page);
    expect(cascade.frameWidth, `frame at ${width}`).toBeGreaterThanOrEqual(860);
    expect(cascade.frameWidth >= 900, `frame at ${width} vs media threshold`).toBe(width === 1440);
    expect(cascade.maxWidthContainer).toBeCloseTo(600, 0);
    expect(cascade.stylesheetWidthTable).toBeCloseTo(420, 0);
    expect(Math.abs(cascade.sharedClassTable - cascade.frameWidth)).toBeLessThanOrEqual(1);
    const [leftCell, rightCell] = cascade.sharedCellWidths;
    expect(Math.abs(leftCell! - rightCell!)).toBeLessThanOrEqual(1);
    expect(leftCell! + rightCell!).toBeLessThanOrEqual(cascade.sharedClassTable + 1);
  }
  await expectSandboxUnchanged(page);
});
