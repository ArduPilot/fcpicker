/**
 * Selector page chrome: partner marks, the partners-first sort (and its
 * disclosure notice), vehicle-chip AND semantics, and Reset filters. Same
 * pattern as selector-filters.test.tsx: mount the real page against the real
 * catalog and drive it with userEvent rather than asserting on mocked data.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useRoutes } from "react-router-dom";
import { routes } from "../../src/routes-config";
import { primeAll } from "../helpers";

// A plain MemoryRouter rather than createMemoryRouter: filters now live in
// the query string, and the data router's setSearchParams does not actually
// navigate under jsdom, so every filter interaction silently did nothing.
function Routed() {
  return useRoutes(routes);
}

function renderApp(initialPath = "/") {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Routed />
    </MemoryRouter>,
  );
}

/** The "N of M boards match your filters" count, as an integer. */
function visibleCount(): number {
  const sub = screen.getByText(/of \d+ ArduPilot-supported boards/i);
  return Number(sub.textContent!.match(/^\s*(\d+)/)![1]);
}

/** Table body rows (header row dropped). */
function dataRows(): HTMLElement[] {
  return screen.getAllByRole("row").slice(1);
}

/**
 * Board slugs in current row order, read from each row's board-name link.
 * (Not `within(r).getByRole("link")` — a row with a BDShot firmware target
 * has a second link, the "opt" cell, so that query is ambiguous.)
 */
function rowSlugs(): string[] {
  return dataRows().map((r) => r.querySelector(".row-link")!.textContent!.replace(/[[\]]/g, ""));
}

describe("Selector UI", () => {
  beforeEach(() => {
    primeAll();
  });

  it("marks a partner row with the check, a known non-partner with the cross, and an unidentified manufacturer with neither", () => {
    renderApp();

    // MatekH743 -> Matek Systems, an ArduPilot Corporate Partner.
    const partnerRow = screen.getByRole("link", { name: /MatekH743/ }).closest("tr")!;
    expect(within(partnerRow).getByLabelText("ArduPilot Corporate Partner")).toBeInTheDocument();
    expect(
      within(partnerRow).queryByLabelText("Not an ArduPilot Corporate Partner"),
    ).not.toBeInTheDocument();

    // 3DRControlZeroG -> 3DR, a known non-partner.
    const nonPartnerRow = screen.getByRole("link", { name: /3DRControlZeroG/ }).closest("tr")!;
    expect(
      within(nonPartnerRow).getByLabelText("Not an ArduPilot Corporate Partner"),
    ).toBeInTheDocument();

    // bbbmini has no identified manufacturer -> PartnerMark renders nothing.
    const unknownRow = screen.getByRole("link", { name: /bbbmini/ }).closest("tr")!;
    expect(within(unknownRow).queryByLabelText("ArduPilot Corporate Partner")).not.toBeInTheDocument();
    expect(
      within(unknownRow).queryByLabelText("Not an ArduPilot Corporate Partner"),
    ).not.toBeInTheDocument();
  });

  it('"List partners first" reorders the table without changing how many boards match', async () => {
    const user = userEvent.setup();
    renderApp();

    // Off by default: the table's default sort is alphabetical by slug, so
    // the first row is whichever visible board sorts first overall.
    const neutralSlugs = rowSlugs();
    const alphaFirst = [...neutralSlugs].sort((a, b) => a.localeCompare(b))[0];
    expect(neutralSlugs[0]).toBe(alphaFirst);

    const totalBefore = visibleCount();
    await user.click(screen.getByLabelText(/List partners first/i, { selector: "input" }));
    const totalAfter = visibleCount();

    // This is a sort, not a filter — the match count must not move.
    expect(totalAfter).toBe(totalBefore);

    const firstRowAfter = dataRows()[0];
    expect(within(firstRowAfter).getByLabelText("ArduPilot Corporate Partner")).toBeInTheDocument();
  });

  it('shows a non-neutral order notice while partners-first is on, and "Show neutral order" turns it back off', async () => {
    const user = userEvent.setup();
    renderApp();

    expect(
      screen.queryByText(/Ordered with ArduPilot Corporate Partners first/i),
    ).not.toBeInTheDocument();

    const toggle = screen.getByLabelText(/List partners first/i, { selector: "input" });
    await user.click(toggle);

    expect(screen.getByText(/Ordered with ArduPilot Corporate Partners first/i)).toBeInTheDocument();
    expect(toggle).toBeChecked();

    await user.click(screen.getByRole("button", { name: /Show neutral order/i }));

    expect(toggle).not.toBeChecked();
    expect(
      screen.queryByText(/Ordered with ArduPilot Corporate Partners first/i),
    ).not.toBeInTheDocument();
  });

  it("ANDs the vehicle-type chips (unlike the MCU chips, which are OR'd)", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "Copter" }));
    const copterOnly = visibleCount();
    await user.click(screen.getByRole("button", { name: "Plane" }));
    const copterAndPlane = visibleCount();

    // A board can build for both vehicles, but requiring both can only ever
    // narrow the copter-only set, never grow it (contrast the MCU-family
    // chips test in selector-filters.test.tsx, where a second chip is OR'd
    // in and the count strictly increases).
    expect(copterAndPlane).toBeLessThanOrEqual(copterOnly);
  });

  it('"Reset filters" restores the unfiltered view and unpresses the chips', async () => {
    const user = userEvent.setup();
    renderApp();
    const total = visibleCount();

    await user.type(screen.getByPlaceholderText(/Cube, Pixhawk, Matek/i), "Matek");
    const h7 = screen.getByRole("button", { name: "H7" });
    const copter = screen.getByRole("button", { name: "Copter" });
    await user.click(h7);
    await user.click(copter);

    // Sanity check: the combination actually narrowed the results.
    expect(visibleCount()).toBeLessThan(total);

    await user.click(screen.getByRole("button", { name: "Reset filters" }));

    expect(visibleCount()).toBe(total);
    expect(h7).toHaveAttribute("aria-pressed", "false");
    // Vehicle chips carry no aria-pressed attribute (unlike the MCU chips
    // above) — that's the accessibility gap this suite hit, so the pressed
    // state has to be asserted off the chip-on class instead.
    expect(copter.className).not.toMatch(/\bchip-on\b/);
  });
});

describe("keyboard accessibility", () => {
  beforeEach(() => {
    primeAll();
  });

  it("exposes every sidebar toggle to assistive tech and the tab order", () => {
    // Regression guard: `.toggle input { display: none }` removed all of these
    // from the accessibility tree AND the tab order, so no sidebar toggle could
    // be reached by keyboard at all. They are visually hidden now instead.
    renderApp();
    const toggles = screen.getAllByRole("checkbox");
    expect(toggles.length).toBeGreaterThan(5);
    for (const t of toggles) {
      expect(t).toBeInTheDocument();
    }
  });

  it("reports pressed state on both the MCU and vehicle chips", async () => {
    // The MCU chips always had aria-pressed; the vehicle chips did not, so a
    // screen-reader user could not tell which vehicles were selected.
    const user = userEvent.setup();
    renderApp();

    const copter = screen.getByRole("button", { name: "Copter" });
    expect(copter).toHaveAttribute("aria-pressed", "false");
    await user.click(copter);
    expect(copter).toHaveAttribute("aria-pressed", "true");
  });
});

describe("fuzzy finder help", () => {
  beforeEach(() => {
    primeAll();
  });

  it("describes the toggle without needing a click", () => {
    // A hover tip: the text is present in the DOM and associated with the
    // button, shown by CSS on hover and focus. Rendering it always is what
    // makes it reachable by a screen reader, which has no hover at all.
    renderApp("/");

    const help = screen.getByRole("button", { name: /What is fuzzy finding/i });
    const tip = screen.getByRole("tooltip");
    expect(help).toHaveAttribute("aria-describedby", tip.id);
    expect(tip).toHaveTextContent(/tolerates noise/i);
  });

  it("does not toggle the filter when the help button is used", async () => {
    // The help button sits outside the <label> for exactly this reason.
    const user = userEvent.setup();
    renderApp("/");

    const toggle = screen.getByLabelText(/Fuzzy finder/i, { selector: "input" });
    expect(toggle).not.toBeChecked();

    await user.click(screen.getByRole("button", { name: /What is fuzzy finding/i }));
    expect(toggle).not.toBeChecked();
  });
});
