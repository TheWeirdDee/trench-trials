import { TEST_LIVE_ELIGIBILITY } from '../testEligibility';
import { expect, expectUnmaskStage, selectSlot, test } from './helpers';
import path from 'node:path';
import fs from 'node:fs';
import { createLiveRound } from '../../src/lib/repo/live';

// These screens use a test fixture Live round, so they are test output — never product evidence.
const ARTIFACTS_DIR = path.resolve(process.cwd(), 'test-results', 'fixture-screens', 'walkthrough');

if (!fs.existsSync(ARTIFACTS_DIR)) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

test.describe('Manual Real-Chromium Walkthrough (Section 63)', () => {

  test('captures complete 01-09 walkthrough screenshots', async ({ owned }) => {
    // Each context gets its own test-owned identity from `owned`; the fixture closes the
    // contexts (after their requests have ended) and removes their players and the round.

    // 01-live-empty.png
    const emptyContext = await owned.newContext({ viewport: { width: 1280, height: 800 } });
    const emptyPage = await emptyContext.newPage();
    await emptyPage.route('**/api/live', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ available: false, message: 'No active Live round' }),
      }),
    );
    await emptyPage.goto('/live');
    await expect(emptyPage.getByTestId('live-empty-state')).toBeVisible();
    await emptyPage.screenshot({ path: path.join(ARTIFACTS_DIR, '01-live-empty.png'), fullPage: true });

    // Create fresh open Live round fixture for walkthrough
    const live = await createLiveRound({
      eligibility: TEST_LIVE_ELIGIBILITY,
      chain: 'solana',
      snapshotPublishedAt: new Date(),
      assets: [
        {
          slot: 'A',
          tokenSymbol: 'ANTFUN',
          tokenAddress: '0x1',
          chain: 'solana',
          sectors: ['Meme'],
          clueInputs: { buy_volume_1d: 100, sell_volume_1d: 80, volume_1d: 180, volume_7d: 1000, netflow_1d: 20, liquidity: 500, price_change_7d: 0.1 },
          clues: {
            buy_sell_balance: { value: 0.11, bucket: 'buy-heavy' },
            trading_acceleration: { value: 1.26, bucket: 'accelerating' },
            netflow_over_liquidity: { value: 0.04, bucket: 'balanced' },
            recent_momentum: { value: 0.1, bucket: 'rising' },
          },
        },
        {
          slot: 'B',
          tokenSymbol: 'PUMP',
          tokenAddress: '0x2',
          chain: 'solana',
          sectors: ['DeFi'],
          clueInputs: { buy_volume_1d: 200, sell_volume_1d: 220, volume_1d: 420, volume_7d: 2800, netflow_1d: -10, liquidity: 2000, price_change_7d: -0.02 },
          clues: {
            buy_sell_balance: { value: -0.04, bucket: 'balanced' },
            trading_acceleration: { value: 1.05, bucket: 'steady' },
            netflow_over_liquidity: { value: -0.005, bucket: 'balanced' },
            recent_momentum: { value: -0.02, bucket: 'flat' },
          },
        },
        {
          slot: 'C',
          tokenSymbol: 'CBBTC',
          tokenAddress: '0x3',
          chain: 'solana',
          sectors: ['DeFi'],
          clueInputs: { buy_volume_1d: 150, sell_volume_1d: 100, volume_1d: 250, volume_7d: 1400, netflow_1d: 30, liquidity: 1200, price_change_7d: 0.08 },
          clues: {
            buy_sell_balance: { value: 0.2, bucket: 'buy-heavy' },
            trading_acceleration: { value: 1.25, bucket: 'steady' },
            netflow_over_liquidity: { value: 0.025, bucket: 'balanced' },
            recent_momentum: { value: 0.08, bucket: 'rising' },
          },
        },
      ],
    });
    const liveRoundId = owned.ownRound(live.roundId);

    // Context for live round walkthrough
    const context = await owned.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();

    // 02-live-open.png & 03-live-blind.png
    await page.goto(`/round/${liveRoundId}`);
    await expect(page.getByTestId('live-schedule-header')).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '02-live-open.png'), fullPage: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '03-live-blind.png'), fullPage: true });

    // Pick Slot A blind
    await selectSlot(page, 'A');
    await page.getByTestId('lock-blind-button').click();

    // 04-live-blind-locked.png & 05-live-unmasked.png
    await expectUnmaskStage(page);
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '04-live-blind-locked.png'), fullPage: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '05-live-unmasked.png'), fullPage: true });

    // Pick Final Slot B (switch)
    await selectSlot(page, 'B');
    await expect(page.getByTestId('lock-final-button')).toContainText('Switch to Slot B');
    await page.getByTestId('lock-final-button').click();

    // 06-live-final-locked.png & 07-live-pending.png
    await expect(page.getByTestId('live-pending-banner')).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '06-live-final-locked.png'), fullPage: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '07-live-pending.png'), fullPage: true });

    // 08-live-pending-reload.png
    await page.reload();
    await expect(page.getByTestId('live-pending-banner')).toBeVisible();
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, '08-live-pending-reload.png'), fullPage: true });

    // 09-live-mobile.png (Pixel 7 viewport 390x844)
    const mobileContext = await owned.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await mobileContext.newPage();
    await mobilePage.goto(`/round/${liveRoundId}`);
    await expect(mobilePage.getByTestId('live-schedule-header')).toBeVisible();
    await mobilePage.screenshot({ path: path.join(ARTIFACTS_DIR, '09-live-mobile.png'), fullPage: true });
  });
});
