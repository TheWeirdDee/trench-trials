import { expect, test } from './helpers';

test.describe('Navigation and route truthfulness', () => {
  test('landing navigation links to real sections and pages, and promises no Daily or Live', async ({ page }) => {
    await page.goto('/');
    const header = page.getByTestId('site-header');
    for (const name of ['How it works', 'Why Nansen', 'FAQ', 'Docs']) {
      await expect(header.getByRole('link', { name, exact: true }).first()).toBeAttached();
    }
    await expect(page.getByTestId('nav-daily')).not.toBeAttached();
    await expect(page.getByTestId('nav-live')).not.toBeAttached();

    await page.getByTestId('nav-play').first().click();
    await expect(page).toHaveURL(/\/(play|round\/)/);
  });

  test('app navigation shows Play, History and Docs, and hides Daily and Live while neither is genuinely available', async ({
    page,
  }) => {
    await page.goto('/history');
    const nav = page.getByTestId('main-navigation');
    await expect(nav).toBeVisible();
    await expect(page.getByTestId('nav-play')).toHaveText('Play');
    await expect(page.getByTestId('nav-history')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('nav-docs')).toBeVisible();
    // No Daily is assigned and the latest Live round is invalid.
    await expect(page.getByTestId('nav-daily')).not.toBeAttached();
    await expect(page.getByTestId('nav-live')).not.toBeAttached();

    // The routes stay honest when opened directly.
    await page.goto('/live');
    await expect(page.getByTestId('live-empty-state')).toBeVisible();
    await page.goto('/daily');
    await expect(page.getByTestId('daily-unavailable')).toBeVisible();

    await page.getByTestId('nav-docs').click();
    await expect(page).toHaveURL(/\/docs$/);
    await page.goto('/history');
    await page.getByTestId('nav-play').click();
    await expect(page).toHaveURL(/\/(play|round\/)/);
  });

  test('legacy and shortcut routes redirect', async ({ page }) => {
    await page.goto('/replay');
    await expect(page).toHaveURL(/\/(play|round\/)/);
    await page.goto('/how-it-works');
    await expect(page).toHaveURL(/\/docs#how-it-works$/);
  });

  test('docs cover every required topic, including scoring, provenance, privacy and the FAQ', async ({ page }) => {
    await page.goto('/docs');
    for (const id of [
      'what-it-is',
      'problem',
      'how-it-works',
      'scoring',
      'ticker-tax',
      'replay',
      'daily',
      'live',
      'history',
      'privacy',
      'nansen',
      'provenance',
      'leakage',
      'invalid',
      'commitments',
      'faq',
      'disclaimer',
    ]) {
      await expect(page.locator(`section#${id} h2`)).toBeVisible();
    }
    await expect(page.getByRole('link', { name: 'Read the FAQ' })).toHaveAttribute('href', '#faq');
    await expect(page.locator('section#faq').getByTestId('faq').locator('details')).toHaveCount(8);
  });

  test('the landing FAQ is an accessible accordion with the eight questions', async ({ page }) => {
    await page.goto('/');
    const faq = page.getByTestId('faq');
    await expect(faq.locator('details')).toHaveCount(8);
    const first = faq.locator('details').first();
    await first.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(first).toHaveAttribute('open', '');
  });
});
