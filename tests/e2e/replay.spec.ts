import {
  assertNoneInContent,
  expect,
  expectUnmaskStage,
  FORBIDDEN_BEFORE_UNMASK,
  FORBIDDEN_BEFORE_VERDICT,
  getFreshRoundId,
  selectSlot,
  test,
} from './helpers';

// Every request below goes through page.request (not the standalone `request` fixture)
// so API calls and page navigation share the same cookie-authenticated session —
// exactly what a real browser does.

test.describe('Replay — blind stage', () => {
  test('shows no identity, price or return data anywhere on the page', async ({ page }) => {
    const roundId = await getFreshRoundId(page.request);

    // Raw server-rendered HTML (before any client fetch resolves) must also be clean.
    const raw = await page.request.get(`/round/${roundId}`);
    const rawHtml = await raw.text();
    for (const term of [...FORBIDDEN_BEFORE_UNMASK, ...FORBIDDEN_BEFORE_VERDICT]) {
      expect(rawHtml, `raw SSR HTML should not contain "${term}"`).not.toContain(term);
    }

    await page.goto(`/round/${roundId}`);
    await expect(page.getByTestId('slot-card-A')).toBeVisible();
    await assertNoneInContent(page, [...FORBIDDEN_BEFORE_UNMASK, ...FORBIDDEN_BEFORE_VERDICT]);

    for (const slot of ['A', 'B', 'C']) {
      const card = page.getByTestId(`slot-card-${slot}`);
      await expect(card).toContainText(`Slot ${slot}`);
      await expect(card).not.toContainText('YZY');
      await expect(card).not.toContainText('POPCAT');
      await expect(card).not.toContainText('BOME');
    }
  });

  test('the actual GET /api/rounds/:id JSON payload — not just rendered text — carries no forbidden fields', async ({
    page,
  }) => {
    // The rendered-text check above can't catch a field that exists in the payload
    // but happens not to be rendered anywhere. This checks the wire response itself.
    const roundId = await getFreshRoundId(page.request);
    const res = await page.request.get(`/api/rounds/${roundId}`);
    expect(res.status()).toBe(200);
    const json = await res.json();
    const raw = JSON.stringify(json);

    expect(json.attempt.stage).toBe('blind');
    expect(Object.keys(json)).toEqual(['serverNow', 'round', 'attempt', 'assets']); // no stray top-level fields
    expect(json.attempt.id).toBeNull(); // viewing a round creates no attempt
    for (const asset of json.assets) {
      expect(Object.keys(asset).sort()).toEqual(['clues', 'slot']);
    }
    for (const term of [...FORBIDDEN_BEFORE_UNMASK, ...FORBIDDEN_BEFORE_VERDICT]) {
      expect(raw, `API JSON payload should not contain "${term}"`).not.toContain(term);
    }
    expect(raw).not.toMatch(/exactCutoff|resolutionTime/); // exact cutoff is verdict-only
  });
});

test.describe('Replay — Unmask stage', () => {
  test('reveals identities but still no prices/returns, and states the future is hidden', async ({ page }) => {
    const roundId = await getFreshRoundId(page.request);
    await page.goto(`/round/${roundId}`);

    await selectSlot(page, 'B');
    await page.getByTestId('lock-blind-button').click();

    await expect(page.getByText('Now you know the names.')).toBeVisible();
    await expect(page.getByText('The future outcome is still hidden.')).toBeVisible();

    const slotB = page.getByTestId('slot-card-B');
    await expect(slotB).toContainText('YZY');
    await expect(slotB).toContainText('Your blind pick');

    await assertNoneInContent(page, FORBIDDEN_BEFORE_VERDICT);
    await expect(page.getByTestId('countdown-timer')).toBeVisible();
  });
});

test.describe('Replay — stick path', () => {
  test('stick shows exactly 0.0pp impact and the real blind-slot return', async ({ page }) => {
    const roundId = await getFreshRoundId(page.request);
    await page.goto(`/round/${roundId}`);

    await selectSlot(page, 'A');
    await page.getByTestId('lock-blind-button').click();

    await expect(page.getByTestId('lock-final-button')).toContainText('Keep Slot A');
    await page.getByTestId('lock-final-button').click();

    await expect(page.getByTestId('verdict-headline')).toContainText('You kept your blind choice');
    await expect(page.getByTestId('verdict-detail')).toContainText('Switch impact: 0.0 pp');
    await expect(page.getByTestId('slot-return-A')).toBeVisible();
    await expect(page.getByTestId('slot-return-B')).toBeVisible();
    await expect(page.getByTestId('slot-return-C')).toBeVisible();
  });
});

test.describe('Replay — switch path', () => {
  test('switch from B to A matches the real +36.1pp switch impact from round-001', async ({ page }) => {
    const roundId = await getFreshRoundId(page.request);
    await page.goto(`/round/${roundId}`);

    await selectSlot(page, 'B');
    await page.getByTestId('lock-blind-button').click();

    await expectUnmaskStage(page);
    await selectSlot(page, 'A');
    await expect(page.getByTestId('lock-final-button')).toContainText('Switch to Slot A');
    await page.getByTestId('lock-final-button').click();

    await expect(page.getByTestId('verdict-headline')).toContainText('switched from Slot B to Slot A');
    const detail = await page.getByTestId('verdict-detail').textContent();
    expect(detail).toMatch(/helped/);
    expect(detail).toMatch(/\+36\.1 percentage points/);

    await expect(page.getByTestId('slot-return-A')).toContainText('38.18');
    await expect(page.getByTestId('slot-return-B')).toContainText('2.07');
  });
});

test.describe('Replay — timeout path', () => {
  test('retains the blind choice and never calls it an explicit stick', async ({ page }) => {
    test.setTimeout(45_000);
    const roundId = await getFreshRoundId(page.request);
    await page.goto(`/round/${roundId}`);

    await selectSlot(page, 'C');
    await page.getByTestId('lock-blind-button').click();
    await expect(page.getByTestId('countdown-timer')).toBeVisible();

    // Real round-001 uses a 15s decision window; wait it out for a genuine timeout.
    await expect(page.getByTestId('verdict-headline')).toContainText('Time ran out', { timeout: 30_000 });
    await expect(page.getByTestId('verdict-headline')).toContainText('blind choice was retained');
    await expect(page.getByTestId('verdict-headline')).not.toContainText('kept your blind choice');
  });
});

test.describe('Replay — refresh persistence', () => {
  test('refreshing during Unmask does not reset the countdown or the locked blind slot', async ({ page }) => {
    const roundId = await getFreshRoundId(page.request);
    await page.goto(`/round/${roundId}`);

    await selectSlot(page, 'A');
    await page.getByTestId('lock-blind-button').click();
    await expect(page.getByTestId('countdown-timer')).toBeVisible();

    const before = await page.getByTestId('countdown-timer').textContent();
    const beforeSeconds = Number(before?.match(/(\d+)s/)?.[1]);

    await page.waitForTimeout(2000);
    await page.reload();

    await expect(page.getByTestId('slot-card-A')).toContainText('Your blind pick');
    const after = await page.getByTestId('countdown-timer').textContent();
    const afterSeconds = Number(after?.match(/(\d+)s/)?.[1]);

    expect(afterSeconds).toBeLessThan(beforeSeconds);
    expect(afterSeconds).toBeGreaterThanOrEqual(0);
  });
});

test.describe('Replay — double submission', () => {
  test('rapidly clicking Lock blind pick twice only ever locks one slot, never two decisions', async ({ page }) => {
    const roundId = await getFreshRoundId(page.request);
    await page.goto(`/round/${roundId}`);

    await selectSlot(page, 'A');
    const lockButton = page.getByTestId('lock-blind-button');
    // dispatchEvent (not .click()) fires the raw event without Playwright's own
    // actionability retry loop — using two real .click() calls here instead makes
    // the *second* call spin retrying "element is not enabled" against the button
    // that the *first* click's own state update legitimately disables, which fights
    // Playwright's engine rather than the app and hangs until the test timeout. This
    // dispatches both click events back-to-back, which is what a genuine double-tap
    // before React re-renders actually looks like at the DOM level.
    await Promise.all([lockButton.dispatchEvent('click'), lockButton.dispatchEvent('click')]);

    await expect(page.getByText('Now you know the names.')).toBeVisible();
    await expect(page.getByTestId('slot-card-A')).toContainText('Your blind pick');

    // The server only ever recorded one blind_lock — confirmed by re-fetching: a
    // second, different blind slot must still be rejected as already-locked.
    const relock = await page.request.post(`/api/rounds/${roundId}/blind`, { data: { slot: 'B' } });
    expect(relock.status()).toBe(409);
  });

  test('rapidly clicking the final-lock button twice does not flip between stick and switch', async ({ page }) => {
    const roundId = await getFreshRoundId(page.request);
    await page.goto(`/round/${roundId}`);

    await selectSlot(page, 'B');
    await page.getByTestId('lock-blind-button').click();
    await expect(page.getByTestId('countdown-timer')).toBeVisible();

    const finalButton = page.getByTestId('lock-final-button');
    await Promise.all([finalButton.dispatchEvent('click'), finalButton.dispatchEvent('click')]);

    await expect(page.getByTestId('verdict-headline')).toBeVisible();
    // Reload independently confirms the server's single, authoritative outcome —
    // if the double click had created two decisions, this would be flaky/inconsistent.
    const before = await page.getByTestId('verdict-headline').textContent();
    await page.reload();
    const after = await page.getByTestId('verdict-headline').textContent();
    expect(after).toBe(before);
  });
});

test.describe('Replay — late/repeated choice rejection', () => {
  test('a repeated blind-lock API call after lock does not change what the UI shows on reload', async ({
    page,
  }) => {
    const roundId = await getFreshRoundId(page.request);
    await page.goto(`/round/${roundId}`);

    await selectSlot(page, 'A');
    await page.getByTestId('lock-blind-button').click();
    await page.getByTestId('lock-final-button').click(); // stick with A
    await expect(page.getByTestId('verdict-headline')).toBeVisible();

    // Same authenticated session attempts to relock a different blind slot directly via the API.
    const res = await page.request.post(`/api/rounds/${roundId}/blind`, {
      data: { slot: 'B' },
    });
    expect(res.status()).toBe(409);

    await page.reload();
    await expect(page.getByTestId('verdict-headline')).toContainText('You kept your blind choice');
    await expect(page.getByTestId('slot-card-A')).toContainText('Your pick');
  });
});

test.describe('Replay — keyboard operation', () => {
  test('a full blind lock can be completed using only the keyboard', async ({ page }) => {
    const roundId = await getFreshRoundId(page.request);
    await page.goto(`/round/${roundId}`);

    await page.getByTestId('slot-card-B').focus();
    await expect(page.getByTestId('slot-card-B')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('slot-card-B')).toHaveAttribute('aria-pressed', 'true');

    await page.getByTestId('lock-blind-button').focus();
    await page.keyboard.press('Enter');

    await expect(page.getByText('Now you know the names.')).toBeVisible();
  });
});

test.describe('Replay — hard reload after completion reproduces the identical verdict', () => {
  test('every verdict field (returns, switch impact, winner, points) survives a hard reload unchanged', async ({
    page,
  }) => {
    const roundId = await getFreshRoundId(page.request);
    await page.goto(`/round/${roundId}`);

    await selectSlot(page, 'B');
    await page.getByTestId('lock-blind-button').click();
    await expectUnmaskStage(page);
    await selectSlot(page, 'A');
    await expect(page.getByTestId('lock-final-button')).toContainText('Switch to Slot A');
    await page.getByTestId('lock-final-button').click();
    await expect(page.getByTestId('verdict-headline')).toBeVisible();

    const before = {
      headline: await page.getByTestId('verdict-headline').textContent(),
      detail: await page.getByTestId('verdict-detail').textContent(),
      returnA: await page.getByTestId('slot-return-A').textContent(),
      returnB: await page.getByTestId('slot-return-B').textContent(),
      returnC: await page.getByTestId('slot-return-C').textContent(),
    };

    await page.reload();
    await page.reload(); // twice, to rule out a one-shot fluke

    const after = {
      headline: await page.getByTestId('verdict-headline').textContent(),
      detail: await page.getByTestId('verdict-detail').textContent(),
      returnA: await page.getByTestId('slot-return-A').textContent(),
      returnB: await page.getByTestId('slot-return-B').textContent(),
      returnC: await page.getByTestId('slot-return-C').textContent(),
    };

    expect(after).toEqual(before);
  });
});

test.describe('Replay — submission network-failure resilience', () => {
  test('a dropped blind-lock request shows a retry message and preserves the selection instead of erasing it', async ({
    page,
    owned,
  }) => {
    // The aborted request below is the point of this test; the browser logs it.
    owned.allowConsoleError(/Failed to load resource: net::ERR_FAILED/);
    const roundId = await getFreshRoundId(page.request);
    await page.goto(`/round/${roundId}`);

    await selectSlot(page, 'A');

    // Simulate a genuine network failure on exactly the next blind-lock request.
    await page.route(`**/api/rounds/${roundId}/blind`, (route) => route.abort('failed'), { times: 1 });
    await page.getByTestId('lock-blind-button').click();

    await expect(page.getByTestId('submit-error')).toBeVisible();
    // The player's selection is still visibly intact, not silently discarded.
    await expect(page.getByTestId('slot-card-A')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('lock-blind-button')).toContainText('Lock A as my blind pick');
    await expect(page.getByTestId('lock-blind-button')).toBeEnabled();

    // Retrying (network restored, no more aborted route) succeeds normally.
    await page.getByTestId('lock-blind-button').click();
    await expect(page.getByText('Now you know the names.')).toBeVisible();
  });
});
