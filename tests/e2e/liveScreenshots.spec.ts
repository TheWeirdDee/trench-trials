import { TEST_LIVE_ELIGIBILITY } from '../testEligibility';
import { expect, expectUnmaskStage, selectSlot, test } from './helpers';
import { createLiveRound } from '../../src/lib/repo/live';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

// These screens use a test fixture Live round, so they are test output — never product evidence.
const artifactsDir = join(process.cwd(), 'test-results', 'fixture-screens');

if (!existsSync(artifactsDir)) {
  mkdirSync(artifactsDir, { recursive: true });
}

test.describe.serial('Live Screenshots Capture (Section 30)', () => {
  test('captures live-invalid.png from round df397565-caab-4208-8737-9b1d208177d7', async ({ page }) => {
    await page.goto('/round/df397565-caab-4208-8737-9b1d208177d7');
    await expect(page.getByTestId('live-pending-title')).toHaveText('Live Trial Paused');
    await expect(
      page.getByText('This round was invalidated because its committed outcome window could not be verified.'),
    ).toBeVisible();
    await page.screenshot({ path: join(artifactsDir, 'live-invalid.png'), fullPage: true });
  });

  test('captures live-entry-open, live-blind, live-unmasked, live-final-locked, live-measuring, live-measuring-hard-reload, live-mobile-measuring', async ({ page, owned }) => {
    const live = await createLiveRound({
      eligibility: TEST_LIVE_ELIGIBILITY,
      chain: 'solana',
      assets: [
        {
          slot: 'A',
          tokenSymbol: 'ANTFUN',
          tokenAddress: 'CWZ6BsdnjkDVTGkmL6bGbJXXig6ceef12KvyGQW14cMt',
          chain: 'solana',
          sectors: ['Decentralised Exchanges', 'Scaling & Connectivity', 'GameFi'],
          clueInputs: { buy_volume_1d: 7619936, sell_volume_1d: 7742940, volume_1d: 15362876, volume_7d: 58796698, netflow_1d: -123004, liquidity: 31118128, price_change_7d: -0.04 },
          clues: {
            buy_sell_balance: { value: -0.008, bucket: 'balanced' },
            trading_acceleration: { value: 1.829, bucket: 'accelerating' },
            netflow_over_liquidity: { value: -0.004, bucket: 'balanced' },
            recent_momentum: { value: -0.04, bucket: 'flat' },
          },
        },
        {
          slot: 'B',
          tokenSymbol: 'PUMP',
          tokenAddress: 'pumpCmXqMfrsAkQ5r49WcJnRayYRqmXz6ae8H7H9Dfn',
          chain: 'solana',
          sectors: ['Memecoins'],
          clueInputs: { buy_volume_1d: 57254906, sell_volume_1d: 56071868, volume_1d: 113326774, volume_7d: 263963851, netflow_1d: 1183037, liquidity: 14136135, price_change_7d: 0.21 },
          clues: {
            buy_sell_balance: { value: 0.01, bucket: 'balanced' },
            trading_acceleration: { value: 3.005, bucket: 'accelerating' },
            netflow_over_liquidity: { value: 0.084, bucket: 'inward' },
            recent_momentum: { value: 0.21, bucket: 'rising' },
          },
        },
        {
          slot: 'C',
          tokenSymbol: 'CBBTC',
          tokenAddress: 'cbbtcf3aa214zXHbiAZQwf4122FBYbraNdFqgw4iMij',
          chain: 'solana',
          sectors: ['DeFi Lending', 'Scaling & Connectivity'],
          clueInputs: { buy_volume_1d: 97110964, sell_volume_1d: 89082964, volume_1d: 186193929, volume_7d: 403345439, netflow_1d: 8027999, liquidity: 11378743, price_change_7d: 0.13 },
          clues: {
            buy_sell_balance: { value: 0.043, bucket: 'balanced' },
            trading_acceleration: { value: 3.231, bucket: 'accelerating' },
            netflow_over_liquidity: { value: 0.706, bucket: 'inward' },
            recent_momentum: { value: 0.13, bucket: 'rising' },
          },
        },
      ],
      snapshotPublishedAt: new Date(),
    });
    const testRoundId = owned.ownRound(live.roundId);

    // 1. live-entry-open.png & live-blind.png on /round/[id]
    await page.goto(`/round/${testRoundId}`);
    await expect(page.getByTestId('live-schedule-header')).toBeVisible();
    await expect(page.getByText('Lock your prediction before entry closes.')).toBeVisible();
    await page.screenshot({ path: join(artifactsDir, 'live-entry-open.png'), fullPage: true });
    await page.screenshot({ path: join(artifactsDir, 'live-blind.png'), fullPage: true });

    // 3. live-unmasked.png after locking blind
    await selectSlot(page, 'B');
    await page.getByTestId('lock-blind-button').click();
    await expectUnmaskStage(page);
    await expect(page.getByText('PUMP')).toBeVisible();
    await page.screenshot({ path: join(artifactsDir, 'live-unmasked.png'), fullPage: true });

    // 4. live-final-locked.png and live-measuring.png after locking final
    await selectSlot(page, 'A');
    await expect(page.getByTestId('lock-final-button')).toContainText('Switch to Slot A');
    await page.getByTestId('lock-final-button').click();
    await expect(page.getByTestId('live-pending-banner')).toBeVisible();
    await expect(page.getByTestId('live-pending-title')).toBeVisible();
    await page.screenshot({ path: join(artifactsDir, 'live-final-locked.png'), fullPage: true });
    await page.screenshot({ path: join(artifactsDir, 'live-measuring.png'), fullPage: true });

    // 5. live-measuring-hard-reload.png
    await page.reload();
    await expect(page.getByTestId('live-pending-banner')).toBeVisible();
    await page.screenshot({ path: join(artifactsDir, 'live-measuring-hard-reload.png'), fullPage: true });

    // 6. live-mobile-measuring.png on 390x844 viewport
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/round/${testRoundId}`);
    await expect(page.getByTestId('live-pending-banner')).toBeVisible();
    await page.screenshot({ path: join(artifactsDir, 'live-mobile-measuring.png'), fullPage: true });
  });
});
