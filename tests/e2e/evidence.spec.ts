import { expect, test } from './helpers';

test.describe('Evidence page', () => {
  test('counts the rounds it lists and keeps tokens and cutoffs behind the spoiler control', async ({ page }) => {
    await page.goto('/evidence');
    const cards = page.getByTestId('evidence-round');
    await expect(cards.first()).toBeVisible();
    const n = await cards.count();
    await expect(page.getByTestId('evidence-round-count')).toContainText(n === 1 ? 'One round is approved' : `${n} rounds are approved`);

    for (let i = 0; i < n; i++) {
      const spoiler = cards.nth(i).locator('details');
      await expect(spoiler).toHaveCount(1);
      await expect(spoiler).not.toHaveAttribute('open', /.*/);
      await expect(spoiler.locator('dl')).toBeHidden();
      // Outside the disclosure a card carries IDs, hashes and checks only: no year-month-day cutoff.
      const visible = await cards.nth(i).evaluate((el) => {
        const clone = el.cloneNode(true) as HTMLElement;
        clone.querySelectorAll('details').forEach((d) => d.remove());
        clone.querySelectorAll('td.md\\:table-cell').forEach((d) => d.remove()); // retrieval times
        return clone.textContent ?? '';
      });
      expect(visible).not.toMatch(/Cutoff \(entry\)|Tokens/);
    }
  });

  test('the expected dashboard total is the earlier calls plus the successful logged requests, and is not claimed as confirmed', async ({
    page,
  }) => {
    await page.goto('/evidence');
    const usage = page.getByTestId('usage');
    const value = async (label: string) =>
      (await usage.locator('div', { has: page.locator('dt', { hasText: label }) }).locator('dd').first().textContent()) ?? '';

    const earlier = Number(await value('Calls before application logging'));
    const logged = (await value('Requests logged by the application')).match(/^(\d+) \((\d+) successful\)$/);
    expect(logged).not.toBeNull();
    const expected = await value('Expected dashboard total');
    expect(earlier).toBe(21);
    expect(expected).toBe(`${earlier + Number(logged![2])} — pending dashboard confirmation`);
    await expect(page.getByText(/dashboard[- ]confirmed/i)).toHaveCount(0);
  });
});
