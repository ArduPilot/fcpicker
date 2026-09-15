import { useEffect, useMemo, useState } from "react";
import { useOutletContext, useParams } from "react-router-dom";
import { asset, useBoardImages } from "../data";
import type { Board, BoardConnector, BoardManual, ManualStatus } from "../types";
import type { AdminCtx } from "./AdminLayout";
import {
  ASSEMBLY_OPTIONS, CONNECTOR_FUNCTIONS, CONNECTOR_TYPES,
  FORM_FACTORS, MOUNTING_PATTERNS, STATUS_OPTIONS,
} from "./vocab";
import { extract, type ExtractResult } from "./extract";

const EMPTY_MANUAL: BoardManual = {
  status: "not_started",
  manufacturer: null,
  form_factor: null,
  mounting: null,
  assembly: null,
  dimensions_mm: null,
  weight_g: null,
  connectors: [],
  images: [],
  ardupilot_repo_url: null,
  discontinued: false,
  imu_count: null,
  variants: [],
  documents: [],
  notes: null,
};

function normalise(m: BoardManual | undefined): BoardManual {
  if (!m) return { ...EMPTY_MANUAL, connectors: [], images: [] };
  return {
    ...EMPTY_MANUAL,
    ...m,
    status: m.status ?? "not_started",
    images: m.images ?? [],
    discontinued: Boolean(m.discontinued),
    connectors: (m.connectors ?? []).map((c) => ({
      function: c.function ?? null,
      type: c.type ?? "JST-GH",
      pin_count: c.pin_count ?? null,
      quantity: c.quantity ?? 1,
      label: c.label ?? null,
    })),
  };
}

const DRAFT_KEY = (slug: string) => `fcp-admin-draft:${slug}`;

function loadDraft(slug: string): BoardManual | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY(slug));
    return raw ? (JSON.parse(raw) as BoardManual) : null;
  } catch { return null; }
}
function saveDraft(slug: string, m: BoardManual) {
  try { localStorage.setItem(DRAFT_KEY(slug), JSON.stringify(m)); } catch { /* quota */ }
}
function clearDraft(slug: string) {
  try { localStorage.removeItem(DRAFT_KEY(slug)); } catch { /* */ }
}

const eq = (a: BoardManual, b: BoardManual) => JSON.stringify(a) === JSON.stringify(b);

export default function AdminBoard() {
  const { slug = "" } = useParams();
  const { boards, canWrite, llm, saveBoard } = useOutletContext<AdminCtx>();
  const board = boards.find((b) => b.slug === slug);
  if (!board) return <div className="adm-empty">Board "{slug}" not found in the catalog.</div>;
  return <Editor key={slug} slug={slug} board={board} canWrite={canWrite} llm={llm} saveBoard={saveBoard} />;
}

type EditorProps = {
  slug: string;
  board: Board;
  canWrite: boolean;
  llm: boolean;
  saveBoard: AdminCtx["saveBoard"];
};

function Editor({ slug, board, canWrite, llm, saveBoard }: EditorProps) {
  const baseline = useMemo(() => normalise(board.manual), [board]);
  // Restore unsaved draft from localStorage when re-entering a board.
  const [draft, setDraft] = useState<BoardManual>(() => loadDraft(slug) ?? baseline);
  const [showExtract, setShowExtract] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);

  const dirty = !eq(draft, baseline);
  const restoredFromDraft = useMemo(() => loadDraft(slug) !== null && dirty, [slug, dirty]);

  // Persist draft to localStorage whenever it changes (only while dirty).
  useEffect(() => {
    if (dirty) saveDraft(slug, draft);
    else clearDraft(slug);
  }, [slug, draft, dirty]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);
  const set = <K extends keyof BoardManual>(k: K, v: BoardManual[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const setDim = (k: "length" | "width" | "height", v: number | null) =>
    setDraft((d) => ({
      ...d,
      dimensions_mm: {
        length: d.dimensions_mm?.length ?? null,
        width:  d.dimensions_mm?.width  ?? null,
        height: d.dimensions_mm?.height ?? null,
        [k]: v,
      },
    }));
  const patchConn = (i: number, patch: Partial<BoardConnector>) =>
    setDraft((d) => ({ ...d, connectors: d.connectors.map((c, idx) => idx === i ? { ...c, ...patch } : c) }));
  const addConn = (c?: Partial<BoardConnector>) =>
    setDraft((d) => ({
      ...d,
      connectors: [...d.connectors, {
        function: null, type: "JST-GH", pin_count: 6, quantity: 1, label: null,
        ...c,
      }],
    }));
  const removeConn = (i: number) =>
    setDraft((d) => ({ ...d, connectors: d.connectors.filter((_, idx) => idx !== i) }));

  async function onSave() {
    if (!canWrite || !dirty) return;
    setSaving(true);
    try {
      await saveBoard(slug, draft);
      clearDraft(slug);
      setToast({ msg: `Saved data/boards/${slug}.json` });
    } catch (e) {
      setToast({ msg: String(e), err: true });
    } finally {
      setSaving(false);
    }
  }

  function onReset() {
    setDraft(baseline);
    clearDraft(slug);
  }

  const dims = draft.dimensions_mm ?? { length: null, width: null, height: null };

  return (
    <>
      <header className="adm-head">
        <div className="adm-head-info">
          <span className="adm-head-eyebrow">
            {board.manufacturer ?? "unknown vendor"}
            {draft.discontinued && <span className="adm-disc-tag">Discontinued</span>}
          </span>
          <h1 className="adm-head-title">{board.name}</h1>
          <span className="adm-head-sub">
            {board.slug} · {board.mcu.part ?? board.mcu.family ?? "?"}
            {board.flash_kb ? ` · ${board.flash_kb} KB flash` : ""}
          </span>
          {restoredFromDraft && (
            <span style={{ fontSize: 11.5, color: "#a86a00", marginTop: 4 }}>
              ◆ Restored unsaved draft from a previous session
            </span>
          )}
        </div>
        <div className="adm-head-actions">
          <div className="adm-status-seg" role="radiogroup" aria-label="Status">
            {STATUS_OPTIONS.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={draft.status === o.value}
                className={`adm-status-opt status-${o.value} ${draft.status === o.value ? "active" : ""}`}
                onClick={() => set("status", o.value as ManualStatus)}
                title={o.label}
              >
                <span className="adm-status-dot" />
                {o.short}
              </button>
            ))}
          </div>
          <span className={`adm-state ${dirty ? "dirty" : ""}`}>
            <span className="adm-state-pip" />
            {dirty ? "Unsaved" : "Saved"}
          </span>
          {canWrite ? (
            <>
              <button className="adm-btn" onClick={onReset} disabled={!dirty || saving}>Reset</button>
              <button className="adm-btn adm-btn-primary" onClick={onSave} disabled={!dirty || saving}>
                {saving ? "Saving…" : "Save"}
              </button>
            </>
          ) : (
            <button
              className="adm-btn adm-btn-primary"
              onClick={() => {
                navigator.clipboard.writeText(JSON.stringify({ manual: draft }, null, 2));
                setToast({ msg: "manual block copied to clipboard" });
              }}
            >
              Copy JSON
            </button>
          )}
        </div>
      </header>

      <BoardImageBanner key={slug} slug={slug} />

      <ExtractDrawer
        open={showExtract}
        onToggle={() => setShowExtract((v) => !v)}
        llm={llm}
        slug={slug}
        canWrite={canWrite}
        sourceUrls={[
          ...(board.docs_url ? [{ label: "Fetch ArduPilot docs", url: board.docs_url }] : []),
          ...(draft.ardupilot_repo_url ? [{ label: "Fetch vendor link", url: draft.ardupilot_repo_url }] : []),
        ]}
        onImageUploaded={(filename) => setDraft((d) => ({ ...d, images: [...d.images, filename] }))}
        onError={(msg) => setToast({ msg, err: true })}
        onApply={(res) => {
          if (res.dimensions) set("dimensions_mm", res.dimensions);
          if (res.weight_g !== null) set("weight_g", res.weight_g);
          if (res.mounting) set("mounting", res.mounting);
          for (const c of res.connectors) addConn(c);
        }}
      />

      <section className="adm-section">
        <div className="adm-section-head">
          <h2 className="adm-section-title">Overview</h2>
          <span className="adm-section-aside">The fast stuff — three dropdowns, done.</span>
        </div>
        <div className="adm-grid adm-grid-3">
          <Field label="Form factor">
            <select className="adm-select" value={draft.form_factor ?? ""} onChange={(e) => set("form_factor", e.target.value || null)}>
              <option value="">— pick —</option>
              {FORM_FACTORS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
            </select>
          </Field>
          <Field label="Mounting pattern">
            <select className="adm-select" value={draft.mounting ?? ""} onChange={(e) => set("mounting", e.target.value || null)}>
              <option value="">— pick —</option>
              {MOUNTING_PATTERNS.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
            </select>
          </Field>
          <Field label="Assembly">
            <select className="adm-select" value={draft.assembly ?? ""} onChange={(e) => set("assembly", e.target.value || null)}>
              <option value="">— pick —</option>
              {ASSEMBLY_OPTIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            </select>
          </Field>
        </div>
        <div className="adm-grid adm-grid-2" style={{ marginTop: 14 }}>
          <Field label="ArduPilot / vendor link">
            <input
              type="url"
              className="adm-input"
              value={draft.ardupilot_repo_url ?? ""}
              onChange={(e) => set("ardupilot_repo_url", e.target.value.trim() || null)}
              placeholder="https://github.com/ArduPilot/ardupilot/tree/master/libraries/AP_HAL_ChibiOS/hwdef/…"
            />
          </Field>
          <Field label="Availability">
            <label className="adm-toggle-row">
              <input
                type="checkbox"
                checked={draft.discontinued}
                onChange={(e) => set("discontinued", e.target.checked)}
              />
              <span>Mark as discontinued (hidden from public selector by default)</span>
            </label>
          </Field>
        </div>
      </section>

      <section className="adm-section">
        <div className="adm-section-head">
          <h2 className="adm-section-title">Connectors</h2>
          <span className="adm-section-aside">Group identical ports — use the quantity column.</span>
        </div>
        {draft.connectors.length === 0 ? (
          <p style={{ color: "var(--ink-mute)", fontSize: 13, margin: "4px 0 0" }}>
            No connectors recorded — add one below, or use paste-to-extract.
          </p>
        ) : (
          <>
            <div className="adm-conn-header">
              <span>Function</span>
              <span>Connector</span>
              <span style={{ textAlign: "right" }}>Pins</span>
              <span style={{ textAlign: "right" }}>Qty</span>
              <span>Label (optional)</span>
              <span></span>
            </div>
            {draft.connectors.map((c, i) => (
              <div className="adm-conn-row" key={i}>
                <select
                  className="adm-select"
                  value={c.function ?? ""}
                  onChange={(e) => patchConn(i, { function: e.target.value || null })}
                >
                  <option value="">— function —</option>
                  {CONNECTOR_FUNCTIONS.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
                <select
                  className="adm-select"
                  value={c.type}
                  onChange={(e) => patchConn(i, { type: e.target.value })}
                >
                  {CONNECTOR_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <div className="adm-input-suffix">
                  <input
                    type="number" min={1} max={40}
                    value={c.pin_count ?? ""}
                    onChange={(e) => patchConn(i, { pin_count: e.target.value === "" ? null : parseInt(e.target.value, 10) })}
                  />
                  <span>pin</span>
                </div>
                <div className="adm-input-suffix">
                  <input
                    type="number" min={1} max={32}
                    value={c.quantity}
                    onChange={(e) => patchConn(i, { quantity: Math.max(1, parseInt(e.target.value, 10) || 1) })}
                  />
                  <span>×</span>
                </div>
                <input
                  className="adm-input"
                  type="text"
                  value={c.label ?? ""}
                  onChange={(e) => patchConn(i, { label: e.target.value || null })}
                  placeholder="e.g. GPS1"
                />
                <button className="adm-conn-del" onClick={() => removeConn(i)} title="Remove">×</button>
              </div>
            ))}
          </>
        )}
        <button className="adm-btn adm-btn-sm adm-conn-add" onClick={() => addConn()}>+ Add connector</button>
      </section>

      <ImagesSection
        slug={slug}
        canWrite={canWrite}
        images={draft.images}
        onChange={(imgs) => set("images", imgs)}
        onError={(msg) => setToast({ msg, err: true })}
      />

      <section className="adm-section">
        <div className="adm-section-head">
          <h2 className="adm-section-title">Physical (optional)</h2>
          <span className="adm-section-aside">Skip if you don't have the spec.</span>
        </div>
        <div className="adm-grid adm-grid-4">
          {(["length", "width", "height"] as const).map((k) => (
            <Field key={k} label={k}>
              <div className="adm-input-suffix">
                <input
                  type="number" step="0.1"
                  value={dims[k] ?? ""}
                  onChange={(e) => setDim(k, e.target.value === "" ? null : parseFloat(e.target.value))}
                  placeholder="—"
                />
                <span>mm</span>
              </div>
            </Field>
          ))}
          <Field label="Weight">
            <div className="adm-input-suffix">
              <input
                type="number" step="0.1"
                value={draft.weight_g ?? ""}
                onChange={(e) => set("weight_g", e.target.value === "" ? null : parseFloat(e.target.value))}
                placeholder="—"
              />
              <span>g</span>
            </div>
          </Field>
        </div>
      </section>

      <section className="adm-section">
        <div className="adm-section-head">
          <h2 className="adm-section-title">Notes</h2>
        </div>
        <textarea
          className="adm-textarea"
          value={draft.notes ?? ""}
          onChange={(e) => set("notes", e.target.value || null)}
          placeholder="Quirks, mounting notes, errata, kit contents…"
        />
      </section>

      {toast && <div className={`adm-toast ${toast.err ? "err" : ""}`}>{toast.msg}</div>}
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="adm-field">
      <label className="adm-label">{label}</label>
      {children}
    </div>
  );
}

function ImagesSection({
  slug, canWrite, images, onChange, onError,
}: {
  slug: string;
  canWrite: boolean;
  images: string[];
  onChange: (next: string[]) => void;
  onError: (msg: string) => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);

  async function uploadFile(file: File) {
    if (!canWrite) { onError("read-only mode — start npm run dev to upload"); return; }
    if (!file.type.startsWith("image/")) { onError(`not an image: ${file.type || file.name}`); return; }
    setBusy(true);
    try {
      const data = await fileToBase64(file);
      const r = await fetch(`/api/admin/board/${encodeURIComponent(slug)}/image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, data, media_type: file.type }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const { filename } = await r.json();
      onChange([...images, filename]);
    } catch (e) {
      onError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    for (const f of Array.from(files)) await uploadFile(f);
  }

  async function removeImage(filename: string) {
    if (!canWrite) return;
    const r = await fetch(`/api/admin/board/${encodeURIComponent(slug)}/image/${encodeURIComponent(filename)}`, {
      method: "DELETE",
    });
    if (!r.ok) { onError(`Delete failed: HTTP ${r.status}`); return; }
    onChange(images.filter((f) => f !== filename));
  }

  function onPaste(e: React.ClipboardEvent) {
    const files: File[] = [];
    for (const item of e.clipboardData.items) {
      if (item.kind === "file") {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      uploadFiles(files);
    }
  }

  return (
    <section className="adm-section">
      <div className="adm-section-head">
        <h2 className="adm-section-title">Photos &amp; diagrams</h2>
        <span className="adm-section-aside">Shown on the public board page. Drag, paste, or browse.</span>
      </div>

      <div
        className={`adm-dropzone ${dragOver ? "drag" : ""} ${busy ? "busy" : ""}`}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) uploadFiles(e.dataTransfer.files);
        }}
        onPaste={onPaste}
        tabIndex={0}
      >
        <span className="adm-dropzone-hint">
          {busy ? "Uploading…" : dragOver ? "Drop to upload" : "Drag image here · paste from clipboard · or"}
        </span>
        {!busy && !dragOver && (
          <label className="adm-btn adm-btn-sm" style={{ cursor: "pointer" }}>
            Choose files
            <input
              type="file"
              accept="image/*"
              multiple
              style={{ display: "none" }}
              onChange={(e) => { if (e.target.files) uploadFiles(e.target.files); e.target.value = ""; }}
            />
          </label>
        )}
      </div>

      {images.length > 0 && (
        <div className="adm-image-grid">
          {images.map((f) => (
            <div key={f} className="adm-image-tile">
              <a href={asset(`/board-images/${encodeURIComponent(slug)}/${encodeURIComponent(f)}`)} target="_blank" rel="noreferrer">
                <img src={asset(`/board-images/${encodeURIComponent(slug)}/${encodeURIComponent(f)}`)} alt={f} loading="lazy" />
              </a>
              <div className="adm-image-tile-foot">
                <span title={f}>{f}</span>
                {canWrite && (
                  <button className="adm-btn adm-btn-sm adm-btn-danger" onClick={() => removeImage(f)}>Remove</button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function BoardImageBanner({ slug }: { slug: string }) {
  const imgs = useBoardImages(slug);
  const [selected, setSelected] = useState(0);

  if (!imgs) {
    return <div className="adm-image"><div className="adm-image-none">Loading images…</div></div>;
  }
  if (imgs.images.length === 0) {
    return (
      <div className="adm-image">
        <div className="adm-image-none">
          No images in this board's hwdef directory.{" "}
          <a href={`${imgs.baseUrl}/${slug}/`} target="_blank" rel="noreferrer">Check on GitHub ↗</a>
        </div>
      </div>
    );
  }

  const buildUrl = (img: string) =>
    `${imgs.baseUrl}/${slug}/${img.split("/").map(encodeURIComponent).join("/")}`;
  const active = imgs.images[selected] ?? imgs.images[0];

  return (
    <div className="adm-image">
      <a className="adm-image-main" href={buildUrl(active)} target="_blank" rel="noreferrer" title={active}>
        <img src={buildUrl(active)} alt={active} loading="lazy" />
      </a>
      {imgs.images.length > 1 && (
        <div className="adm-image-thumbs">
          {imgs.images.map((img, i) => (
            <button
              key={img}
              type="button"
              className={`adm-image-thumb ${i === selected ? "active" : ""}`}
              onClick={() => setSelected(i)}
              title={img}
            >
              <img src={buildUrl(img)} alt="" loading="lazy" />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

type PastedImage = { filename: string; preview: string; media_type: string; data: string };

function ExtractDrawer({
  open, onToggle, llm, slug, canWrite, sourceUrls, onImageUploaded, onError, onApply,
}: {
  open: boolean;
  onToggle: () => void;
  llm: boolean;
  slug: string;
  canWrite: boolean;
  sourceUrls: Array<{ label: string; url: string }>;
  onImageUploaded: (filename: string) => void;
  onError: (msg: string) => void;
  onApply: (r: ExtractResult) => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [images, setImages] = useState<PastedImage[]>([]);
  const [llmResult, setLlmResult] = useState<ExtractResult | null>(null);
  const [llmError, setLlmError] = useState<string | null>(null);

  const [fetching, setFetching] = useState(false);
  const regexResult = useMemo(() => extract(text), [text]);
  const result = llmResult ?? regexResult;
  const source: "llm" | "regex" = llmResult ? "llm" : "regex";
  const hits = result.connectors.length + (result.dimensions ? 1 : 0) + (result.weight_g !== null ? 1 : 0) + (result.mounting ? 1 : 0);

  async function fetchUrl(url: string) {
    setFetching(true);
    setLlmError(null);
    try {
      const r = await fetch(asset("/api/admin/fetch-url"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const data = await r.json();
      onChangeText(data.text);
    } catch (e) {
      onError(String(e));
    } finally {
      setFetching(false);
    }
  }

  const onChangeText = (next: string) => {
    setText(next);
    if (llmResult || llmError) { setLlmResult(null); setLlmError(null); }
  };

  async function handleImageFile(file: File) {
    if (!canWrite) { onError("Image paste needs canWrite — run npm run dev"); return; }
    if (!file.type.startsWith("image/")) return;
    setUploadingImage(true);
    try {
      const data = await fileToBase64(file);
      // 1) Upload & persist
      const r = await fetch(`/api/admin/board/${encodeURIComponent(slug)}/image`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name || "pasted.png", data, media_type: file.type }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const { filename } = await r.json();
      onImageUploaded(filename);
      // 2) Keep in-memory for the next LLM run
      setImages((prev) => [...prev, {
        filename,
        preview: URL.createObjectURL(file),
        media_type: file.type,
        data,
      }]);
    } catch (e) {
      onError(String(e));
    } finally {
      setUploadingImage(false);
    }
  }

  function onPaste(e: React.ClipboardEvent) {
    const files: File[] = [];
    for (const item of e.clipboardData.items) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length) {
      e.preventDefault();
      for (const f of files) handleImageFile(f);
    }
  }

  function removeImage(filename: string) {
    setImages((prev) => prev.filter((i) => i.filename !== filename));
  }

  async function runLlm() {
    if (!text.trim() && images.length === 0) return;
    setBusy(true);
    setLlmError(null);
    try {
      const r = await fetch(asset("/api/admin/extract"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          images: images.map((i) => ({ media_type: i.media_type, data: i.data })),
        }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
      const data = await r.json();
      setLlmResult({
        dimensions: data.dimensions ?? null,
        weight_g: data.weight_g ?? null,
        mounting: data.mounting ?? null,
        connectors: (data.connectors ?? []).map((c: Record<string, unknown>) => ({
          function: (c.function as string) ?? null,
          type: (c.type as string) ?? "Other",
          pin_count: (c.pin_count as number) ?? null,
          quantity: (c.quantity as number) ?? 1,
          label: (c.label as string) ?? null,
        })),
      });
    } catch (e) {
      setLlmError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="adm-extract">
      <button className={`adm-extract-toggle ${open ? "open" : ""}`} onClick={onToggle}>
        <span>Paste-to-extract</span>
        <span style={{ color: "var(--ink-mute)", fontWeight: 400 }}>
          {open ? "▾" : "▸"} drop product-page text, get structured fields
        </span>
      </button>
      {open && (
        <div className="adm-extract-body">
          <div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, gap: 8, flexWrap: "wrap" }}>
              <label className="adm-label">Source text</label>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {sourceUrls.map((src) => (
                  <button
                    key={src.url}
                    type="button"
                    className="adm-btn adm-btn-sm"
                    onClick={() => fetchUrl(src.url)}
                    disabled={fetching}
                    title={src.url}
                  >
                    {fetching ? "Fetching…" : src.label}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              className="adm-textarea"
              value={text}
              onChange={(e) => onChangeText(e.target.value)}
              onPaste={onPaste}
              placeholder={"e.g.\n\nDimensions: 36 × 36 × 12 mm\nWeight: 9.5g\nConnectors: 2× JST-GH 4P (CAN), 1× JST-GH 6P (GPS), 1× USB-C\n\nTip: paste a pinout image here — it'll be saved AND read by Claude."}
              spellCheck={false}
            />
            {(images.length > 0 || uploadingImage) && (
              <div className="adm-extract-imgs">
                {images.map((img) => (
                  <div className="adm-extract-img" key={img.filename}>
                    <img src={img.preview} alt={img.filename} />
                    <button
                      type="button"
                      className="adm-extract-img-x"
                      onClick={() => removeImage(img.filename)}
                      title="Remove from extract (file stays uploaded)"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {uploadingImage && <span className="adm-extract-img-uploading">uploading…</span>}
              </div>
            )}
          </div>
          <div>
            <label className="adm-label" style={{ marginBottom: 6, display: "block" }}>
              Detected ({hits}) <span style={{ color: "var(--ink-dim)", fontWeight: 400 }}>· via {source === "llm" ? "Claude" : "regex"}</span>
            </label>
            <div className="adm-extract-results">
              {hits === 0 && !llmError && (
                <div className="adm-extract-empty">
                  {text.trim() ? "regex found nothing — try the AI button" : "paste text on the left"}
                </div>
              )}
              {llmError && <div className="adm-extract-empty" style={{ color: "#c44" }}>{llmError}</div>}
              {result.mounting && (
                <div className="adm-extract-hit">
                  <span className="adm-extract-tag">MOUNT</span>
                  <span className="adm-extract-text">{result.mounting}</span>
                </div>
              )}
              {result.dimensions && (
                <div className="adm-extract-hit">
                  <span className="adm-extract-tag">DIM</span>
                  <span className="adm-extract-text">
                    {result.dimensions.length ?? "?"} × {result.dimensions.width ?? "?"}
                    {result.dimensions.height != null ? ` × ${result.dimensions.height}` : ""} mm
                  </span>
                </div>
              )}
              {result.weight_g !== null && (
                <div className="adm-extract-hit">
                  <span className="adm-extract-tag">WGT</span>
                  <span className="adm-extract-text">{result.weight_g} g</span>
                </div>
              )}
              {result.connectors.map((c, i) => (
                <div className="adm-extract-hit" key={i}>
                  <span className="adm-extract-tag">CONN</span>
                  <span className="adm-extract-text">
                    {c.quantity}× {c.type} · {c.pin_count}P
                  </span>
                  <span className="adm-extract-meta">{c.function ?? c.label ?? ""}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="adm-extract-actions">
            <button
              className="adm-btn adm-btn-sm"
              onClick={() => { setText(""); setImages([]); setLlmResult(null); setLlmError(null); }}
            >
              Clear
            </button>
            {llm && (
              <button
                className="adm-btn adm-btn-sm"
                onClick={runLlm}
                disabled={(!text.trim() && images.length === 0) || busy}
                title={images.length > 0
                  ? `Send to Claude with ${images.length} image${images.length === 1 ? "" : "s"}`
                  : "Send to Claude for a smarter pass"}
              >
                {busy ? "Asking Claude…" : `AI extract${images.length > 0 ? ` (+${images.length} img)` : ""}`}
              </button>
            )}
            <button
              className="adm-btn adm-btn-sm adm-btn-primary"
              onClick={() => { onApply(result); setText(""); setLlmResult(null); onToggle(); }}
              disabled={hits === 0}
            >
              Apply {hits} hit{hits === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
