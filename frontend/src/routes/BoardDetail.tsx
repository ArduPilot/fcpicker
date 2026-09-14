import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  asset,
  boardManufacturer,
  isOnboardSensor,
  partnerStatus,
  manufacturerFor,
  mcuFamilyLabel,
  purchaseUrl,
  sensorSlotKey,
  useBoardImages,
  useBoards,
  useManufacturers,
} from "../data";
import type { Board, BoardAi, BoardVariant, Manufacturer, SensorEntry } from "../types";
import { SiblingNav } from "../SiblingNav";
import { ReportIssue } from "../ReportIssue";

// Physical maximum number of IMU slots any ArduPilot autopilot ships with.
// Used as a hard cap on counts and as the threshold for the "parsing
// over-counted" warning rendered on the detail page.
const MAX_IMU_SLOTS = 3;

const ALL_VEHICLES = ["copter", "plane", "rover", "sub", "tracker", "blimp"] as const;
const VEHICLE_LABEL: Record<string, string> = {
  copter: "Copter", plane: "Plane", rover: "Rover",
  sub: "Sub", tracker: "Tracker", blimp: "Blimp",
};

export default function BoardDetail() {
  const { slug = "" } = useParams();
  const { boards, loading, error } = useBoards();
  const boardImages = useBoardImages(slug);
  const mfrIndex = useManufacturers();
  // Show the "<slug>-bdshot" firmware target's pin map instead of the default.
  const [bdshotOn, setBdshotOn] = useState(false);

  const allSlugs = useMemo(
    () => (boards ?? []).slice().sort((a, b) => a.slug.localeCompare(b.slug)).map((x) => x.slug),
    [boards],
  );

  if (loading) return <div className="state">Loading…</div>;
  if (error) return <div className="state state-err">Couldn't load boards.json: {error}</div>;
  if (!boards) return null;
  const b = boards.find((x) => x.slug === slug);
  if (!b) {
    return (
      <div className="detail">
        <Link to="/" className="back-link">← Back to selector</Link>
        <div className="state state-err">Unknown board: {slug}</div>
      </div>
    );
  }

  const docsCommon = "https://ardupilot.org/copter/docs/common-autopilots.html";
  const target = b.bdshot_target;
  const useTarget = bdshotOn && target != null;
  const io = useTarget ? target.io : b.io;
  const hwdefSlug = useTarget ? target.slug : b.slug;
  const hwdefUrl = `https://github.com/ArduPilot/ardupilot/tree/master/libraries/AP_HAL_ChibiOS/hwdef/${hwdefSlug}`;
  const firmware = b.firmware_support[0];

  return (
    <article className="detail">
      <Link to="/" className="back-link">← Back to selector</Link>

      <SiblingNav
        currentId={b.slug}
        fallbackIds={allSlugs}
        toUrl={(s) => `/board/${s}`}
        itemNoun="board"
      />

      <header className="bd-head">
        <p className="bd-eyebrow">ArduPilot-supported autopilot</p>
        <h1 className="bd-title">{b.slug}</h1>
        {boardManufacturer(b) && (
          <p className="bd-maker" title="Manufacturer — suggested for discovery; verify in docs">
            by {boardManufacturer(b)}
            {partnerStatus(b, mfrIndex) === "partner" && (
              <a
                className="bd-partner"
                href="https://ardupilot.org/copter/docs/common-partners.html"
                target="_blank"
                rel="noreferrer"
                title="Listed as a Corporate Partner on ArduPilot's partners page"
              >
                ✓ ArduPilot Partner
              </a>
            )}
            {partnerStatus(b, mfrIndex) === "non-partner" && (
              <span
                className="bd-nonpartner"
                title="This manufacturer is not listed as an ArduPilot Corporate Partner"
              >
                ✗ Not a partner
              </span>
            )}
          </p>
        )}
        <p className="bd-subtitle">
          {b.platform === "linux" ? "Linux board" : mcuFamilyLabel(b.mcu.family)}
          {b.mcu.part && <> &nbsp;·&nbsp; <code className="bd-code">{b.mcu.part}</code></>}
          {b.flash_kb && <> &nbsp;·&nbsp; {b.flash_kb} KB flash</>}
        </p>
      </header>

      {/* Most-important action: open the official docs */}
      {b.docs_url ? (
        <a className="bd-doc-cta" href={b.docs_url} target="_blank" rel="noreferrer">
          <span className="bd-doc-cta-label">Open the official ArduPilot docs for this board</span>
          <span className="bd-doc-cta-arrow">↗</span>
        </a>
      ) : (
        <div className="bd-doc-cta bd-doc-cta-missing">
          <span>Unable to find the documentation link.</span>
        </div>
      )}

      {b.repo_url && (
        <a
          className="bd-doc-cta"
          href={b.repo_url}
          target="_blank"
          rel="noreferrer"
          style={{ marginTop: 8 }}
        >
          <span className="bd-doc-cta-label">
            {b.repo_url.includes("github.com")
              ? "hwdef source & README on GitHub"
              : "Vendor / reference page"}
          </span>
          <span className="bd-doc-cta-arrow">↗</span>
        </a>
      )}

      {b.manual?.ardupilot_repo_url &&
        b.manual.ardupilot_repo_url !== b.docs_url &&
        b.manual.ardupilot_repo_url !== b.repo_url && (
        <a
          className="bd-doc-cta"
          href={b.manual.ardupilot_repo_url}
          target="_blank"
          rel="noreferrer"
          style={{ marginTop: 8 }}
        >
          <span className="bd-doc-cta-label">Vendor / ArduPilot repository link</span>
          <span className="bd-doc-cta-arrow">↗</span>
        </a>
      )}

      <BuyLink manufacturer={manufacturerFor(boardManufacturer(b), mfrIndex)} />

      <Variants variants={b.manual?.variants ?? []} />

      {/* Board images — admin uploads first, then hwdef images from GitHub */}
      <BoardGallery
        slug={slug}
        adminImages={b.manual?.images ?? []}
        hwdefImages={boardImages}
      />

      {/* Stats strip — at a glance */}
      <section className="bd-section">
        <h2 className="bd-h2">Key specs</h2>
        {target && (
          <div className="bd-target">
            <label className="toggle">
              <input type="checkbox" checked={bdshotOn} onChange={(e) => setBdshotOn(e.target.checked)} />
              <span className="toggle-mark" aria-hidden />
              <span className="toggle-label">
                Bidirectional DShot {bdshotOn ? "enabled" : "disabled"}
                <span className="bd-target-slug"> — firmware target <code className="bd-code">{hwdefSlug}</code></span>
              </span>
            </label>
            {bdshotOn && target.notes && <p className="bd-target-note">{target.notes}</p>}
            {!bdshotOn && (
              <p className="bd-target-note">
                Same board; the {target.slug} firmware remaps pins for BDShot. Switch on to see that pin map.
              </p>
            )}
          </div>
        )}
        <div className="bd-stats">
          <Stat label="UART" value={io.uart_count} hint={io.uart_buses.join(", ") || undefined} />
          <Stat label="I²C"  value={io.i2c_count} hint={io.i2c_buses.join(", ") || undefined} />
          <Stat label="SPI"  value={io.spi_count} hint={io.spi_buses.join(", ") || undefined} />
          <Stat label={io.canfd ? "CAN-FD" : "CAN"} value={io.can_count} hint={io.can_buses.join(", ") || undefined} />
          <Stat
            label="PWM"
            value={io.pwm.total}
            hint={io.iomcu ? `${io.pwm.fmu} FMU + ${io.pwm.io} IO` : "FMU only"}
          />
          <Stat label="IMUs" value={imuStatValue(b)} hint={imuStatHint(b)} />
        </div>
        <div className="bd-feature-row">
          <FeatureChip on={io.ethernet} label="Ethernet" />
          <FeatureChip on={io.sdcard} label="microSD" />
          <FeatureChip on={io.sbus_out} label="SBUS out" />
          <FeatureChip on={io.bdshot} label="Bidirectional DShot" />
          <FeatureChip on={io.usb_count > 0} label={`USB ×${io.usb_count}`} />
          {b.power.monitor_inputs > 0 && <FeatureChip on label={`Power inputs ×${b.power.monitor_inputs}`} />}
          {io.adc_inputs > 0 && <FeatureChip on label={`ADC ×${io.adc_inputs}`} />}
        </div>
      </section>

      {/* Sensors */}
      {io.serial_ports.length > 0 && (
        <section className="bd-section">
          <h2 className="bd-h2">Serial port map</h2>
          <p className="bd-target-note" style={{ marginTop: 0, marginBottom: 12 }}>
            ArduPilot SERIAL<i>n</i> parameter number → hardware UART → MCU pad, from the
            {" "}{hwdefSlug} hwdef. Default protocol is ArduPilot&rsquo;s unless marked
            &ldquo;hwdef&rdquo;; the note is the hwdef author&rsquo;s comment above those pins.
          </p>
          <div className="bd-table-wrap">
            <table className="bd-table bd-serial">
              <thead>
                <tr>
                  <th>Param</th>
                  <th>Port</th>
                  <th>TX pad</th>
                  <th>RX pad</th>
                  <th>RTS / CTS</th>
                  <th>Default protocol</th>
                  <th>hwdef note</th>
                </tr>
              </thead>
              <tbody>
                {io.serial_ports.map((sp) => (
                  <tr key={sp.serial}>
                    <td><strong>SERIAL{sp.serial}</strong></td>
                    <td><code className="bd-code">{sp.device}</code>{sp.usb && <span className="bd-chip bd-chip-muted">USB</span>}</td>
                    <td>{sp.usb ? "—" : pad(sp.tx, sp.inverted)}</td>
                    <td>{sp.usb ? "—" : pad(sp.rx, sp.inverted)}</td>
                    <td>{sp.rts || sp.cts ? `${sp.rts ?? "—"} / ${sp.cts ?? "—"}` : "—"}</td>
                    <td>
                      {sp.protocol ? (
                        <span title={`SERIAL${sp.serial}_PROTOCOL = ${sp.protocol.id}${sp.protocol.from_hwdef ? " (set by this hwdef)" : " (ArduPilot built-in default)"}`}>
                          {sp.protocol.name}
                          {sp.protocol.from_hwdef && <span className="bd-chip bd-chip-muted">hwdef</span>}
                        </span>
                      ) : "—"}
                    </td>
                    <td className="bd-serial-hint">{sp.hint ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="bd-section">
        <h2 className="bd-h2">On-board sensors</h2>
        <SensorRow label="IMUs"        items={b.imus} flagOverCount={MAX_IMU_SLOTS} />
        <SensorRow label="Barometers"  items={b.baros} />
        <SensorRow label="Compasses"   items={b.compasses} />
        <p className="bd-aside">
          Counts are inferred from ArduPilot&rsquo;s hwdef files, which list the
          parts the firmware <em>probes for</em> — including alternates and
          multiple board revisions — not a guaranteed physical inventory. We
          collapse probe-alternates and drop external (plug-in) sensors, but
          treat these as a guide and confirm exact sensors in the docs above.
        </p>
      </section>

      {/* Power output (BEC rails) — only when curated data exists */}
      {b.power.bec.length > 0 && (
        <section className="bd-section">
          <h2 className="bd-h2">Power output</h2>
          <ul className="bd-bec">
            {b.power.bec.map((r, i) => (
              <li key={i} className="bd-bec-item">
                <span className="bd-bec-rail">{r.rail}</span>
                <span className="bd-bec-spec">{r.voltage_v} V · {r.current_a} A</span>
                {r.note && <span className="bd-bec-note">{r.note}</span>}
              </li>
            ))}
          </ul>
          <p className="bd-aside">Hand-curated from vendor docs.</p>
        </section>
      )}

      {/* Suggested specs — AI-gathered, NON-authoritative discovery aid */}
      <SuggestedSpecs ai={b.ai} docsUrl={b.docs_url} />

      {/* Vehicles — inline row of pills, NOT stacked */}
      <section className="bd-section">
        <h2 className="bd-h2">Vehicle support</h2>
        <p className="bd-vehicles">
          {ALL_VEHICLES.map((v) => (
            <span
              key={v}
              className={"bd-v " + (b.vehicles.includes(v) ? "bd-v-on" : "bd-v-off")}
              title={b.vehicles.includes(v) ? "Supported" : "Not built for this vehicle"}
            >
              {b.vehicles.includes(v) ? "✓" : "✕"} {VEHICLE_LABEL[v]}
            </span>
          ))}
        </p>
        <p className="bd-aside">
          From the <code className="bd-code">AUTOBUILD_TARGETS</code> line in this board&rsquo;s hwdef.
        </p>
      </section>

      {/* Firmware compatibility — one-liner, not a table */}
      <section className="bd-section">
        <h2 className="bd-h2">Firmware compatibility</h2>
        <p className="bd-line">
          <strong style={{ textTransform: "capitalize" }}>{firmware.firmware}</strong>{" "}
          —{" "}
          <span className={`maturity maturity-${firmware.maturity}`}>{firmware.maturity}</span>
        </p>
      </section>

      {/* Other references */}
      <section className="bd-section">
        <h2 className="bd-h2">More references</h2>
        <ul className="bd-links">
          <li><a href={hwdefUrl} target="_blank" rel="noreferrer">hwdef source on GitHub ↗</a></li>
          <li><a href={docsCommon} target="_blank" rel="noreferrer">Common autopilots — overview index ↗</a></li>
        </ul>
      </section>

      <ReportIssue category="Flight controller" itemId={b.slug} label={b.slug} />
    </article>
  );
}

function BoardGallery({
  slug, adminImages, hwdefImages,
}: {
  slug: string;
  adminImages: string[];
  hwdefImages: ReturnType<typeof useBoardImages>;
}) {
  type Img = { url: string; caption: string; source: "admin" | "hwdef" };
  const images: Img[] = [];
  // Track basenames already added — first wins (admin uploads win over hwdef).
  const seen = new Set<string>();
  const key = (name: string) => name.split("/").pop()!.toLowerCase();
  for (const f of adminImages) {
    if (seen.has(key(f))) continue;
    seen.add(key(f));
    images.push({
      url: asset(`/board-images/${encodeURIComponent(slug)}/${encodeURIComponent(f)}`),
      caption: f,
      source: "admin",
    });
  }
  if (hwdefImages) {
    for (const img of hwdefImages.images) {
      if (seen.has(key(img))) continue;
      seen.add(key(img));
      images.push({
        url: `${hwdefImages.baseUrl}/${slug}/${img.split("/").map(encodeURIComponent).join("/")}`,
        caption: img,
        source: "hwdef",
      });
    }
  }
  if (images.length === 0) return null;
  return (
    <section className="bd-section">
      <h2 className="bd-h2">Board photos &amp; diagrams</h2>
      <div className="bd-gallery">
        {images.map((it) => (
          <a key={it.source + ":" + it.url} className="bd-gallery-item" href={it.url} target="_blank" rel="noreferrer" title={it.caption}>
            <img src={it.url} alt={it.caption} loading="lazy" />
            <span className="bd-gallery-caption">{it.caption}</span>
          </a>
        ))}
      </div>
      <p className="bd-aside">
        Curated photos plus hwdef pinouts pulled from GitHub.
      </p>
    </section>
  );
}

// Pad cell: "PA9", or "PA9 (inv)" for a hardware-inverted TXINV/RXINV pin.
function pad(p: string | null, inverted: boolean) {
  if (!p) return "—";
  return (
    <>
      <code className="bd-code">{p}</code>
      {inverted && <span className="bd-serial-proto"> inv</span>}
    </>
  );
}

function FeatureChip({ on, label }: { on: boolean; label: string }) {
  return (
    <span className={"bd-v " + (on ? "bd-v-on" : "bd-v-off")}>
      {on ? "✓" : "✕"} {label}
    </span>
  );
}

function Stat({ label, value, hint, flag }: { label: string; value: number | string; hint?: string; flag?: string }) {
  return (
    <div className="bd-stat" title={flag ?? hint}>
      <div className="bd-stat-value">
        {value}
        {flag && <span className="bd-stat-flag" title={flag}>⚠</span>}
      </div>
      <div className="bd-stat-label">{label}</div>
      {(flag || hint) && <div className="bd-stat-hint">{flag ?? hint}</div>}
    </div>
  );
}

// AI-gathered enrichment — a discovery aid, clearly marked unverified. Chip
// names are deliberately NOT shown (unreliable across hardware revisions);
// the authoritative sensor list lives in the "On-board sensors" section.
function SuggestedSpecs({ ai, docsUrl }: { ai?: BoardAi; docsUrl?: string | null }) {
  if (!ai) return null;
  const rows: { label: string; value: string }[] = [];
  const push = (label: string, value: string | null | undefined) => {
    if (value) rows.push({ label, value });
  };
  push("Product name", ai.marketing_name);
  push("Series", ai.family);
  const d = ai.dimensions_mm;
  if (d) {
    const parts = [d.length, d.width, d.height].filter((x): x is number => x != null);
    if (parts.length) push("Dimensions", parts.join(" × ") + " mm");
  }
  push("Weight", ai.weight_g != null ? `${ai.weight_g} g` : null);
  if (ai.mounting_pattern_mm) {
    push(
      "Mounting",
      ai.mounting_pattern_mm + " mm" +
        (ai.mounting_hole_dia_mm ? `, Ø${ai.mounting_hole_dia_mm} mm holes` : ""),
    );
  }
  push("Input", ai.voltage_cells ?? (ai.voltage_max_v ? `≤ ${ai.voltage_max_v} V` : null));
  if (ai.bec_outputs && ai.bec_outputs.length) {
    const becs = ai.bec_outputs
      .map((r) => (r.volts != null ? `${r.volts}V${r.amps != null ? `/${r.amps}A` : ""}` : null))
      .filter(Boolean)
      .join(", ");
    push("BEC", becs || null);
  }
  push("Blackbox", ai.blackbox_flash);
  push("OSD", ai.osd_chip ?? (ai.has_osd ? "yes" : null));
  push("Wireless", ai.wireless);
  if (ai.notable_connectors && ai.notable_connectors.length) {
    push("Connectors", ai.notable_connectors.join(" · "));
  }
  if (rows.length === 0 && !ai.pinout_notes) return null;
  return (
    <section className="bd-section bd-ai">
      <h2 className="bd-h2">
        Suggested specs <span className="bd-ai-tag">unverified — AI-based</span>
      </h2>
      <dl className="bd-ai-grid">
        {rows.map((r) => (
          <div className="bd-ai-row" key={r.label}>
            <dt>{r.label}</dt>
            <dd>{r.value}</dd>
          </div>
        ))}
      </dl>
      {ai.pinout_notes && <p className="bd-ai-notes">{ai.pinout_notes}</p>}
      <p className="bd-aside">
        Gathered automatically from vendor pages &amp; docs — <strong>not verified</strong>. A board
        may ship in several hardware revisions, so these figures can be wrong.{" "}
        {docsUrl ? (
          <>
            Always validate against the{" "}
            <a href={docsUrl} target="_blank" rel="noreferrer">ArduPilot wiki</a> before relying on them.
          </>
        ) : (
          <>Always validate against the official ArduPilot wiki before relying on them.</>
        )}
      </p>
    </section>
  );
}

// Group sensors that share a physical SPI slot. Items with no slot become
// their own group (rendered as a single chip).
type Slot = { slot: string | null; entries: SensorEntry[] };
function groupBySlot(items: SensorEntry[]): Slot[] {
  const out: Slot[] = [];
  for (const s of items) {
    // Group by physical position: SPI chip-select slot, or I2C bus channel so
    // probe-alternate parts (same channel, different address) collapse to one.
    const key = sensorSlotKey(s);
    let g = out.find((x) => x.slot === key);
    if (!g) {
      g = { slot: key, entries: [] };
      out.push(g);
    }
    g.entries.push(s);
  }
  return out;
}

function SensorRow({
  label, items: allItems, flagOverCount,
}: {
  label: string;
  items: SensorEntry[];
  // If set, render a warning banner whenever slot count exceeds this value.
  // Used for IMUs, where the physical maximum is 3 and any larger count
  // means the hwdef parsing picked up alternates we couldn't collapse.
  flagOverCount?: number;
}) {
  // Onboard sensors only — external plug-in probes aren't chips on the PCB.
  const items = allItems.filter(isOnboardSensor);
  if (items.length === 0) {
    return (
      <div className="bd-sensor-row">
        <span className="bd-sensor-label">{label}</span>
        <span className="bd-sensor-empty">none</span>
      </div>
    );
  }

  const hasVariants = items.some((s) => s.variant);
  if (!hasVariants) {
    const slots = groupBySlot(items);
    const over = flagOverCount != null && slots.length > flagOverCount;
    return (
      <div className="bd-sensor-row">
        <span className="bd-sensor-label">
          {label} <span className="bd-sensor-count">×{over ? flagOverCount : slots.length}</span>
        </span>
      </div>
    );
  }

  // Group sensors by variant. Preserve first-seen order for both variants
  // and the sensors within them. Ungated sensors (variant=null) come first
  // under a "Common" group if both gated and ungated exist on the same kind.
  const groups: { variant: string | null; entries: SensorEntry[] }[] = [];
  for (const s of items) {
    const key = s.variant ?? null;
    let g = groups.find((x) => x.variant === key);
    if (!g) {
      g = { variant: key, entries: [] };
      groups.push(g);
    }
    g.entries.push(s);
  }

  return (
    <div className="bd-sensor-row">
      <span className="bd-sensor-label">{label}</span>
      <div className="bd-sensor-variants">
        <p className="bd-aside">
          This board ships in multiple hardware variants; the count can differ per revision.
        </p>
        {groups.map((g, gi) => {
          const slots = groupBySlot(g.entries);
          return (
            <div className="bd-sensor-variant" key={gi}>
              <div className="bd-sensor-variant-label">
                {g.variant ? prettyVariant(g.variant) : "Common to all variants"}
                <span className="bd-sensor-count"> ×{slots.length}</span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function imuStatValue(b: Board): string {
  if (b.manual?.imu_count != null) return String(b.manual.imu_count);
  const counts = perVariantCounts(b.imus).map((n) => Math.min(n, MAX_IMU_SLOTS));
  if (counts.length <= 1) return String(counts[0] ?? 0);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return min === max ? String(min) : `${min}–${max}`;
}

function imuStatHint(b: Board): string | undefined {
  if (b.manual?.imu_count != null) return "manual override";
  const counts = perVariantCounts(b.imus);
  return counts.length > 1 ? "per hardware variant" : undefined;
}

// Count physical IMU slots, not raw declarations. Sensors sharing a SPI
// chip-select are alternates for the same socket — count them once.
function perVariantCounts(items: SensorEntry[]): number[] {
  if (!items.some((s) => s.variant)) return [groupBySlot(items).length];
  const byVariant = new Map<string, SensorEntry[]>();
  const ungated: SensorEntry[] = [];
  for (const s of items) {
    if (s.variant) {
      const arr = byVariant.get(s.variant) ?? [];
      arr.push(s);
      byVariant.set(s.variant, arr);
    } else {
      ungated.push(s);
    }
  }
  const ungatedSlots = groupBySlot(ungated).length;
  return [...byVariant.values()].map(
    (arr) => groupBySlot(arr).length + ungatedSlots,
  );
}

function prettyVariant(token: string): string {
  // FMUV6_BOARD_HOLYBRO_6X → Holybro 6X
  // FMUV6_BOARD_HOLYBRO_6X_REV6 → Holybro 6X Rev6
  let s = token.replace(/^FMUV\d+_BOARD_/i, "");
  s = s.replace(/_/g, " ");
  return s.replace(/\b([a-z])([a-z]*)/gi, (_, a: string, rest: string) =>
    a.toUpperCase() + rest.toLowerCase(),
  );
}


// Where-to-buy link. Vendors with a large distribution network (Matek,
// CubePilot) have no direct store, so the reseller list is the buy route —
// purchaseUrl() picks store → resellers → home page in that order.
function BuyLink({ manufacturer }: { manufacturer: Manufacturer | null }) {
  const url = purchaseUrl(manufacturer);
  if (!manufacturer || !url) return null;

  const kind = manufacturer.store_url
    ? `Buy direct from ${manufacturer.name}`
    : manufacturer.distributors_url
      ? `Find a ${manufacturer.name} reseller`
      : `${manufacturer.name} website`;

  return (
    <a className="bd-doc-cta" href={url} target="_blank" rel="noreferrer" style={{ marginTop: 8 }}>
      <span className="bd-doc-cta-label">
        {kind}
        {!manufacturer.verified && " (link unverified)"}
      </span>
      <span className="bd-doc-cta-arrow">↗</span>
    </a>
  );
}

// Mounting is either a hole pattern ("30.5x30.5", which wants a mm unit) or a
// named standard ("Pixhawk Autopilot Bus", which does not).
function formatMounting(m: string | null): string {
  if (!m) return "—";
  return /^[\d.]+\s*[x×]\s*[\d.]+$/i.test(m.trim()) ? `${m} mm` : m;
}

// Retail products sharing this firmware target. ArduPilot builds one firmware
// per hwdef, so several physically different boards can land on one entry —
// this is where a buyer finds out which one they actually have.
function Variants({ variants }: { variants: BoardVariant[] }) {
  if (variants.length === 0) return null;
  return (
    <section className="bd-section">
      <h2 className="bd-h2">Retail versions</h2>
      <p className="bd-target-note" style={{ marginTop: 0, marginBottom: 12 }}>
        These are sold as separate products but all run this board&rsquo;s firmware
        target. Pinouts and on-board resources differ — check the vendor page for
        the exact version you own.
      </p>
      <div className="bd-table-wrap">
        <table className="bd-table">
          <thead>
            <tr>
              <th>Version</th>
              <th>Differences</th>
              <th>Mounting</th>
              <th>Weight</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => (
              <tr key={v.name}>
                <td>
                  <strong>{v.name}</strong>
                  {v.discontinued && <span className="bd-chip bd-chip-muted">discontinued</span>}
                </td>
                <td>{v.differences ?? "—"}</td>
                <td>{formatMounting(v.mounting)}</td>
                <td>{v.weight_g != null ? `${v.weight_g} g` : "—"}</td>
                <td>
                  {v.product_url ? (
                    <a href={v.product_url} target="_blank" rel="noreferrer">
                      Product page ↗
                    </a>
                  ) : (
                    "—"
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
