import { useState } from "react";
import { useAppStore } from "../../store/use-app-store";
import { BASEMAPS } from "../../types";
import type { ImagerySourceDef } from "../../types";

/**
 * Left sidebar: basemap picker, imagery preview source list (with per-source
 * API key entry stored in localStorage + store), and the attribution footer.
 */

function KeyInputRow({ source }: { source: ImagerySourceDef }) {
  const keyId = source.keyId as string;
  // Bind straight to the store slice so every key consumer stays in sync.
  const value = useAppStore((s) => s.keys[keyId] ?? "");
  const setStoredKey = useAppStore((s) => s.setStoredKey);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        marginTop: 6,
        width: "100%",
      }}
    >
      <label className="label" style={{ margin: 0 }}>
        {source.keyLabel ?? "API key"}
      </label>
      <input
        className="input"
        type="password"
        autoComplete="off"
        placeholder={source.keyPlaceholder ?? "paste key"}
        value={value}
        onChange={(e) => setStoredKey(keyId, e.target.value)}
      />
      <span
        style={{
          opacity: 0.6,
          fontSize: "0.66rem",
          color: "var(--text-1)",
          lineHeight: 1.3,
        }}
      >
        saved locally — sent only with exports you start
      </span>
    </div>
  );
}

function SourceRow({
  source,
  active,
  onSelect,
}: {
  source: ImagerySourceDef;
  active: boolean;
  onSelect: () => void;
}) {
  const [keyOpen, setKeyOpen] = useState(false);
  const isPlanet = source.strategy === "planet";
  const hasKeyEntry = source.category === "api" && !!source.keyId && !isPlanet;

  return (
    <div className={`feature-row${active ? " selected" : ""}`}>
      <div
        className="panel-row"
        style={{ display: "flex", alignItems: "center", gap: 6 }}
      >
        {/* Whole label is the click target so picking the source name works,
            not just the small radio dot. */}
        <label
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "flex-start",
            gap: 6,
            cursor: isPlanet ? "not-allowed" : "pointer",
          }}
        >
          <input
            type="radio"
            name="preview-source"
            checked={active}
            disabled={isPlanet}
            onChange={onSelect}
            style={{ marginTop: 3, flexShrink: 0 }}
          />
          <span
            style={{
              flex: 1,
              minWidth: 0,
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 4,
            }}
          >
            <span>{source.name}</span>
            <span className="chip" title="zoom range">
              z{source.minZoom}–{source.maxZoom}
            </span>
            <span className="chip chip-license" title={source.license}>
              {source.license}
            </span>
            {source.streamOnly && (
              <span className="chip warning-text" title="Offline packaging forbidden by license — streaming XML only">
                stream-only
              </span>
            )}
          </span>
        </label>
        {hasKeyEntry && (
          <button
            type="button"
            className="btn btn-ghost"
            title={source.keyLabel ?? "API key"}
            onClick={() => setKeyOpen((v) => !v)}
            style={{ flexShrink: 0 }}
          >
            {keyOpen ? "▴ key" : "▾ key"}
          </button>
        )}
      </div>
      {isPlanet && (
        <div className="panel-row warning-text">
          preview requires OAuth — coming soon
        </div>
      )}
      {hasKeyEntry && keyOpen && <KeyInputRow source={source} />}
    </div>
  );
}

export default function ImageryPanel() {
  const config = useAppStore((s) => s.config);
  const basemapId = useAppStore((s) => s.basemapId);
  const setBasemapId = useAppStore((s) => s.setBasemapId);
  const previewSourceId = useAppStore((s) => s.previewSourceId);
  const setPreviewSourceId = useAppStore((s) => s.setPreviewSourceId);
  const previewOpacity = useAppStore((s) => s.previewOpacity);
  const setPreviewOpacity = useAppStore((s) => s.setPreviewOpacity);

  const sources = config?.sources ?? [];
  const freeSources = sources.filter((s) => s.category === "free");
  const apiSources = sources.filter((s) => s.category === "api");
  const activeSource = sources.find((s) => s.id === previewSourceId) ?? null;
  const basemap = BASEMAPS.find((b) => b.id === basemapId) ?? null;

  return (
    <div className="panel">
      <div className="panel-header">IMAGERY</div>

      <div className="panel-section">
        <label className="label" htmlFor="basemap-select">
          BASEMAP
        </label>
        <select
          id="basemap-select"
          className="select"
          value={basemapId}
          onChange={(e) => setBasemapId(e.target.value)}
        >
          {BASEMAPS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </div>

      <div className="panel-section">
        <div className="label">IMAGERY PREVIEW</div>
        {!config && <div className="panel-row">Loading sources…</div>}
        {config && (
          <>
            <label
              className="panel-row"
              style={{ display: "flex", alignItems: "center", gap: 6 }}
            >
              <input
                type="radio"
                name="preview-source"
                checked={previewSourceId === null}
                onChange={() => setPreviewSourceId(null)}
              />
              None
            </label>

            <div className="label">FREE</div>
            {freeSources.map((s) => (
              <SourceRow
                key={s.id}
                source={s}
                active={previewSourceId === s.id}
                onSelect={() => setPreviewSourceId(s.id)}
              />
            ))}

            <div className="label">API KEY</div>
            {apiSources.map((s) => (
              <SourceRow
                key={s.id}
                source={s}
                active={previewSourceId === s.id}
                onSelect={() => setPreviewSourceId(s.id)}
              />
            ))}
          </>
        )}

        {activeSource && (
          <div className="panel-row" style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <span className="label">OPACITY {Math.round(previewOpacity * 100)}%</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={previewOpacity}
              onChange={(e) => setPreviewOpacity(Number(e.target.value))}
              style={{ flex: 1 }}
            />
          </div>
        )}
      </div>

      <div className="panel-section">
        <div className="label">ATTRIBUTION</div>
        <div className="panel-row" style={{ opacity: 0.75 }}>
          {activeSource ? activeSource.attribution : basemap?.attribution ?? "—"}
        </div>
      </div>
    </div>
  );
}
