/**
 * Cross-browser end-to-end for catalog *behaviour*, against the REAL built
 * static output (see smoke.spec.ts for why: dist/ over a plain no-fallback
 * static server, not `vite preview`).
 *
 * Where smoke.spec.ts proves the static build is wired up at all, this file
 * exercises specific catalog features that only show real bugs in an actual
 * browser — client-side filter state, search over the `manual` block, and a
 * console-error tripwire. Fixture data (slugs, counts) is read from the same
 * boards.json / rangefinders.json the app fetches, via the `request` fixture,
 * so these tests don't rot when the catalog is re-imported.
 */
import { expect, test } from "@playwright/test";

// Escapes a display name for safe use inside a `new RegExp(...)` locator
// match — none of the current catalog names need it, but a hyphen or paren in
// a future board/device name shouldn't silently break these tests.
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface BoardsPayload {
  boards: { slug: string; manual?: { discontinued?: boolean }; mcu: { family: string | null } }[];
}
interface RangefindersPayload {
  rangefinders: { kind: string; slug: string; display_name: string }[];
}

test.describe("catalog behaviour", () => {
  test("rangefinders: the list renders and a device links through to its detail page", async ({
    page,
    request,
  }) => {
    const { rangefinders }: RangefindersPayload = await (
      await request.get("/rangefinders.json")
    ).json();
    expect(rangefinders.length).toBeGreaterThan(0);
    const sample = rangefinders[0];

    await page.goto("/rangefinders");
    await expect(
      page.getByRole("heading", { name: "Rangefinders & proximity sensors" }),
    ).toBeVisible();
    await expect(page.locator("table.ttable tbody tr.trow").first()).toBeVisible();

    const link = page.getByRole("link", { name: new RegExp(escapeRegExp(sample.display_name)) });
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(new RegExp(`/rangefinder/${sample.kind}-${sample.slug}$`));
    await expect(page.getByRole("heading", { name: sample.display_name, level: 1 })).toBeVisible();
  });

  test("MCU multi-select in a real browser: two chips both end up selected (regression guard)", async ({
    page,
    request,
  }) => {
    // Regression guard: this catalog shipped a bug where the MCU chip
    // handler derived the next filter state from a stale closure, so two
    // rapid chip clicks clobbered each other and the UI behaved as
    // single-select even though the underlying Filters type allows several
    // families at once. toggleIn() now derives from the previous state
    // (setF(prev => ...)); this test drives real clicks in a real browser
    // rather than only unit-testing the reducer, because the bug was in how
    // React batched/handled the click events, not in the reducer logic.
    const { boards }: BoardsPayload = await (await request.get("/boards.json")).json();
    const expectedCount = boards.filter((b) => {
      if (b.manual?.discontinued) return false;
      const fam = b.mcu.family;
      return !!fam && (fam.startsWith("STM32H7") || fam.startsWith("STM32F7"));
    }).length;
    expect(expectedCount).toBeGreaterThan(0);

    await page.goto("/");
    const h7 = page.getByRole("button", { name: "H7", exact: true });
    const f7 = page.getByRole("button", { name: "F7", exact: true });

    await h7.click();
    await f7.click();

    await expect(h7).toHaveAttribute("aria-pressed", "true");
    await expect(f7).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".results-sub strong")).toHaveText(String(expectedCount));
  });

  test("partner filter: the count matches the sidebar label and every row is marked", async ({
    page,
  }) => {
    await page.goto("/");

    const partnerLabel = page.locator("label.toggle", { hasText: "Partners only" });
    // The count only appears once manufacturers.json has loaded, so assert
    // on the parenthesised number rather than racing the fetch.
    await expect(partnerLabel).toContainText(/\(\d+\)/);
    const labelText = (await partnerLabel.innerText()).trim();
    const expectedCount = Number(labelText.match(/\((\d+)\)/)![1]);

    // The checkbox itself is `display:none` (App.css: ".toggle input { display:
    // none; }" — these are custom-styled toggles), so it never appears in the
    // accessibility tree and getByRole("checkbox", ...) can never find it.
    // Click the <label> instead — native label-activation toggles the
    // associated input (and fires React's onChange) regardless of the
    // input's own visibility.
    await partnerLabel.click();

    const rows = page.locator("table.ttable tbody tr.trow");
    await expect(rows).toHaveCount(expectedCount);

    const partnerTicks = page.locator("table.ttable tbody tr.trow .row-partner");
    await expect(partnerTicks).toHaveCount(expectedCount);
  });

  test("search finds a retail variant name that exists only in manual.variants", async ({
    page,
  }) => {
    // "Pixhawk 6X Pro" is a BoardVariant.name under the Pixhawk6X board — it
    // appears nowhere in the hwdef-derived slug/name, only in manual.variants.
    await page.goto("/");
    await page.getByPlaceholder(/Cube, Pixhawk, Matek/i).fill("Pixhawk 6X Pro");
    await expect(page.getByRole("link", { name: /Pixhawk6X/ })).toBeVisible();
  });

  test("no console errors across the selector, a board page, and rangefinders", async ({
    page,
    request,
  }) => {
    const { boards }: BoardsPayload = await (await request.get("/boards.json")).json();
    const slug = boards[0].slug;

    const errors: string[] = [];
    const isFaviconNoise = (text: string, url: string) =>
      /favicon/i.test(text) || /favicon/i.test(url);
    page.on("console", (msg) => {
      if (msg.type() === "error" && !isFaviconNoise(msg.text(), msg.location()?.url ?? "")) {
        errors.push(msg.text());
      }
    });
    page.on("pageerror", (err) => errors.push(String(err)));

    await page.goto("/");
    await expect(page.getByText(/of \d+ ArduPilot-supported boards/)).toBeVisible();

    await page.goto(`/board/${slug}`);
    await expect(page.getByRole("heading", { name: slug, level: 1 })).toBeVisible();

    await page.goto("/rangefinders");
    await expect(
      page.getByRole("heading", { name: "Rangefinders & proximity sensors" }),
    ).toBeVisible();

    expect(errors).toEqual([]);
  });
});
