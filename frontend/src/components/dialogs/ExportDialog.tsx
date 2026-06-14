import { useEffect, useMemo, useState } from "react";
import { useAppStore } from "../../store/use-app-store";
import { getJob, jobDownloadUrl, startExport } from "../../lib/api";
import {
  countTilesForAoi,
  estimatePackageBytes,
  formatBytes,
} from "../../lib/estimate";
import type {
  Aoi,
  ExportRequest,
  FeatureKind,
  Geometry,
  ImageryExportMode,
  ImagerySourceDef,
  JobRecord,
  MapFeature,
  Position,
} from "../../types";

/**
 * Export modal: builds an ExportRequest, starts the job, polls it every 1.5 s
 * and renders progress / warnings / the download link.
 */

type DialogMode = ImageryExportMode | "none";

function defaultPackageName(): string {
  const d = new Date();
  const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  return `TAKPack-${ymd}`;
}

function sanitizeName(raw: string): string {
  return raw.replace(/[^A-Za-z0-9 _-]/g, "");
}

function positionsOf(g: Geometry): Position[] {
  switch (g.type) {
    case "Point":
      return [g.coordinates];
    case "LineString":
      return g.coordinates;
    case "Polygon":
      return g.coordinates.flat();
  }
}

/** Fallback request AOI when only annotations exist (server requires an AOI). */
function aoiFromFeatures(features: MapFeature[]): Aoi | null {
  let north = -90;
  let south = 90;
  let east = -180;
  let west = 180;
  let any = false;
  for (const f of features) {
    for (const [lon, lat] of positionsOf(f.geometry)) {
      any = true;
      north = Math.max(north, lat);
      south = Math.min(south, lat);
      east = Math.max(east, lon);
      west = Math.min(west, lon);
    }
  }
  if (!any) return null;
  const pad = 0.002;
  return {
    north: north + pad,
    south: south - pad,
    east: east + pad,
    west: west - pad,
  };
}

function defaultZooms(src: ImagerySourceDef): { min: number; max: number } {
  const max = Math.min(src.maxZoom, 16);
  const min = Math.min(max, Math.max(src.minZoom, Math.max(8, max - 6)));
  return { min, max };
}

const KIND_LABELS: Record<FeatureKind, string> = {
  marker: "marker",
  label: "label",
  line: "line",
  route: "route",
  polygon: "polygon",
  rectangle: "rectangle",
  circle: "circle",
};

function featureSummary(features: MapFeature[]): string {
  if (features.length === 0) return "No features";
  const counts = new Map<FeatureKind, number>();
  for (const f of features) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return [...counts.entries()]
    .map(([kind, n]) => `${n} ${KIND_LABELS[kind]}${n === 1 ? "" : "s"}`)
    .join(" · ");
}

export default function ExportDialog() {
  const config = useAppStore((s) => s.config);
  const aoi = useAppStore((s) => s.aoi);
  const features = useAppStore((s) => s.features);
  const keys = useAppStore((s) => s.keys);
  const setExportOpen = useAppStore((s) => s.setExportOpen);
  const setActiveJob = useAppStore((s) => s.setActiveJob);

  const offlineSources = useMemo(
    () => (config?.sources ?? []).filter((s) => !s.streamOnly),
    [config],
  );
  const streamSources = useMemo(
    () => (config?.sources ?? []).filter((s) => s.streamOnly),
    [config],
  );
  const limits = config?.limits ?? null;

  // ── form state ──
  const [packageName, setPackageName] = useState(defaultPackageName);
  const [mode, setMode] = useState<DialogMode>(aoi ? "gpkg" : "none");
  const [sourceId, setSourceId] = useState<string>(
    () => offlineSources[0]?.id ?? "",
  );
  const [minZ, setMinZ] = useState(8);
  const [maxZ, setMaxZ] = useState(14);
  const [tileFormat, setTileFormat] = useState<"jpeg" | "png">("jpeg");
  const [planConfirmed, setPlanConfirmed] = useState(false);
  const [mapSourceXmlIds, setMapSourceXmlIds] = useState<string[]>([]);
  const [includeKmlOverlay, setIncludeKmlOverlay] = useState(true);

  // ── job state ──
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [job, setJob] = useState<JobRecord | null>(null);

  const source =
    offlineSources.find((s) => s.id === sourceId) ?? offlineSources[0] ?? null;

  // Default the source once config arrives, and re-clamp zooms per source.
  useEffect(() => {
    if (!sourceId && offlineSources.length > 0) {
      setSourceId(offlineSources[0].id);
    }
  }, [sourceId, offlineSources]);

  useEffect(() => {
    if (!source) return;
    const z = defaultZooms(source);
    setMinZ(z.min);
    setMaxZ(z.max);
    setTileFormat(source.defaultTileFormat);
    setPlanConfirmed(false);
  }, [source?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Esc closes (the job keeps running server-side; activeJob stays in store).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExportOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setExportOpen]);

  // Poll the job every 1.5 s; transient fetch errors are ignored.
  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = setInterval(
      () => void poll(),
      1500,
    );
    async function poll() {
      try {
        const j = await getJob(jobId as string);
        if (cancelled) return;
        setJob(j);
        setActiveJob(j);
        if ((j.status === "completed" || j.status === "failed") && timer) {
          clearInterval(timer);
          timer = null;
        }
      } catch {
        // transient poll failure — keep the interval running
      }
    }
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [jobId, setActiveJob]);

  // ── derived ──
  const imageryActive = mode !== "none" && aoi !== null && source !== null;
  const storedKey = source?.keyId ? keys[source.keyId] ?? "" : "";
  const missingKey = imageryActive && !!source?.keyId && !storedKey;
  const needsPlanCheck = imageryActive && !!source?.offlineRequiresPlanCheck;

  const tileCount =
    imageryActive && mode === "gpkg" && aoi
      ? countTilesForAoi(aoi, minZ, maxZ)
      : 0;
  const estBytes = estimatePackageBytes(tileCount, tileFormat);
  const overTileLimit =
    limits !== null && mode === "gpkg" && tileCount > limits.maxTilesPerExport;
  const overSizeLimit =
    limits !== null &&
    mode === "gpkg" &&
    estBytes > limits.recommendedMaxPackageBytes;

  const effectiveAoi = aoi ?? aoiFromFeatures(features);
  const lineCount = features.filter((f) => f.kind === "line").length;

  const canSubmit =
    !submitting &&
    jobId === null &&
    packageName.trim().length > 0 &&
    effectiveAoi !== null &&
    (!imageryActive ||
      (!missingKey && (!needsPlanCheck || planConfirmed) && !overTileLimit));

  const handleSubmit = async () => {
    if (!effectiveAoi) return;
    const req: ExportRequest = {
      packageName: packageName.trim(),
      aoi: effectiveAoi,
      features,
      mapSourceXmlIds,
      includeKmlOverlay,
    };
    if (mode !== "none" && aoi && source) {
      req.imagery = {
        sourceId: source.id,
        mode,
        minZoom: minZ,
        maxZoom: maxZ,
        tileFormat,
        ...(storedKey ? { apiKey: storedKey } : {}),
        ...(source.offlineRequiresPlanCheck ? { planConfirmed } : {}),
      };
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await startExport(req);
      setJobId(res.jobId);
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const toggleXmlId = (id: string) =>
    setMapSourceXmlIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );

  const percent = Math.max(0, Math.min(100, job?.progress.percent ?? 0));

  return (
    <div
      className="dialog-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) setExportOpen(false);
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true">
        <div
          className="dialog-header"
          style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}
        >
          <span>EXPORT PACKAGE</span>
          <button
            type="button"
            className="btn btn-ghost"
            title="Close"
            onClick={() => setExportOpen(false)}
          >
            ✕
          </button>
        </div>

        <div className="dialog-body">
          {jobId === null ? (
            <>
              <div className="panel-section">
                <label className="label" htmlFor="pkg-name">
                  PACKAGE NAME
                </label>
                <input
                  id="pkg-name"
                  className="input"
                  value={packageName}
                  onChange={(e) => setPackageName(sanitizeName(e.target.value))}
                />
              </div>

              <div className="panel-section">
                <div className="label">AOI</div>
                {aoi ? (
                  <div className="panel-row">
                    {aoi.south.toFixed(4)}, {aoi.west.toFixed(4)} →{" "}
                    {aoi.north.toFixed(4)}, {aoi.east.toFixed(4)}
                  </div>
                ) : (
                  <div className="warning-text">
                    Draw an AOI to include imagery.
                  </div>
                )}
              </div>

              <div className="panel-section">
                <div className="label">IMAGERY</div>
                {(
                  [
                    ["gpkg", "Offline tile pyramid (recommended)"],
                    ["kmz-grg", "Single rectified image (small AOI)"],
                    ["none", "No imagery"],
                  ] as const
                ).map(([m, label]) => (
                  <label
                    key={m}
                    className="panel-row"
                    style={{ display: "flex", alignItems: "center", gap: 6 }}
                  >
                    <input
                      type="radio"
                      name="imagery-mode"
                      checked={mode === m}
                      disabled={m !== "none" && (!aoi || offlineSources.length === 0)}
                      onChange={() => setMode(m)}
                    />
                    {label}
                  </label>
                ))}

                {mode !== "none" && source && aoi && (
                  <>
                    <div className="panel-row">
                      <label className="label" htmlFor="imagery-source">
                        SOURCE
                      </label>
                      <select
                        id="imagery-source"
                        className="select"
                        value={source.id}
                        onChange={(e) => setSourceId(e.target.value)}
                      >
                        {offlineSources.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name} (z{s.minZoom}–{s.maxZoom})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div className="panel-row">
                      <span className="label">
                        ZOOM {minZ} – {maxZ}
                      </span>
                    </div>
                    <div
                      className="panel-row"
                      style={{ display: "flex", gap: 6 }}
                    >
                      <input
                        type="range"
                        min={source.minZoom}
                        max={source.maxZoom}
                        step={1}
                        value={minZ}
                        title={`Min zoom ${minZ}`}
                        onChange={(e) =>
                          setMinZ(Math.min(Number(e.target.value), maxZ))
                        }
                        style={{ flex: 1 }}
                      />
                      <input
                        type="range"
                        min={source.minZoom}
                        max={source.maxZoom}
                        step={1}
                        value={maxZ}
                        title={`Max zoom ${maxZ}`}
                        onChange={(e) =>
                          setMaxZ(Math.max(Number(e.target.value), minZ))
                        }
                        style={{ flex: 1 }}
                      />
                    </div>

                    <div className="panel-row">
                      <label className="label" htmlFor="tile-format">
                        TILE FORMAT
                      </label>
                      <select
                        id="tile-format"
                        className="select"
                        value={tileFormat}
                        onChange={(e) =>
                          setTileFormat(e.target.value as "jpeg" | "png")
                        }
                      >
                        <option value="jpeg">JPEG (smaller)</option>
                        <option value="png">PNG (lossless)</option>
                      </select>
                    </div>

                    {mode === "gpkg" && (
                      <div className="panel-row">
                        ~{tileCount.toLocaleString()} tiles ·{" "}
                        {formatBytes(estBytes)} estimated
                      </div>
                    )}
                    {overTileLimit && limits && (
                      <div className="warning-text" style={{ color: "#ef4444" }}>
                        Tile count exceeds server limit (
                        {limits.maxTilesPerExport.toLocaleString()}) — reduce
                        the zoom range or AOI.
                      </div>
                    )}
                    {!overTileLimit && overSizeLimit && limits && (
                      <div className="warning-text">
                        Estimated size exceeds{" "}
                        {formatBytes(limits.recommendedMaxPackageBytes)} —
                        consider sideloading the .gpkg separately.
                      </div>
                    )}

                    {needsPlanCheck && (
                      <label
                        className="panel-row"
                        style={{ display: "flex", alignItems: "center", gap: 6 }}
                      >
                        <input
                          type="checkbox"
                          checked={planConfirmed}
                          onChange={(e) => setPlanConfirmed(e.target.checked)}
                        />
                        My plan permits offline use of this source (required)
                      </label>
                    )}

                    {missingKey && (
                      <div className="error-text">
                        {source.keyLabel ?? "API key"} required — add your key
                        in the Imagery panel.
                      </div>
                    )}
                  </>
                )}
              </div>

              {streamSources.length > 0 && (
                <div className="panel-section">
                  <div className="label">STREAMING MAP SOURCE XML</div>
                  {streamSources.map((s) => (
                    <label
                      key={s.id}
                      className="panel-row"
                      style={{ display: "flex", alignItems: "center", gap: 6 }}
                    >
                      <input
                        type="checkbox"
                        checked={mapSourceXmlIds.includes(s.id)}
                        onChange={() => toggleXmlId(s.id)}
                      />
                      {s.name} <span className="chip">stream-only</span>
                    </label>
                  ))}
                </div>
              )}

              <div className="panel-section">
                <label
                  className="panel-row"
                  style={{ display: "flex", alignItems: "center", gap: 6 }}
                >
                  <input
                    type="checkbox"
                    checked={includeKmlOverlay}
                    onChange={(e) => setIncludeKmlOverlay(e.target.checked)}
                  />
                  Include KML overlay of annotations
                </label>
              </div>

              <div className="panel-section">
                <div className="label">FEATURES</div>
                <div className="panel-row">{featureSummary(features)}</div>
                {lineCount > 0 && (
                  <div className="warning-text" style={{ opacity: 0.85 }}>
                    Dashed / dotted styling renders on ATAK 4.5.1+; the KML
                    overlay is always solid.
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="panel-section">
              <div className="label">
                {(job?.status ?? "queued").toUpperCase()}
              </div>
              <div className="progress-bar">
                <div
                  className="progress-bar-fill"
                  style={{
                    width: `${percent}%`,
                    height: "100%",
                    background: "currentColor",
                  }}
                />
              </div>
              <div className="panel-row">
                {job?.progress.phase ?? "queued"} — {percent}%
                {job?.progress.message ? ` · ${job.progress.message}` : ""}
              </div>
              {(job?.warnings ?? []).map((w, i) => (
                <div key={i} className="warning-text">
                  {w}
                </div>
              ))}
              {job?.status === "failed" && (
                <div className="error-text">
                  {job.error ?? "Export failed."}
                </div>
              )}
              {job?.status === "completed" && (
                <>
                  <a
                    className="btn btn-primary"
                    href={jobDownloadUrl(jobId)}
                    download
                  >
                    DOWNLOAD {job.artifactName ?? "package.zip"} (
                    {formatBytes(job.sizeBytes ?? 0)})
                  </a>
                  <p className="panel-row" style={{ opacity: 0.75 }}>
                    Validate on device — see docs/atak-validation.md for the
                    ATAK import checklist.
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        <div
          className="dialog-footer"
          style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}
        >
          {submitError && <span className="error-text">{submitError}</span>}
          {jobId === null ? (
            <>
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => setExportOpen(false)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!canSubmit}
                onClick={() => void handleSubmit()}
              >
                {submitting ? "STARTING…" : "BUILD PACKAGE"}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-ghost"
              onClick={() => setExportOpen(false)}
            >
              {job?.status === "completed" || job?.status === "failed"
                ? "Close"
                : "Close (export continues)"}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
