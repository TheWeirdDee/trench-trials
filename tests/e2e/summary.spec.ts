import { expect, getFreshRoundId, selectSlot, test } from './helpers';

test.describe('History', () => {
  test('a new guest sees the retention label and the honest empty state, and no metric', async ({ page }) => {
    await page.goto('/history');
    await expect(page.getByTestId('history-retention')).toHaveText('Guest history · Saved on this browser');
    await expect(page.getByTestId('history-retention-note')).toContainText('No account required. Progress is saved in this browser.');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your decisions, before and after the reveal.');
    const empty = page.getByTestId('history-empty-state');
    await expect(empty).toContainText('You have not completed a trial yet. Your first verdict will appear here.');
    await expect(empty.getByRole('link', { name: 'Play your first trial' })).toHaveAttribute('href', '/play');
    await expect(page.getByTestId('history-content')).not.toBeAttached();
  });

  test('/me redirects to /history', async ({ page }) => {
    await page.goto('/me');
    await expect(page).toHaveURL(/\/history$/);
  });

  test('an abandoned Blind Pick is not counted; a completed trial is, with Ticker Tax still insufficient', async ({
    page,
  }) => {
    const roundId = await getFreshRoundId(page.request);
    await page.goto(`/round/${roundId}`);

    // Lock blind and walk away mid-Unmask: undecided, so History stays empty.
    await selectSlot(page, 'A');
    await page.getByTestId('lock-blind-button').click();
    await expect(page.getByTestId('countdown-timer')).toBeVisible();
    await page.goto('/history');
    await expect(page.getByTestId('history-empty-state')).toBeVisible();

    // Return and decide explicitly (keep A).
    await page.goto(`/round/${roundId}`);
    await page.getByTestId('lock-final-button').click();
    await expect(page.getByTestId('verdict-headline')).toContainText('You kept your blind choice: Slot A.');

    await page.goto('/history');
    await expect(page.getByTestId('history-content')).toBeVisible();
    await expect(page.getByTestId('stat-completed-value')).toHaveText('1');
    await expect(page.getByTestId('stat-switches-value')).toHaveText('0 / 0');
    await expect(page.getByTestId('ticker-tax-status')).toHaveText('Insufficient evidence');
    await expect(page.getByTestId('ticker-tax-evidence')).toContainText('1 of 5 explicit decisions');
    const entries = page.getByTestId('history-entry');
    await expect(entries).toHaveCount(1);
    await expect(entries.first()).toContainText('Kept Slot A');
    await expect(entries.first()).toContainText('POPCAT');
  });
});
