import { useEffect, useMemo, useState } from "react";
import { Link, Outlet, useParams } from "react-router-dom";
import type { Board, BoardManual, BoardsPayload, ManualStatus } from "../types";
import "../admin.css";
import { asset } from "../data";

export type AdminCtx = {
  boards: Board[];
  canWrite: boolean;
  llm: boolean;
  saveBoard: (slug: string, manual: BoardManual) => Promise<void>;
};

function statusOf(m: BoardManual | undefined): ManualStatus {
  return m?.status ?? "not_started";
}

export default function AdminLayout() {
  const { slug: activeSlug } = useParams();
  const [boards, setBoards] = useState<Board[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [llm, setLlm] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | ManualStatus>("all");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch(asset("/boards.json")).then((r) => r.json() as Promise<BoardsPayload>),
      fetch(asset("/api/admin/capabilities"))
        .then((r) => (r.ok ? r.json() : { canWrite: false, llm: false }))
        .catch(() => ({ canWrite: false, llm: false })),
    ]).then(([payload, caps]) => {
      setBoards(payload.boards);
      setCanWrite(Boolean(caps.canWrite));
      setLlm(Boolean(caps.llm));
      setLoaded(true);
    });
  }, []);

  async function saveBoard(slug: string, manual: BoardManual) {
    const res = await fetch(`/api/admin/board/${encodeURIComponent(slug)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manual }),
    });
    if (!res.ok) throw new Error(`Save failed: HTTP ${res.status}`);
    setBoards((prev) => prev.map((b) => (b.slug === slug ? { ...b, manual } : b)));
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return boards
      .filter((b) => (q ? b.slug.toLowerCase().includes(q) : true))
      .filter((b) => filter === "all" ? true : statusOf(b.manual) === filter)
      .sort((a, b) => a.slug.localeCompare(b.slug, undefined, { sensitivity: "base" }));
  }, [boards, query, filter]);

  const counts = useMemo(() => {
    const c = { all: boards.length, not_started: 0, partial: 0, complete: 0 } as Record<string, number>;
    for (const b of boards) c[statusOf(b.manual)] += 1;
    return c;
  }, [boards]);

  const ctx: AdminCtx = { boards, canWrite, llm, saveBoard };

  return (
    <>
      <aside className="adm-rail">
        <div className="adm-rail-head">
          <h2 className="adm-rail-title">
            Workbench {canWrite ? <span style={{ color: "var(--ap-green-dark)" }}>· live</span> : <span style={{ color: "#a86a00" }}>· read-only</span>}
          </h2>
          <input
            type="text"
            className="adm-rail-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter boards…"
            spellCheck={false}
          />
          <div style={{ display: "flex", gap: 4, marginTop: 8, flexWrap: "wrap" }}>
            {(["all", "not_started", "partial", "complete"] as const).map((k) => (
              <button
                key={k}
                className={`chip ${filter === k ? "chip-on" : ""}`}
                onClick={() => setFilter(k)}
                style={{ fontSize: 11, padding: "3px 8px" }}
              >
                {k === "not_started" ? "todo" : k} <span style={{ opacity: 0.7 }}>{counts[k]}</span>
              </button>
            ))}
          </div>
        </div>
        <div className="adm-rail-meta">
          <span>{filtered.length} shown</span>
          <span>{counts.complete}/{counts.all} done</span>
        </div>
        <ul className="adm-rail-list">
          {!loaded && <li style={{ padding: "20px 16px", color: "var(--ink-mute)", fontSize: 13 }}>loading…</li>}
          {loaded && filtered.length === 0 && (
            <li style={{ padding: "20px 16px", color: "var(--ink-dim)", fontSize: 13 }}>no matches</li>
          )}
          {filtered.map((b) => {
            const st = statusOf(b.manual);
            return (
              <Link
                key={b.slug}
                to={`/admin/${encodeURIComponent(b.slug)}`}
                className={`adm-rail-item ${b.slug === activeSlug ? "active" : ""}`}
              >
                <span className={`adm-rail-pip ${st === "complete" ? "filled" : st === "partial" ? "partial" : ""}`} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.slug}</span>
              </Link>
            );
          })}
        </ul>
      </aside>

      <section className="adm-canvas">
        {!loaded ? (
          <div className="adm-empty">Loading catalog…</div>
        ) : !activeSlug ? (
          <div className="adm-empty">
            <p>Pick a board from the left to start editing.</p>
            <p style={{ fontSize: 12, color: "var(--ink-dim)" }}>
              Tip: filter by <b>empty</b> to find boards that still need data.
            </p>
          </div>
        ) : (
          <Outlet context={ctx} />
        )}
      </section>
    </>
  );
}
