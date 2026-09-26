import { expect, getFreshRoundId, selectSlot, test } from './helpers';

test.describe('Recognition UI — post-verdict optional self-report', () => {
  test('submitting recognized slots records response, persists on reload, and does not alter verdict', async ({
    page,
  }) => {
    const roundId = await getFreshRoundId(page.request);
    await page.goto(`/round/${roundId}`);

    // Progress to verdict
    await selectSlot(page, 'A');
    await page.getByTestId('lock-blind-button').click();
    await page.getByTestId('lock-final-button').click();
    await expect(page.getByTestId('verdict-headline')).toBeVisible();

    const verdictHeadline = await page.getByTestId('verdict-headline').textContent();

    // Recognition prompt is visible
    const prompt = page.getByTestId('recognition-prompt');
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText('Did you recognize any of these tokens before this round?');

    // Select Slot A and Submit
    await page.getByTestId('recognition-slot-A').click();
    await expect(page.getByTestId('recognition-slot-A')).toHaveAttribute('aria-pressed', 'true');
    await page.getByTestId('recognition-submit').click();

    // Result recorded
    await expect(page.getByTestId('recognition-recorded')).toBeVisible();
    await expect(page.getByTestId('recognition-recorded')).toContainText('Recognized: A');

    // Reload persists the state and does not re-prompt or alter the verdict
    await page.reload();
    await expect(page.getByTestId('verdict-headline')).toHaveText(verdictHeadline!);
    await expect(page.getByTestId('recognition-recorded')).toBeVisible();
    await expect(page.getByTestId('recognition-recorded')).toContainText('Recognized: A');
    await expect(page.getByTestId('recognition-prompt')).not.toBeVisible();
  });

  test('skipping recognition records skipped state cleanly', async ({ page }) => {
    const roundId = await getFreshRoundId(page.request);
    await page.goto(`/round/${roundId}`);

    await selectSlot(page, 'B');
    await page.getByTestId('lock-blind-button').click();
    await page.getByTestId('lock-final-button').click();
    await expect(page.getByTestId('verdict-headline')).toBeVisible();

    // Click Skip
    await page.getByTestId('recognition-skip').click();

    await expect(page.getByTestId('recognition-recorded')).toBeVisible();
    await expect(page.getByTestId('recognition-recorded')).toContainText('Skipped');

    await page.reload();
    await expect(page.getByTestId('recognition-recorded')).toContainText('Skipped');
  });
});
