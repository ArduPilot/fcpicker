/**
 * Selector filtering, driven through the real UI.
 *
 * These mount the actual page with the real catalog primed into the data
 * caches, then click the way a user does. The rapid-toggle case below is a
 * regression test for a shipped bug: the chip handlers derived the next array
 * from render-time state, so two clicks arriving before a re-render both read
 * the same stale value and the first selection was silently lost.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { routes } from "../../src/routes-config";
import { primeAll } from "../helpers";

function renderApp(initialPath = "/") {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] });
  return render(<RouterProvider router={router} />);
}

/** The "N of M boards match your filters" count, as an integer. */
function visibleCount(): number {
  const sub = screen.getByText(/of \d+ ArduPilot-supported boards/i);
  return Number(sub.textContent!.match(/^\s*(\d+)/)![1]);
}

describe("Selector filtering", () => {
  beforeEach(() => {
    primeAll();
  });

  it("shows the whole catalog with no filters applied", () => {
    renderApp();
    const total = Number(
      screen.getByText(/of \d+ ArduPilot-supported boards/i).textContent!.match(/of (\d+)/)![1],
    );
    expect(visibleCount()).toBe(total);
  });

  it("keeps two MCU families selected at once when clicked in quick succession", async () => {
    // Regression: rapid clicks used to clobber each other, leaving one family
    // selected or none — the UI behaved as though it were single-select.
    const user = userEvent.setup();
    renderApp();

    const f7 = screen.getByRole("button", { name: "F7" });
    const h7 = screen.getByRole("button", { name: "H7" });
    await user.click(h7);
    await user.click(f7);

    expect(h7).toHaveAttribute("aria-pressed", "true");
    expect(f7).toHaveAttribute("aria-pressed", "true");
  });

  it("ORs the MCU families, so picking two shows the sum of both", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "H7" }));
    const h7Only = visibleCount();
    await user.click(screen.getByRole("button", { name: "F7" }));
    const both = visibleCount();

    // A board has exactly one MCU family, so the union must be strictly larger.
    expect(both).toBeGreaterThan(h7Only);
  });

  it("finds a retail variant that has no board row of its own", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.type(screen.getByPlaceholderText(/Cube, Pixhawk, Matek/i), "H743-SLIM");
    expect(visibleCount()).toBeGreaterThan(0);
    expect(screen.getByRole("link", { name: /MatekH743/ })).toBeInTheDocument();
  });

  it("filters to partner boards only, matching the sidebar count", async () => {
    const user = userEvent.setup();
    renderApp();

    const toggle = screen.getByLabelText(/Partners only/i, { selector: "input" });
    const label = screen.getByText(/Partners only \((\d+)\)/);
    const claimed = Number(label.textContent!.match(/\((\d+)\)/)![1]);

    await user.click(toggle);
    expect(visibleCount()).toBe(claimed);
  });
});
