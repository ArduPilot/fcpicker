/**
 * Cross-browser end-to-end, against the REAL built static output.
 *
 * These run on `vite preview` serving dist/, not the dev server, because that
 * is what nginx will serve. It is the only layer that can catch a broken
 * pre-render, a base-path mistake, or a deep link with no file behind it —
 * all of which look perfect in a dev server with SPA fallback.
 *
 * Runs on Chromium and Firefox: they differ on history, focus and form
 * behaviour, which is exactly where a client-routed static site breaks.
 */
import { expect, test } from "@playwright/test";

test.describe("static build smoke", () => {
  test("the selector lists the full catalog", async ({ page }) => {
    await page.goto("/");
    const sub = page.getByText(/of \d+ ArduPilot-supported boards/);
    await expect(sub).toBeVisible();
    await expect(sub).toContainText(/\b3\d\d\b/); // 300-something boards
  });

  test("a board deep link resolves to a real pre-rendered file", async ({ page }) => {
    // No SPA fallback here: if pre-rendering did not emit this path, it 404s.
    const res = await page.goto("/board/MatekH743");
    expect(res?.status()).toBe(200);
    await expect(page.getByRole("heading", { name: "MatekH743", level: 1 })).toBeVisible();
  });

  test("the pre-rendered HTML carries content before any JavaScript runs", async ({
    browser,
  }) => {
    // The whole point of pre-rendering: a crawler with no JS must see the page.
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto("/board/MatekH743");
    // Role-scoped, not getByText: the slug appears in the heading, an inline
    // <code> and two notes, and a bare text match is a strict-mode violation.
    await expect(page.getByRole("heading", { name: "MatekH743", level: 1 })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Retail versions/i })).toBeVisible();
    await context.close();
  });

  test("searching a retail variant name finds its board", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder(/Cube, Pixhawk, Matek/i).fill("H743-SLIM");
    await expect(page.getByRole("link", { name: /MatekH743/ })).toBeVisible();
  });

  test("client-side navigation and the back button both work", async ({ page }) => {
    await page.goto("/");
    await page.getByPlaceholder(/Cube, Pixhawk, Matek/i).fill("MatekH743");
    await page.getByRole("link", { name: /MatekH743/ }).first().click();
    await expect(page).toHaveURL(/\/board\/MatekH743/);

    await page.goBack();
    await expect(page).toHaveURL(/\/$|\/index\.html$/);
    await expect(page.getByText(/of \d+ ArduPilot-supported boards/)).toBeVisible();
  });
});

// test.use keeps Playwright's own page fixture — and with it the configured
// baseURL, which a hand-rolled browser.newContext() does not inherit.
test.describe("pre-rendered content without JavaScript", () => {
  test.use({ javaScriptEnabled: true });

  test.describe("scripts disabled", () => {
    test.use({ javaScriptEnabled: false });

    test("a crawler with no JS still sees the board's real content", async ({ page }) => {
      await page.goto("/board/MatekH743");
      await expect(page.getByRole("heading", { name: "MatekH743", level: 1 })).toBeVisible();
      await expect(page.getByRole("heading", { name: /Retail versions/i })).toBeVisible();
      // The variant names exist nowhere but the pre-rendered markup.
      await expect(page.getByText("H743-SLIM")).toBeVisible();
    });

    test("the selector table renders its rows without JS", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("link", { name: /MatekH743/ }).first()).toBeVisible();
    });
  });
});
