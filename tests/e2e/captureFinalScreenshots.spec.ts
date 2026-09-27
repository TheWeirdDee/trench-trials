import fs from 'node:fs';
import path from 'node:path';
import { expect, expectUnmaskStage, selectSlot, test } from './helpers';

/**
 * Product screenshots, taken from the production build the suite runs against
 * (`next start`, no development overlay) and the real canonical round — the same
 * verified Nansen data as production, copied into the isolated test schema. Nothing
 * here is staged: every screen is reached by playing through the real UI.
 */
const SCREENSHOTS_DIR = path.resolve(process.cwd(), 'artifacts', 'screenshots');

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 375, height: 667 },
];

test.describe('Production screenshots', () => {
  for (const viewport of VIEWPORTS) {
    const label = `${viewport.width}x${viewport.height}`;

    test(`every product screen at ${label}`, async ({ owned }) => {
      test.setTimeout(120_000);
      const dir = path.join(SCREENSHOTS_DIR, label);
      fs.mkdirSync(dir, { recursive: true });
      const shot = async (page: import('@playwright/test').Page, name: string, fullPage = false) => {
        // No page may scroll sideways at any size.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${name} overflows horizontally at ${label}`).toBeLessThanOrEqual(0);
        await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage, animations: 'disabled' });
      };

      const context = await owned.newContext({ viewport });
      const page = await context.newPage();

      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'Can you read the market before the ticker changes your mind?',
      );
      await expect(page.getByTestId('start-button')).toBeInViewport();
      await shot(page, '01-landing');
      await shot(page, '01-landing-full', true);

      await page.goto('/history');
      await expect(page.getByTestId('history-empty-state')).toBeVisible();
      await shot(page, '02-history-empty');

      await page.goto('/play');
      await expect(page.getByTestId('onboarding-sheet')).toBeVisible();
      await shot(page, '03-onboarding');
      await page.getByTestId('onboarding-start').click();
      await expect(page).toHaveURL(/\/round\//);
      await expect(page.getByTestId('slot-card-A')).toBeVisible();
      await shot(page, '04-blind-pick');

      await selectSlot(page, 'B');
      await expect(page.getByTestId('lock-blind-button')).toContainText('Lock B as my blind pick');
      // The one primary action stays on screen at every size — no scrolling to find it.
      await expect(page.getByTestId('lock-blind-button')).toBeInViewport({ ratio: 1 });
      await shot(page, '05-blind-pick-selected');

      await page.getByTestId('lock-blind-button').click();
      await expectUnmaskStage(page);
      await selectSlot(page, 'A');
      await expect(page.getByTestId('lock-final-button')).toContainText('Switch to Slot A');
      await expect(page.getByTestId('lock-final-button')).toBeInViewport({ ratio: 1 });
      await shot(page, '06-unmask');

      await page.getByTestId('lock-final-button').click();
      await expect(page.getByTestId('verdict-headline')).toContainText('You switched from Slot B to Slot A.');
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, '07-verdict');
      await shot(page, '07-verdict-full', true);

      await page.getByTestId('verification-details').locator('summary').first().click();
      await page.getByTestId('commitment-check-initial').click();
      await expect(page.getByTestId('commitment-result-initial')).toHaveText('Match — unchanged since it was sealed.');
      await page.getByTestId('verification-details').scrollIntoViewIfNeeded();
      await shot(page, '08-verification');

      await page.goto('/history');
      await expect(page.getByTestId('history-content')).toBeVisible();
      await shot(page, '09-history', true);

      await page.goto('/docs');
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('How Trench Trials works.');
      await shot(page, '10-docs');

      await page.goto('/daily');
      await expect(page.getByTestId('daily-unavailable')).toBeVisible();
      await shot(page, '11-daily-unavailable');

      await page.goto('/live');
      await expect(page.getByTestId('live-empty-state')).toBeVisible();
      await shot(page, '12-live-paused');

      // The canonical round was the only playable round in the test schema: Replay is exhausted,
      // and says so plainly, with the count and the next step.
      await page.goto('/play');
      await expect(page.getByTestId('exhausted-heading')).toHaveText('You’ve completed the current Replay catalog.');
      await expect(page.getByTestId('replay-exhausted')).toContainText('You’ve played 1 of 1 round.');
      await expect(page.getByTestId('replay-exhausted')).not.toContainText('fill the gap');
      await shot(page, '13-replay-exhausted');

      await page.goto('/evidence');
      await expect(page.getByTestId('nansen-role')).toBeVisible();
      await expect(page.getByTestId('evidence-round').first()).toBeVisible();
      await shot(page, '14-evidence');
      await shot(page, '14-evidence-full', true);
    });
  }
});
