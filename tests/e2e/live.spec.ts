import { TEST_LIVE_ELIGIBILITY } from '../testEligibility';
import { expect, expectUnmaskStage, selectSlot, test } from './helpers';
import { createLiveRound, resolveLiveRound } from '../../src/lib/repo/live';
import { assertNoIdentityLeak, assertNoOutcomeLeak } from '../../src/lib/allowlist';

test.describe.serial('Live Trial E2E — Real Browser Flow (Section 48)', () => {
  const makeTestAssets = () => [
    {
      slot: 'A' as const,
      tokenSymbol: 'PEPE',
      tokenAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
      chain: 'ethereum',
      sectors: ['Meme'],
      clueInputs: { buy_volume_1d: 100, sell_volume_1d: 80, volume_1d: 180, volume_7d: 1000, netflow_1d: 20, liquidity: 500, price_change_7d: 0.1 },
      clues: {
        buy_sell_balance: { value: 0.111, bucket: 'buy-heavy' },
        trading_acceleration: { value: 1.26, bucket: 'accelerating' },
        netflow_over_liquidity: { value: 0.04, bucket: 'balanced' },
        recent_momentum: { value: 0.1, bucket: 'rising' },
      },
    },
    {
      slot: 'B' as const,
      tokenSymbol: 'UNI',
      tokenAddress: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
      chain: 'ethereum',
      sectors: ['DeFi'],
      clueInputs: { buy_volume_1d: 200, sell_volume_1d: 220, volume_1d: 420, volume_7d: 2800, netflow_1d: -10, liquidity: 2000, price_change_7d: -0.02 },
      clues: {
        buy_sell_balance: { value: -0.047, bucket: 'balanced' },
        trading_acceleration: { value: 1.05, bucket: 'steady' },
        netflow_over_liquidity: { value: -0.005, bucket: 'balanced' },
        recent_momentum: { value: -0.02, bucket: 'flat' },
      },
    },
    {
      slot: 'C' as const,
      tokenSymbol: 'LINK',
      tokenAddress: '0x514910771af9ca656af840dff83e8264ecf986ca',
      chain: 'ethereum',
      sectors: ['Oracle'],
      clueInputs: { buy_volume_1d: 150, sell_volume_1d: 100, volume_1d: 250, volume_7d: 1400, netflow_1d: 30, liquidity: 1200, price_change_7d: 0.08 },
      clues: {
        buy_sell_balance: { value: 0.2, bucket: 'buy-heavy' },
        trading_acceleration: { value: 1.25, bucket: 'steady' },
        netflow_over_liquidity: { value: 0.025, bucket: 'balanced' },
        recent_momentum: { value: 0.08, bucket: 'rising' },
      },
    },
  ];

  test('LIVE TEST A — no active round displays honest empty state', async ({ page }) => {
    // Intercept /api/live to test the honest empty state independently of DB state
    await page.route('**/api/live', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ available: false, message: 'No active Live round' }),
      }),
    );
    await page.goto('/live');
    const emptyState = page.getByTestId('live-empty-state');
    await expect(emptyState).toBeVisible();
    await expect(page.getByText('No Live Trial is open right now.')).toBeVisible();
    await expect(page.getByText('24-Hour Horizon', { exact: true })).toBeVisible();
  });

  test('LIVE TEST B, C, D, E — open round full flow, blind leakage audit, reload persistence, and resolved verdict', async ({ page, owned }) => {
    // Create open test live round in DB; deleted by the fixture once the page has stopped.
    const live = await createLiveRound({
      eligibility: TEST_LIVE_ELIGIBILITY,
      chain: 'ethereum',
      assets: makeTestAssets(),
      snapshotPublishedAt: new Date(),
    });
    const testRoundId = owned.ownRound(live.roundId);

    // Capture GET /api/rounds/:id to verify wire payload
    let apiPayloadText = '';
    page.on('response', async (res) => {
      if (res.url().includes(`/api/rounds/${testRoundId}`) && res.request().method() === 'GET') {
        try {
          apiPayloadText = await res.text();
        } catch {
          // ignore
        }
      }
    });

    await page.goto(`/round/${testRoundId}`);

    // LIVE TEST E — Blind leakage audit: DOM and API response
    await expect(page.getByText(/Blind pick/i)).toBeVisible();
    await expect(page.getByTestId('live-schedule-header')).toBeVisible();

    // Verify symbols are NOT visible in the DOM
    await expect(page.getByText('PEPE')).not.toBeVisible();
    await expect(page.getByText('UNI')).not.toBeVisible();
    await expect(page.getByText('LINK')).not.toBeVisible();

    // Verify raw wire JSON payload contains no leaked identities or outcome keys
    expect(apiPayloadText).toBeTruthy();
    assertNoIdentityLeak(apiPayloadText);
    assertNoOutcomeLeak(apiPayloadText);

    // LIVE TEST B — Player makes blind pick (Slot B)
    await selectSlot(page, 'B');
    await page.getByTestId('lock-blind-button').click();

    // Unmask stage
    await expectUnmaskStage(page);
    await expect(page.getByText('PEPE')).toBeVisible();
    await expect(page.getByText('UNI')).toBeVisible();
    await expect(page.getByText('LINK')).toBeVisible();

    // Pick final choice (Switch to Slot A)
    await selectSlot(page, 'A');
    await expect(page.getByTestId('lock-final-button')).toContainText('Switch to Slot A');
    await page.getByTestId('lock-final-button').click();

    // Pending stage
    const pendingBanner = page.getByTestId('live-pending-banner');
    await expect(pendingBanner).toBeVisible();
    await expect(page.getByTestId('live-pending-title')).toBeVisible();
    await expect(page.getByTestId('live-pending-body')).toBeVisible();
    await expect(page.getByText(/Your locked prediction: Slot A/i)).toBeVisible();

    // Confirm NO outcome, NO returns, NO points awarded while pending
    await expect(page.getByTestId('verdict-banner')).not.toBeVisible();
    await expect(page.getByText(/points/i)).not.toBeVisible();

    // LIVE TEST C — Hard reload pending
    await page.reload();
    await expect(page.getByTestId('live-pending-banner')).toBeVisible();
    await expect(page.getByTestId('live-pending-title')).toBeVisible();
    await expect(page.getByText(/Your locked prediction: Slot A/i)).toBeVisible();
    await expect(page.getByTestId('verdict-banner')).not.toBeVisible();

    // LIVE TEST D — Now resolve the test round fixture and reload
    const resolvedAssets = [
      {
        slot: 'A' as const,
        tokenSymbol: 'PEPE',
        tokenAddress: '0x6982508145454ce325ddbe47a25d4ec3d2311933',
        entryCandleStart: live.schedule.measurementStartAt.toISOString(),
        entryPrice: 0.00001,
        exitCandleStart: live.schedule.measurementEndAt.toISOString(),
        exitPrice: 0.000015, // +50% (Winner!)
        returnRatio: 0.5,
        sourceResponseSha256: { ohlcv: 'hash1' },
      },
      {
        slot: 'B' as const,
        tokenSymbol: 'UNI',
        tokenAddress: '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984',
        entryCandleStart: live.schedule.measurementStartAt.toISOString(),
        entryPrice: 10,
        exitCandleStart: live.schedule.measurementEndAt.toISOString(),
        exitPrice: 9.5, // -5%
        returnRatio: -0.05,
        sourceResponseSha256: { ohlcv: 'hash2' },
      },
      {
        slot: 'C' as const,
        tokenSymbol: 'LINK',
        tokenAddress: '0x514910771af9ca656af840dff83e8264ecf986ca',
        entryCandleStart: live.schedule.measurementStartAt.toISOString(),
        entryPrice: 20,
        exitCandleStart: live.schedule.measurementEndAt.toISOString(),
        exitPrice: 22, // +10%
        returnRatio: 0.1,
        sourceResponseSha256: { ohlcv: 'hash3' },
      },
    ];

    const resolveTime = new Date(Date.now() + 25 * 3600 * 1000);
    await resolveLiveRound(testRoundId, {
      customExitPrices: resolvedAssets,
      now: resolveTime,
    });

    // Reload page as the player who switched from B to A (the winner)
    await page.reload();

    // Verdict is now visible with authoritative server result
    const verdictBanner = page.getByTestId('verdict-banner');
    await expect(verdictBanner).toBeVisible();
    await expect(page.getByText('Live round resolved')).toBeVisible();
    await expect(page.getByTestId('verdict-headline')).toContainText('You switched from Slot B to Slot A');
    await expect(verdictBanner).toContainText('Winning pick · +100 points');
  });

  test('LIVE TEST F — mobile viewport flow (Pixel 7 / 390x844)', async ({ page, owned }) => {
    // Dedicated mobile round fixture; deleted by the fixture once the page has stopped.
    const mobileRound = await createLiveRound({
      eligibility: TEST_LIVE_ELIGIBILITY,
      chain: 'ethereum',
      assets: makeTestAssets(),
      snapshotPublishedAt: new Date(),
    });
    owned.ownRound(mobileRound.roundId);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/round/${mobileRound.roundId}`);

    // Check no horizontal scrollbar / overflow on blind screen
    let scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    let clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);

    // Lock blind on mobile
    await selectSlot(page, 'A');
    await page.getByTestId('lock-blind-button').click();

    // Check unmask screen on mobile
    await expectUnmaskStage(page);
    scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);

    // Lock final on mobile
    await page.getByTestId('lock-final-button').click();

    // Check pending screen on mobile
    await expect(page.getByTestId('live-pending-banner')).toBeVisible();
    scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth).toBeLessThanOrEqual(clientWidth + 2);
  });
});
