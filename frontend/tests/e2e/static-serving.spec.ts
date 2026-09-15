/**
 * Cross-browser end-to-end for being served as FILES by nginx — the actual
 * deployment target (see smoke.spec.ts and playwright.config.ts for why:
 * `python3 -m http.server` over dist/, no SPA fallback, so a missing
 * pre-rendered file 404s instead of quietly serving index.html).
 *
 * These prefer `request.get()` over page navigation wherever only a status
 * code or a payload matters, to keep the suite fast — a page load is only
 * used where JS-rendered content actually needs checking (test 10).
 */
import { expect, test } from "@playwright/test";

interface BoardsPayload {
  boards: { slug: string }[];
}

// Evenly spaced sample of `n` items from `items`, e.g. spread across an
// alphabetically sorted slug list rather than just the first n.
function evenSample<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from({ length: n }, (_, i) =>
    items[Math.round((i * (items.length - 1)) / (n - 1))],
  );
}

test.describe("static file serving (nginx deployment target)", () => {
  test("a sample of 20 board deep links, spread across the alphabet, all return 200", async ({
    request,
  }) => {
    const { boards }: BoardsPayload = await (await request.get("/boards.json")).json();
    const slugs = boards.map((b) => b.slug).sort((a, b) => a.localeCompare(b));
    const sample = evenSample(slugs, 20);

    for (const slug of sample) {
      const res = await request.get(`/board/${slug}`);
      expect(res.status(), `slug=${slug}`).toBe(200);
    }
  });

  test("/sitemap.xml is valid XML and a sample of its URLs resolve", async ({ request }) => {
    const res = await request.get("/sitemap.xml");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"] ?? "").toContain("xml");

    const body = await res.text();
    expect(body.startsWith("<?xml")).toBe(true);
    expect(body).toContain("<urlset");
    const openTags = body.match(/<url>/g)?.length ?? 0;
    const closeTags = body.match(/<\/url>/g)?.length ?? 0;
    expect(openTags).toBeGreaterThan(0);
    expect(openTags).toBe(closeTags);

    const locs = [...body.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    expect(locs.length).toBeGreaterThan(0);

    // Sampled (spread evenly, not just the first N), capped at 25 to keep
    // this fast — the sitemap lists hundreds of URLs and this only needs to
    // prove the generator emits reachable links, not audit every one.
    const sample = evenSample(locs, 25);
    for (const loc of sample) {
      const path = new URL(loc).pathname;
      const r = await request.get(path);
      expect(r.status(), `loc=${loc}`).toBe(200);
    }
  });

  test("boards.json, manufacturers.json and rangefinders.json serve as JSON with their expected key", async ({
    request,
  }) => {
    const files: { path: string; key: string }[] = [
      { path: "/boards.json", key: "boards" },
      { path: "/manufacturers.json", key: "manufacturers" },
      { path: "/rangefinders.json", key: "rangefinders" },
    ];
    for (const f of files) {
      const res = await request.get(f.path);
      expect(res.status(), f.path).toBe(200);
      expect(res.headers()["content-type"] ?? "", f.path).toContain("json");
      const body = await res.json();
      expect(Array.isArray(body[f.key]), f.path).toBe(true);
      expect(body[f.key].length, f.path).toBeGreaterThan(0);
    }
  });

  test("a URL with no pre-rendered file 404s — no SPA fallback masking a broken build", async ({
    request,
  }) => {
    const res = await request.get("/board/definitely-not-a-board");
    expect(res.status()).toBe(404);
  });

  test("deep-linking straight to a board with variants renders fully, without visiting the index first", async ({
    page,
  }) => {
    // Pixhawk6X carries two BoardVariant entries (including "Pixhawk 6X
    // Pro"), so this also exercises the Retail versions table.
    await page.goto("/board/Pixhawk6X");

    await expect(page.getByRole("heading", { name: "Pixhawk6X", level: 1 })).toBeVisible();
    await expect(page.locator(".bd-stat-value").first()).toBeVisible();
    await expect(page.getByRole("heading", { name: /Retail versions/i })).toBeVisible();
    await expect(page.locator(".bd-table").first()).toBeVisible();
    await expect(page.getByText("Pixhawk 6X Pro")).toBeVisible();
  });
});
