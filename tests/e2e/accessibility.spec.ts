import AxeBuilder from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { expect, expectUnmaskStage, selectSlot, test } from './helpers';

/**
 * Accessibility: an axe audit (WCAG 2.2 A/AA plus best practices) of every major page
 * and game state, a keyboard-only journey through the whole product, visible focus,
 * and reduced motion. Runs against the production build like the rest of the suite.
 */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

async function expectNoAxeViolations(page: Page, name: string) {
  const results = await new AxeBuilder({ page }).withTags(AXE_TAGS).analyze();
  const summary = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.help}\n    ${v.nodes.map((n) => n.target.join(' ')).slice(0, 5).join('\n    ')}`,
  );
  expect(summary, `axe violations on ${name}`).toEqual([]);
}

/** Presses Tab until `target` has focus — the way a keyboard user gets there — and checks the ring is visible. */
async function tabTo(page: Page, target: Locator, maxTabs = 80) {
  for (let i = 0; i < maxTabs; i++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((el) => el === document.activeElement).catch(() => false)) {
      const outline = await target.evaluate((el) => getComputedStyle(el).outlineStyle);
      expect(outline, 'keyboard focus must be visible').not.toBe('none');
      return;
    }
  }
  throw new Error(`Could not reach ${target} with ${maxTabs} Tab presses`);
}

test.describe('Accessibility', () => {
  // Reduced motion keeps entrance animations from being measured half-faded.
  test.use({ reducedMotion: 'reduce' });

  test('axe finds no violations on any major page or game state', async ({ page }) => {
    test.setTimeout(120_000);
    for (const [path, ready] of [
      ['/', 'start-button'],
      ['/docs', null],
      ['/history', 'history-empty-state'],
      ['/daily', 'daily-unavailable'],
      ['/live', 'live-empty-state'],
    ] as const) {
      await page.goto(path);
      if (ready) await expect(page.getByTestId(ready)).toBeVisible();
      else await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expectNoAxeViolations(page, path);
    }

    await page.goto('/play');
    await expect(page.getByTestId('onboarding-sheet')).toBeVisible();
    await expectNoAxeViolations(page, 'onboarding');
    await page.getByTestId('onboarding-start').click();

    await expect(page.getByTestId('slot-card-A')).toBeVisible();
    await expectNoAxeViolations(page, 'blind pick');
    await selectSlot(page, 'B');
    await expectNoAxeViolations(page, 'blind pick, selected');
    await page.getByTestId('lock-blind-button').click();

    await expectUnmaskStage(page);
    await expectNoAxeViolations(page, 'unmask');
    await page.getByTestId('lock-final-button').click();

    await expect(page.getByTestId('verdict-headline')).toBeVisible();
    await page.getByTestId('verification-details').locator('summary').first().click();
    await expectNoAxeViolations(page, 'verdict with verification open');

    await page.goto('/history');
    await expect(page.getByTestId('history-content')).toBeVisible();
    await expectNoAxeViolations(page, 'history with a trial');
  });

  test('keyboard only: landing → Play → Blind → Unmask → Verdict → History → Docs', async ({ page }) => {
    await page.goto('/');
    await tabTo(page, page.getByTestId('start-button'));
    await page.keyboard.press('Enter');

    // The onboarding sheet opens with its primary action focused.
    await expect(page.getByTestId('onboarding-sheet')).toBeVisible();
    await expect(page.getByTestId('onboarding-start')).toBeFocused();
    await page.keyboard.press('Enter');

    const cardB = page.getByTestId('slot-card-B');
    await expect(cardB).toBeVisible();
    await tabTo(page, cardB);
    await page.keyboard.press('Space');
    await expect(cardB).toHaveAttribute('aria-pressed', 'true');
    await tabTo(page, page.getByTestId('lock-blind-button'));
    await page.keyboard.press('Enter');

    await expectUnmaskStage(page);
    await tabTo(page, page.getByTestId('lock-final-button'));
    await expect(page.getByTestId('lock-final-button')).toHaveText('Keep Slot B');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('verdict-headline')).toContainText('You kept your blind choice: Slot B.');
    await tabTo(page, page.getByRole('link', { name: 'See your History' }));
    await page.keyboard.press('Enter');

    await expect(page).toHaveURL(/\/history$/);
    await expect(page.getByTestId('history-content')).toBeVisible();
    await tabTo(page, page.getByTestId('nav-docs'));
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/docs$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('How Trench Trials works.');
  });

  test('every page has exactly one h1 and headings never skip a level', async ({ page }) => {
    for (const path of ['/', '/docs', '/history', '/daily', '/live']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
      const levels = await page.$$eval('h1, h2, h3, h4, h5, h6', (hs) =>
        hs.filter((h) => (h as HTMLElement).offsetParent !== null).map((h) => Number(h.tagName[1])),
      );
      for (let i = 1; i < levels.length; i++) {
        expect(levels[i]! - levels[i - 1]!, `${path}: heading level jumps from h${levels[i - 1]} to h${levels[i]}`).toBeLessThanOrEqual(1);
      }
    }
  });

  test('reduced motion turns entrance and reveal animations off', async ({ page }) => {
    await page.goto('/');
    const duration = await page
      .locator('.animate-rise-in')
      .first()
      .evaluate((el) => parseFloat(getComputedStyle(el).animationDuration));
    expect(duration).toBeLessThanOrEqual(0.001);
  });
});
