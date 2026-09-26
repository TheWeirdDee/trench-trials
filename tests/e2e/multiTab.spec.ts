import { expect, getFreshRoundId, selectSlot, test } from './helpers';

test.describe('Replay — two literal browser tabs, same anonymous session', () => {
  test('a stale second tab cannot override the first tab’s locked choices, and both reconcile to one server verdict', async ({
    page,
    context,
    owned,
  }) => {
    // The stale tab's blind and final locks are rejected with 409 on purpose; the browser logs each.
    owned.allowConsoleError(/Failed to load resource: the server responded with a status of 409 \(Conflict\)/);
    const roundId = await getFreshRoundId(page.request);
    const page2 = await context.newPage(); // same context = same cookies = same session

    await page.goto(`/round/${roundId}`);
    await page2.goto(`/round/${roundId}`);
    await expect(page.getByTestId('slot-card-A')).toBeVisible();
    await expect(page2.getByTestId('slot-card-A')).toBeVisible();

    // Tab 1 locks the blind choice: A.
    await selectSlot(page, 'A');
    await page.getByTestId('lock-blind-button').click();
    await expect(page.getByText('Now you know the names.')).toBeVisible();

    // Tab 2 is stale — still showing the blind-stage view it loaded with — and picks
    // a DIFFERENT slot, then tries to lock it, unaware tab 1 already committed.
    await selectSlot(page2, 'B');
    await page2.getByTestId('lock-blind-button').click();

    // The server rejects tab 2's attempt; the client reconciles by refetching the
    // real state, so tab 2 now shows the SAME accepted blind slot as tab 1 (A, not B).
    await expect(page2.getByText('Now you know the names.')).toBeVisible();
    await expect(page2.getByTestId('slot-card-A')).toContainText('Your blind pick');
    await expect(page2.getByTestId('slot-card-B')).not.toContainText('Your blind pick');

    // Both tabs now agree on the blind slot.
    await expect(page.getByTestId('slot-card-A')).toContainText('Your blind pick');

    // Tab 1 locks the final choice: stick with A.
    await page.getByTestId('lock-final-button').click();
    await expect(page.getByTestId('verdict-headline')).toBeVisible();
    const verdictOnTab1 = await page.getByTestId('verdict-headline').textContent();

    // Tab 2, still on the Unmask view, picks a different slot (C) and tries to switch.
    await expect(page2.getByText('Now you know the names.')).toBeVisible();
    await selectSlot(page2, 'C');
    await expect(page2.getByTestId('lock-final-button')).toContainText('Switch to Slot C');
    await page2.getByTestId('lock-final-button').click();

    // Stale tab 2's switch attempt is rejected; it reconciles to the real, already
    // final_locked outcome (an explicit stick on A) — never shows C as the answer.
    await expect(page2.getByTestId('verdict-headline')).toContainText('You kept your blind choice');
    expect(await page2.getByTestId('verdict-headline').textContent()).toBe(verdictOnTab1);

    // A hard reload in either tab reproduces the identical, single authoritative verdict.
    await page.reload();
    await expect(page.getByTestId('verdict-headline')).toHaveText(verdictOnTab1!);
    await page2.reload();
    await expect(page2.getByTestId('verdict-headline')).toHaveText(verdictOnTab1!);

    await page2.close();
  });
});
