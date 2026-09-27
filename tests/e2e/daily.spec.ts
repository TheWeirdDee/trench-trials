import { assertNoneInContent, expect, FORBIDDEN_BEFORE_UNMASK, FORBIDDEN_BEFORE_VERDICT, selectSlot, test } from './helpers';
import {
  assignTestDaily,
  dbTodayUtc,
  deleteOwnedTestDaily,
  insertSyntheticRound,
  testPool,
  type OwnedTestDaily,
} from '../integration/fixtures';

test.describe('Daily', () => {
  test('with no Daily assigned, /daily is honest and Daily is absent from navigation', async ({ page }) => {
    await page.goto('/daily');
    await expect(page.getByRole('heading', { name: 'No Daily today.' })).toBeVisible();
    await expect(page.getByTestId('daily-unavailable')).toContainText('No Daily is scheduled for today');
    await expect(page.getByRole('link', { name: 'Play Replay' })).toBeVisible();
    await expect(page.getByTestId('nav-daily')).not.toBeAttached();
    await assertNoneInContent(page, [...FORBIDDEN_BEFORE_UNMASK, ...FORBIDDEN_BEFORE_VERDICT]);
  });

  test('an assigned Daily appears in navigation, plays its round directly, and shares without spoilers', async ({
    page,
    owned,
  }) => {
    // A synthetic canonical Replay round in the isolated test schema, assigned to today
    // directly and removed afterwards. (workers: 1, so no other test can be served it.)
    const pool = testPool();
    const { roundId } = await insertSyntheticRound({ mode: 'replay' });
    owned.ownRound(roundId);
    let daily: OwnedTestDaily | null = null;
    try {
      daily = await assignTestDaily(pool, await dbTodayUtc(pool), roundId);

      // While it is today's Daily, the round is not served as Replay — even to a guest who never played it.
      const next = await (await page.request.get('/api/rounds/next')).json();
      expect(next.roundId).not.toBe(roundId);

      await page.goto('/daily');
      await expect(page.getByTestId('nav-daily')).toBeVisible();
      await expect(page.getByText(/^Daily #\d+$/)).toBeVisible();
      await assertNoneInContent(page, ['TESTA', 'TESTB', 'TESTC']);

      // The Daily is the round itself, not a copy: the page plays exactly that round id.
      const blind = page.waitForResponse((r) => r.url().endsWith(`/api/rounds/${roundId}/blind`));
      await selectSlot(page, 'B');
      await page.getByTestId('lock-blind-button').click();
      expect((await blind).status()).toBe(200);

      await page.getByTestId('lock-final-button').click();
      await expect(page.getByTestId('verdict-headline')).toContainText('You kept your blind choice: Slot B.');

      // One measured attempt per day: the Daily says it is complete, and never offers "another round".
      await expect(page.getByTestId('daily-complete')).toContainText('Today’s Daily is complete.');
      // A synthetic fixture round: test output only, never product evidence.
      await page.screenshot({ path: 'test-results/fixture-screens/daily-complete.png', fullPage: false, animations: 'disabled' });
      await expect(page.getByTestId('next-steps').getByTestId('view-history-button')).toBeVisible();
      await expect(page.getByTestId('play-again-button')).not.toBeAttached();

      // Reloading the Daily returns the completed result, not a dead end.
      await page.reload();
      await expect(page.getByTestId('daily-complete')).toBeVisible();
      await expect(page.getByTestId('verdict-headline')).toContainText('You kept your blind choice: Slot B.');

      // Synthetic returns: A +10%, B +5%, C −2% — keeping B misses the winner.
      await expect(page.getByTestId('daily-share-text')).toContainText('Daily streak: 1');
      const shareText = (await page.getByTestId('daily-share-text').textContent()) ?? '';
      expect(shareText.split('\n').slice(0, 5)).toEqual([
        expect.stringMatching(/^Trench Trials — Daily #\d+$/),
        'Result: missed',
        'Blind → Final: kept my pick',
        'Ticker Tax: 0.0 pp',
        'Daily streak: 1',
      ]);
      expect(shareText).toMatch(/\/daily$/);
      for (const term of ['TESTA', 'TESTB', 'TESTC', 'Slot', '%', 'points', ...FORBIDDEN_BEFORE_VERDICT]) {
        expect(shareText, `share text must not contain "${term}"`).not.toContain(term);
      }

      // History records it as the Daily it was.
      await page.goto('/history');
      const entry = page.getByTestId('history-entry').first();
      await expect(entry).toContainText('Daily');
      await expect(entry).toContainText('Kept Slot B');
    } finally {
      if (daily) await deleteOwnedTestDaily(pool, daily);
    }
  });
});
