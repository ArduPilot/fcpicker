/**
 * BoardDetail page, driven through the real UI against the real catalog.
 *
 * Same pattern as selector-filters.test.tsx: mount the actual route with the
 * real payloads primed into the data caches, then assert on what a user would
 * see. Fixture slugs (MatekH743, 3DRControlZeroG, Pixhawk6X, bbbmini) were
 * picked by inspecting frontend/public/{boards,manufacturers}.json directly —
 * see the comments below for why each one was chosen.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router-dom";
import { routes } from "../../src/routes-config";
import { primeAll } from "../helpers";

function renderApp(initialPath: string) {
  const router = createMemoryRouter(routes, { initialEntries: [initialPath] });
  return render(<RouterProvider router={router} />);
}

describe("BoardDetail", () => {
  beforeEach(() => {
    primeAll();
  });

  it("renders the board name, MCU family and flash size for MatekH743", () => {
    renderApp("/board/MatekH743");

    expect(screen.getByRole("heading", { level: 1, name: "MatekH743" })).toBeInTheDocument();
    // mcu.family "STM32H7xx" -> mcuFamilyLabel() -> "STM32 H7"; flash_kb 2048.
    expect(document.body.textContent).toMatch(/STM32 H7/);
    expect(document.body.textContent).toMatch(/2048\s*KB flash/);
  });

  it('renders the "Retail versions" table listing all four H743 products and marks the discontinued ones', () => {
    // These variants (H743-WING/-SLIM/-MINI/-WLITE) exist ONLY in
    // manual.variants in data/boards/MatekH743.json — no hwdef names them,
    // since ArduPilot builds one firmware target for several retail products.
    // This test is what proves that data actually reaches the page.
    renderApp("/board/MatekH743");

    const heading = screen.getByRole("heading", { name: "Retail versions" });
    const section = heading.closest("section")!;

    const wingRow = within(section).getByText("H743-WING").closest("tr")!;
    expect(within(wingRow).queryByText(/discontinued/i)).not.toBeInTheDocument();

    for (const name of ["H743-SLIM", "H743-MINI", "H743-WLITE"]) {
      const row = within(section).getByText(name).closest("tr")!;
      expect(within(row).getByText(/discontinued/i)).toBeInTheDocument();
    }
  });

  it("shows the partner badge for a partner, the non-partner mark for a known non-partner, and neither for an unidentified manufacturer", () => {
    // MatekH743 -> manufacturer "Matek" -> registry id "matek", ardupilot_partner: true.
    const partner = renderApp("/board/MatekH743");
    expect(within(partner.container).getByText(/ArduPilot Partner/i)).toBeInTheDocument();
    expect(within(partner.container).queryByText(/Not a partner/i)).not.toBeInTheDocument();
    partner.unmount();

    // 3DRControlZeroG -> manufacturer "3DR (mRo)" -> registry id "3dr", ardupilot_partner: false.
    const nonPartner = renderApp("/board/3DRControlZeroG");
    expect(within(nonPartner.container).getByText(/Not a partner/i)).toBeInTheDocument();
    expect(within(nonPartner.container).queryByText(/ArduPilot Partner/i)).not.toBeInTheDocument();
    nonPartner.unmount();

    // bbbmini has no manufacturer at all (manual.manufacturer and the
    // top-level manufacturer are both null) -> boardManufacturer() is null,
    // so the whole "by <maker>" line — and both partner marks — are absent.
    const unknown = renderApp("/board/bbbmini");
    expect(within(unknown.container).queryByText(/ArduPilot Partner/i)).not.toBeInTheDocument();
    expect(within(unknown.container).queryByText(/Not a partner/i)).not.toBeInTheDocument();
  });

  it("picks the store-vs-distributor wording correctly for Matek (reseller only) and Holybro (direct store)", () => {
    // Matek Systems has no store_url, only distributors_url -> "Find a ... reseller".
    const matek = renderApp("/board/MatekH743");
    expect(within(matek.container).getByText("Find a Matek Systems reseller")).toBeInTheDocument();
    matek.unmount();

    // Holybro has a store_url -> "Buy direct from Holybro".
    const holybro = renderApp("/board/Pixhawk6X");
    expect(within(holybro.container).getByText("Buy direct from Holybro")).toBeInTheDocument();
  });

  it('renders no "Retail versions" section for a board with no variants', () => {
    // 3DRControlZeroG's manual.variants is empty.
    renderApp("/board/3DRControlZeroG");
    expect(screen.queryByRole("heading", { name: "Retail versions" })).not.toBeInTheDocument();
  });
});
