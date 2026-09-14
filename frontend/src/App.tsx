import { useEffect, useMemo, useState } from "react";
import type { Board, BoardsPayload } from "./types";
import "./App.css";
import { asset } from "./data";

function mcuFamilyLabel(family: string | null): string {
  if (!family) return "Unknown";
  if (family.startsWith("STM32H7")) return "STM32 H7";
  if (family.startsWith("STM32F7")) return "STM32 F7";
  if (family.startsWith("STM32F4")) return "STM32 F4";
  if (family.startsWith("STM32G4")) return "STM32 G4";
  if (family.startsWith("STM32L4")) return "STM32 L4";
  return family;
}

function App() {
  const [boards, setBoards] = useState<Board[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [mcuFilter, setMcuFilter] = useState<string>("any");
  const [minImus, setMinImus] = useState(1);

  useEffect(() => {
    fetch(asset("/boards.json"))
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<BoardsPayload>;
      })
      .then((data) => {
        setBoards(data.boards);
        setLoading(false);
      })
      .catch((e) => {
        setError(String(e));
        setLoading(false);
      });
  }, []);

  const mcuFamilies = useMemo(() => {
    const set = new Set<string>();
    for (const b of boards) set.add(mcuFamilyLabel(b.mcu.family));
    return Array.from(set).sort();
  }, [boards]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return boards.filter((b) => {
      if (q && !b.slug.toLowerCase().includes(q)) return false;
      if (mcuFilter !== "any" && mcuFamilyLabel(b.mcu.family) !== mcuFilter) return false;
      if (b.imus.length < minImus) return false;
      return true;
    });
  }, [boards, query, mcuFilter, minImus]);

  return (
    <div className="app">
      <header className="hero">
        <h1>fcPicker</h1>
        <p className="tagline">
          Find the right flight controller for your UAV. ArduPilot-supported boards,
          parsed straight from the firmware hwdef. (PX4 / INAV / Betaflight coming.)
        </p>
      </header>

      {loading && <p>Loading board catalog…</p>}
      {error && <p className="error">Failed to load boards.json: {error}</p>}

      {!loading && !error && (
        <>
          <section className="filters">
            <label>
              Search
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. Cube, Pixhawk, Matek"
              />
            </label>

            <label>
              MCU family
              <select value={mcuFilter} onChange={(e) => setMcuFilter(e.target.value)}>
                <option value="any">Any</option>
                {mcuFamilies.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </label>

            <label>
              Min IMUs
              <input
                type="number"
                min={1}
                max={5}
                value={minImus}
                onChange={(e) => setMinImus(Number(e.target.value) || 1)}
              />
            </label>

            <span className="count">
              {filtered.length} of {boards.length} boards
            </span>
          </section>

          <ul className="board-list">
            {filtered.map((b) => (
              <li key={b.slug} className="board-card">
                <h3>{b.name}</h3>
                <p className="mcu">
                  {mcuFamilyLabel(b.mcu.family)}
                  {b.mcu.part ? ` — ${b.mcu.part}` : ""}
                  {b.flash_kb ? ` · ${b.flash_kb} KB flash` : ""}
                </p>
                <p className="sensors">
                  {b.imus.length} IMU{b.imus.length !== 1 && "s"} ·{" "}
                  {b.baros.length} baro{b.baros.length !== 1 && "s"} ·{" "}
                  {b.compasses.length} compass{b.compasses.length !== 1 && "es"}
                </p>
                {b.imus.length > 0 && (
                  <details>
                    <summary>Sensor detail</summary>
                    <ul className="sensor-detail">
                      {b.imus.map((s, i) => (
                        <li key={`imu-${i}`}>IMU: {s.chip} ({s.bus})</li>
                      ))}
                      {b.baros.map((s, i) => (
                        <li key={`baro-${i}`}>Baro: {s.chip} ({s.bus})</li>
                      ))}
                      {b.compasses.map((s, i) => (
                        <li key={`compass-${i}`}>Compass: {s.chip} ({s.bus})</li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export default App;
