import { expect, test } from '@playwright/test';

test('Practice: run and jump until the first question opens, then answer it', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: /^Practice/ }).click();
  const question = page.locator('.question');

  // Platform 0 never moves and always overlaps the start pad, so one running jump lands on it.
  // Hold right, jump, and let go before running off the far side; retry if we came up short.
  for (let attempt = 0; attempt < 3 && !(await question.isVisible()); attempt++) {
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(250);
    await page.keyboard.down('Space');
    await page.waitForTimeout(450);
    await page.keyboard.up('Space');
    await page.waitForTimeout(250);
    await page.keyboard.up('ArrowRight');
    await page.waitForTimeout(900);
    if (await page.locator('.results').isVisible()) throw new Error('fell into the pit instead of landing');
  }

  await expect(question).toBeVisible();
  await expect(page.locator('.opt')).toHaveCount(4);
  const note = page.locator('.q-note');
  if (!(await note.textContent())?.trim()) {
    await expect(page.locator('.opt').first()).toBeFocused();
    await page.keyboard.press('1');
  }
  await expect(note).toHaveText(/Correct|Wrong|Time/);
  // right answer: back to the course; wrong answer: results screen
  await expect(page.locator('.question')).toBeHidden();
  const results = page.locator('.results');
  if (await results.isVisible()) await expect(page.locator('.stamp')).toHaveText('ELIMINATED');
  else await expect(page.locator('#hud')).toContainText('1/');
});

test('phone width: touch pad shows and nothing scrolls sideways', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 400, height: 800 }, hasTouch: true });
  await page.goto('/');
  await expect(page.locator('#touchpad')).toBeVisible();
  await expect(page.locator('.pad-btn')).toHaveCount(4);
  const box = await page.locator('.pad-btn').first().boundingBox();
  expect(box?.width).toBe(64);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
  await page.getByRole('button', { name: /^Practice/ }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400);
  await page.close();
});
