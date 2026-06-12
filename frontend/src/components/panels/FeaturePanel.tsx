import { useState } from "react";
import type { ChangeEvent } from "react";
import { useAppStore } from "../../store/use-app-store";
import {
  AFFILIATIONS,
  SYMBOL_CATEGORIES,
  applyAffiliation,
  getSymbolDataUrl,
  sameSymbol,
} from "../../lib/milsymbol-utils";
import { featuresFromGeoJson } from "../../lib/geojson-import";
import type { Affiliation, FeatureKind, MapFeature } from "../../types";

/**
 * Right sidebar: milsymbol palette, feature list, selected-feature editor,
 * GeoJSON import, and clear-all.
 */

const KIND_GLYPHS: Record<FeatureKind, string> = {
  marker: "◉",
  line: "╱",
  route: "➔",
  polygon: "⬠",
  rectangle: "▭",
  circle: "◯",
};

const AREA_KINDS: FeatureKind[] = ["polygon", "rectangle", "circle"];

function FeatureRow({
  feature,
  selected,
  editing,
  onStartEdit,
  onEndEdit,
}: {
  feature: MapFeature;
  selected: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onEndEdit: () => void;
}) {
  const setSelectedFeatureId = useAppStore((s) => s.setSelectedFeatureId);
  const updateFeature = useAppStore((s) => s.updateFeature);
  const removeFeature = useAppStore((s) => s.removeFeature);

  const commitName = (value: string) => {
    const name = value.trim();
    if (name) updateFeature(feature.id, { name });
    onEndEdit();
  };

  return (
    <div
      className={`feature-row${selected ? " selected" : ""}`}
      onClick={() => setSelectedFeatureId(feature.id)}
      style={{ display: "flex", alignItems: "center", gap: 6 }}
    >
      <span title={feature.kind} aria-label={feature.kind}>
        {KIND_GLYPHS[feature.kind]}
      </span>
      {editing ? (
        <input
          className="input"
          autoFocus
          defaultValue={feature.name}
          onClick={(e) => e.stopPropagation()}
          onBlur={(e) => commitName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitName(e.currentTarget.value);
            if (e.key === "Escape") onEndEdit();
          }}
          style={{ flex: 1, minWidth: 0 }}
        />
      ) : (
        <span
          style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onStartEdit();
          }}
          title={feature.name}
        >
          {feature.name}
        </span>
      )}
      <span
        title={feature.style.stroke}
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: feature.style.stroke,
          flexShrink: 0,
        }}
      />
      <button
        type="button"
        className="btn btn-ghost"
        title="Rename"
        onClick={(e) => {
          e.stopPropagation();
          onStartEdit();
        }}
      >
        ✎
      </button>
      <button
        type="button"
        className="btn btn-ghost"
        title="Zoom to feature"
        onClick={(e) => {
          e.stopPropagation();
          window.dispatchEvent(
            new CustomEvent("takpack:zoom-to", { detail: { id: feature.id } }),
          );
        }}
      >
        ⌖
      </button>
      <button
        type="button"
        className="btn btn-danger"
        title="Delete feature"
        onClick={(e) => {
          e.stopPropagation();
          removeFeature(feature.id);
        }}
      >
        ✕
      </button>
    </div>
  );
}

function FeatureEditor({ feature }: { feature: MapFeature }) {
  const updateFeature = useAppStore((s) => s.updateFeature);

  const patchStyle = (patch: Partial<MapFeature["style"]>) =>
    updateFeature(feature.id, { style: { ...feature.style, ...patch } });

  const setAffiliation = (a: Affiliation) =>
    updateFeature(feature.id, {
      affiliation: a,
      ...(feature.sidc ? { sidc: applyAffiliation(feature.sidc, a) } : {}),
    });

  const isArea = AREA_KINDS.includes(feature.kind);

  return (
    <div className="panel-section">
      <div className="label">SELECTED — {feature.kind.toUpperCase()}</div>

      <div className="panel-row">
        <label className="label" htmlFor="feat-name">
          NAME
        </label>
        <input
          id="feat-name"
          className="input"
          value={feature.name}
          onChange={(e) => updateFeature(feature.id, { name: e.target.value })}
        />
      </div>

      <div className="panel-row">
        <label className="label" htmlFor="feat-remarks">
          REMARKS
        </label>
        <textarea
          id="feat-remarks"
          className="input"
          rows={2}
          value={feature.remarks ?? ""}
          onChange={(e) =>
            updateFeature(feature.id, { remarks: e.target.value })
          }
        />
      </div>

      {feature.kind === "marker" && (
        <div className="panel-row" style={{ display: "flex", gap: 4, alignItems: "center" }}>
          <span className="label">AFFILIATION</span>
          {AFFILIATIONS.map((a) => {
            const active = (feature.affiliation ?? "friendly") === a.id;
            return (
              <button
                key={a.id}
                type="button"
                className={`tool-btn${active ? " active" : ""}`}
                title={a.id}
                style={{
                  color: a.color,
                  ...(active ? { borderColor: a.color } : {}),
                }}
                onClick={() => setAffiliation(a.id)}
              >
                {a.label}
              </button>
            );
          })}
        </div>
      )}

      <div className="panel-row" style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <label className="label" htmlFor="feat-stroke">
          STROKE
        </label>
        <input
          id="feat-stroke"
          type="color"
          value={feature.style.stroke}
          onChange={(e) => patchStyle({ stroke: e.target.value })}
        />
        <label className="label" htmlFor="feat-width">
          WIDTH {feature.style.strokeWidth}
        </label>
        <input
          id="feat-width"
          type="range"
          min={1}
          max={8}
          step={1}
          value={feature.style.strokeWidth}
          onChange={(e) => patchStyle({ strokeWidth: Number(e.target.value) })}
          style={{ flex: 1 }}
        />
      </div>

      {isArea && (
        <div className="panel-row" style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <label className="label" htmlFor="feat-fill">
            FILL
          </label>
          <input
            id="feat-fill"
            type="color"
            value={feature.style.fill ?? feature.style.stroke}
            onChange={(e) => patchStyle({ fill: e.target.value })}
          />
          <label className="label" htmlFor="feat-fill-op">
            OPACITY {Math.round((feature.style.fillOpacity ?? 0.2) * 100)}%
          </label>
          <input
            id="feat-fill-op"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={feature.style.fillOpacity ?? 0.2}
            onChange={(e) => patchStyle({ fillOpacity: Number(e.target.value) })}
            style={{ flex: 1 }}
          />
        </div>
      )}
    </div>
  );
}

export default function FeaturePanel() {
  const features = useAppStore((s) => s.features);
  const addFeature = useAppStore((s) => s.addFeature);
  const clearFeatures = useAppStore((s) => s.clearFeatures);
  const selectedFeatureId = useAppStore((s) => s.selectedFeatureId);
  const activeSidc = useAppStore((s) => s.activeSidc);
  const setActiveSidc = useAppStore((s) => s.setActiveSidc);
  const activeAffiliation = useAppStore((s) => s.activeAffiliation);
  const setTool = useAppStore((s) => s.setTool);

  const [openCategories, setOpenCategories] = useState<Record<string, boolean>>(
    () => ({ [SYMBOL_CATEGORIES[0]?.name ?? ""]: true }),
  );
  const [editingId, setEditingId] = useState<string | null>(null);

  const selected = features.find((f) => f.id === selectedFeatureId) ?? null;

  const pickSymbol = (sidc: string) => {
    setActiveSidc(applyAffiliation(sidc, activeAffiliation));
    setTool("marker");
  };

  const onImportFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const imported = featuresFromGeoJson(text, { sidc: activeSidc });
      imported.forEach(addFeature);
      alert(
        `Imported ${imported.length} feature${imported.length === 1 ? "" : "s"}.`,
      );
    } catch (err) {
      alert(
        `Import failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      input.value = "";
    }
  };

  return (
    <div className="panel">
      <div className="panel-header">ANNOTATE</div>

      <div className="panel-section">
        <div className="label">SYMBOL PALETTE</div>
        {SYMBOL_CATEGORIES.map((catDef) => {
          const open = !!openCategories[catDef.name];
          return (
            <div key={catDef.name}>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "100%", textAlign: "left" }}
                onClick={() =>
                  setOpenCategories((prev) => ({
                    ...prev,
                    [catDef.name]: !open,
                  }))
                }
              >
                {open ? "▾" : "▸"} {catDef.name}
              </button>
              {open && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(4, 1fr)",
                    gap: 4,
                  }}
                >
                  {catDef.symbols.map((sym) => {
                    const display = applyAffiliation(
                      sym.sidc,
                      activeAffiliation,
                    );
                    const active = sameSymbol(sym.sidc, activeSidc);
                    return (
                      <button
                        key={sym.sidc}
                        type="button"
                        className={`tool-btn${active ? " active" : ""}`}
                        title={sym.name}
                        onClick={() => pickSymbol(sym.sidc)}
                      >
                        <img
                          src={getSymbolDataUrl(display, 36)}
                          alt={sym.name}
                          style={{ maxWidth: "100%" }}
                        />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="panel-section">
        <div className="label">FEATURES ({features.length})</div>
        {features.length === 0 && (
          <div className="panel-row" style={{ opacity: 0.6 }}>
            Pick a tool and click the map to add features.
          </div>
        )}
        {features.map((f) => (
          <FeatureRow
            key={f.id}
            feature={f}
            selected={f.id === selectedFeatureId}
            editing={editingId === f.id}
            onStartEdit={() => setEditingId(f.id)}
            onEndEdit={() => setEditingId(null)}
          />
        ))}
      </div>

      {selected && <FeatureEditor feature={selected} />}

      <div className="panel-section">
        <div className="label">IMPORT GEOJSON</div>
        <input
          className="input"
          type="file"
          accept=".json,.geojson,application/geo+json,application/json"
          onChange={(e) => void onImportFile(e)}
        />
      </div>

      {features.length > 0 && (
        <div className="panel-section">
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => {
              if (confirm(`Delete all ${features.length} features?`)) {
                clearFeatures();
              }
            }}
          >
            CLEAR ALL
          </button>
        </div>
      )}
    </div>
  );
}
