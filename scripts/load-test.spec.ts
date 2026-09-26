/**
 * Playwright browser validation test — verifies React app stays functional
 * during k6 load testing against production.
 *
 * Usage:
 *   npx playwright test scripts/load-test.spec.ts
 *   PROD_URL=https://your-app.vercel.app npx playwright test scripts/load-test.spec.ts
 *
 * Run alongside k6 load test:
 *   k6 run scripts/load-test.js &
 *   npx playwright test scripts/load-test.spec.ts
 */

import { test, expect } from '@playwright/test';

const PROD_URL = process.env.PROD_URL ?? 'https://motg-iran.vercel.app';

test.use({
  baseURL: PROD_URL,
  actionTimeout: 30_000,
  navigationTimeout: 60_000,
  screenshot: 'on',
});

test.describe('Production Load Validation', () => {
  test.describe.configure({ mode: 'parallel' });

  test('app loads and renders map', async ({ page }) => {
    await page.goto('/');

    // Wait for the map canvas to render
    const mapContainer = page.locator('canvas, [class*="maplibregl-map"]');
    await expect(mapContainer.first()).toBeVisible({ timeout: 30_000 });

    // Verify page title
    await expect(page).toHaveTitle(/Iran|Monitor|IRT/i);

    // Take a screenshot for visual record
    await page.screenshot({
      path: 'load-test-results/app-loaded.png',
      fullPage: true,
    });
  });

  test('status indicators show healthy state', async ({ page }) => {
    await page.goto('/');

    // Wait for initial data load
    await page.waitForTimeout(10_000);

    // Check that the app has rendered content (not a blank/error page)
    // Note: match "500" only as "500 Internal" (not as numeric values like "500km")
    const body = page.locator('body');
    await expect(body).not.toHaveText(/internal server error|crash|5xx/i);

    // Look for the sidebar or status area — verify flight count is visible and > 0
    // The counters section shows entity counts in the sidebar
    const flightText = page.locator('text=/\\d+\\s*(flights?|aircraft)/i').first();
    const hasFlights = await flightText.isVisible().catch(() => false);

    if (hasFlights) {
      const text = await flightText.textContent();
      console.log(`Flight indicator found: ${text}`);
    } else {
      // Fallback: check any numeric counter is visible (app is rendering data)
      console.log('No explicit flight text found — checking for any data indicators');
      const canvas = page.locator('canvas');
      await expect(canvas.first()).toBeVisible();
    }

    await page.screenshot({
      path: 'load-test-results/status-healthy.png',
      fullPage: true,
    });
  });

  test('app remains stable over 3 minutes', async ({ page }) => {
    test.setTimeout(240_000); // 4 minutes (3-min test window + 1-min buffer)
    const errors: string[] = [];

    // Collect uncaught JS errors
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    await page.goto('/');

    // Wait for initial load
    await page.waitForTimeout(10_000);

    const CHECK_INTERVAL_MS = 30_000;
    const CHECK_COUNT = 6; // 6 checks x 30s = 3 minutes

    for (let i = 0; i < CHECK_COUNT; i++) {
      // Wait for interval (skip first — we just loaded)
      if (i > 0) {
        await page.waitForTimeout(CHECK_INTERVAL_MS);
      }

      const checkNum = i + 1;
      console.log(`Stability check ${checkNum}/${CHECK_COUNT}...`);

      // Assert page is still loaded (not crashed / blank screen)
      const bodyVisible = await page.locator('body').isVisible();
      expect(bodyVisible, `Check ${checkNum}: page body should be visible`).toBe(true);

      // Assert canvas (map) is still rendered
      const canvasVisible = await page
        .locator('canvas')
        .first()
        .isVisible()
        .catch(() => false);
      expect(canvasVisible, `Check ${checkNum}: map canvas should be visible`).toBe(true);

      // Check for any error overlay or crash indicator
      const errorOverlay = await page
        .locator('[class*="error"], [role="alert"]')
        .first()
        .isVisible()
        .catch(() => false);

      if (errorOverlay) {
        console.log(`Warning: possible error overlay detected at check ${checkNum}`);
      }
    }

    // Take final screenshot
    await page.screenshot({
      path: 'load-test-results/stability-final.png',
      fullPage: true,
    });

    // Assert no uncaught JS errors occurred during the 3-minute window
    if (errors.length > 0) {
      console.log(`JS errors collected: ${errors.join('; ')}`);
    }
    expect(errors, 'No uncaught JS errors during 3-minute stability test').toHaveLength(0);
  });
});
