import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { manufacturerFor, purchaseUrl, useManufacturers, useRangefinders } from "../data";
import type { Manufacturer, Rangefinder } from "../types";
import { SiblingNav } from "../SiblingNav";
import { ReportIssue } from "../ReportIssue";

function effectiveRangeMax(r: Rangefinder): number | null {
  return r.manual?.range_max_m_override ?? r.wiki_range_max_m;
}
function effectiveRangeMin(r: Rangefinder): number | null {
  return r.manual?.range_min_m_override ?? r.wiki_range_min_m;
}
function effectiveWeight(r: Rangefinder): number | null {
  return r.manual?.weight_g_override ?? r.wiki_weight_g;
}
function effectiveFov(r: Rangefinder): number | null {
  return r.manual?.fov_deg_override ?? r.wiki_fov_deg;
}

export default function RangefinderDetail() {
  const { id = "" } = useParams();
  const { rangefinders, loading, error } = useRangefinders();
  const mfrIndex = useManufacturers();

  const allIds = useMemo(
    () => (rangefinders ?? [])
      .slice()
      .sort((a, b) => a.display_name.localeCompare(b.display_name))
      .map((x) => `${x.kind}-${x.slug}`),
    [rangefinders],
  );

  if (loading) return <div className="state">Loading…</div>;
  if (error) return <div className="state state-err">Couldn't load rangefinders.json: {error}</div>;
  if (!rangefinders) return null;

  // URL format: <kind>-<slug>  e.g. rangefinder-benewaketfmini, proximity-rplidara2
  const r = rangefinders.find((x) => `${x.kind}-${x.slug}` === id);
  if (!r) {
    return (
      <div className="detail">
        <Link to="/rangefinders" className="back-link">← Back to rangefinders</Link>
        <div className="state state-err">Unknown device: {id}</div>
      </div>
    );
  }

  const classLabel = r.directionality === "omnidirectional" ? "Proximity sensor" : "Rangefinder";
  const paramPrefix = r.directionality === "omnidirectional" ? "PRX" : "RNGFND";
  const range = effectiveRangeMax(r);
  const rangeMin = effectiveRangeMin(r);
  const weight = effectiveWeight(r);
  const fov = effectiveFov(r);

  return (
    <article className="detail">
      <Link to="/rangefinders" className="back-link">← Back to rangefinders</Link>

      <SiblingNav
        currentId={`${r.kind}-${r.slug}`}
        fallbackIds={allIds}
        toUrl={(s) => `/rangefinder/${s}`}
        itemNoun="device"
      />

      <header className="bd-head">
        <p className="bd-eyebrow">ArduPilot-supported {classLabel.toLowerCase()}</p>
        <h1 className="bd-title">{r.display_name}</h1>
        {r.manual?.manufacturer && (
          <p className="bd-maker">
            by {r.manual.manufacturer}
            {manufacturerFor(r.manual.manufacturer, mfrIndex)?.ardupilot_partner && (
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
          </p>
        )}
        <p className="bd-subtitle">
          {r.tech ?? "—"}
          {r.bus && <> &nbsp;·&nbsp; {r.bus} bus</>}
          {range != null && <> &nbsp;·&nbsp; up to {range} m</>}
        </p>
      </header>

      {r.docs_url ? (
        <a className="bd-doc-cta" href={r.docs_url} target="_blank" rel="noreferrer">
          <span className="bd-doc-cta-label">Open the official ArduPilot docs for this device</span>
          <span className="bd-doc-cta-arrow">↗</span>
        </a>
      ) : (
        <div className="bd-doc-cta bd-doc-cta-missing">
          <span>No matching wiki page found for this device.</span>
        </div>
      )}

      <RangefinderBuyLink
        productUrl={r.manual?.product_url ?? null}
        manufacturer={manufacturerFor(r.manual?.manufacturer, mfrIndex)}
      />

      <section className="bd-section">
        <h2 className="bd-h2">Specifications</h2>
        <table className="bd-spec-table">
          <tbody>
            <tr><th>Class</th><td>{classLabel}</td></tr>
            <tr><th>Sensing technology</th><td>{r.tech ?? "—"}</td></tr>
            <tr><th>Bus / interface</th><td>{r.bus ?? "—"}</td></tr>
            <tr><th>Maximum range</th><td>{range != null ? `${range} m` : "—"}</td></tr>
            <tr><th>Minimum range</th><td>{rangeMin != null ? `${rangeMin} m` : "—"}</td></tr>
            <tr><th>Field of view</th><td>{fov != null ? `${fov}°` : "—"}</td></tr>
            <tr><th>Weight</th><td>{weight != null ? `${weight} g` : "—"}</td></tr>
            <tr>
              <th>{paramPrefix}*_TYPE values</th>
              <td>
                {r.type_ids.length ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {r.type_ids.map((t) => (
                      <li key={t.enum}>
                        <code>{t.param_value}</code> &nbsp; {t.enum}
                      </li>
                    ))}
                  </ul>
                ) : "—"}
              </td>
            </tr>
            <tr><th>Driver class</th><td><code>{r.class_name}</code></td></tr>
          </tbody>
        </table>
      </section>

      {(r.manual?.accuracy_cm != null || r.manual?.update_rate_hz != null
        || r.manual?.min_voltage_v != null || r.manual?.current_ma != null
        || r.manual?.notes) && (
        <section className="bd-section">
          <h2 className="bd-h2">Additional details</h2>
          <table className="bd-spec-table">
            <tbody>
              {r.manual?.accuracy_cm != null && (
                <tr><th>Accuracy</th><td>±{r.manual.accuracy_cm} cm</td></tr>
              )}
              {r.manual?.update_rate_hz != null && (
                <tr><th>Update rate</th><td>{r.manual.update_rate_hz} Hz</td></tr>
              )}
              {(r.manual?.min_voltage_v != null || r.manual?.max_voltage_v != null) && (
                <tr>
                  <th>Supply voltage</th>
                  <td>
                    {r.manual?.min_voltage_v ?? "?"}–{r.manual?.max_voltage_v ?? "?"} V
                  </td>
                </tr>
              )}
              {r.manual?.current_ma != null && (
                <tr><th>Current draw</th><td>{r.manual.current_ma} mA</td></tr>
              )}
              {r.manual?.notes && (
                <tr><th>Notes</th><td>{r.manual.notes}</td></tr>
              )}
            </tbody>
          </table>
        </section>
      )}

      <p style={{ fontSize: 12, color: "var(--ink-dim)", marginTop: 24 }}>
        Range, weight and FOV are best-effort scrapes from the ArduPilot wiki and may be wrong.
        Always check the official docs and the manufacturer's datasheet before purchasing.
      </p>

      <ReportIssue
        category="Rangefinder"
        itemId={`${r.kind}-${r.slug}`}
        label={r.display_name}
      />
    </article>
  );
}

// Where to buy. A device-specific product page beats the vendor's home page,
// so it wins when one is recorded; otherwise this falls back to the same
// store -> resellers -> website order the board pages use.
function RangefinderBuyLink({
  productUrl,
  manufacturer,
}: {
  productUrl: string | null;
  manufacturer: Manufacturer | null;
}) {
  const url = productUrl ?? purchaseUrl(manufacturer);
  if (!url) return null;

  const label = productUrl
    ? "Product page"
    : manufacturer?.store_url
      ? `Buy direct from ${manufacturer.name}`
      : manufacturer?.distributors_url
        ? `Find a ${manufacturer.name} reseller`
        : `${manufacturer?.name ?? "Manufacturer"} website`;

  return (
    <a className="bd-doc-cta" href={url} target="_blank" rel="noreferrer" style={{ marginTop: 8 }}>
      <span className="bd-doc-cta-label">{label}</span>
      <span className="bd-doc-cta-arrow">↗</span>
    </a>
  );
}
