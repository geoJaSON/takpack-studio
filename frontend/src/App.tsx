import { useEffect, useRef, useState } from "react";
import { useAppStore } from "./store/use-app-store";
import { getConfig } from "./lib/api";
import { parseCoordinateInput } from "./lib/coordinates";
import { formatMgrs } from "./lib/mgrs-format";
import {
  parseProjectFile,
  projectFileName,
  serializeProject,
} from "./lib/project-file";
import type { Position } from "./types";
import MapCanvas from "./components/map/MapCanvas";
import AnnotationToolbar from "./components/toolbar/AnnotationToolbar";
import ImageryPanel from "./components/panels/ImageryPanel";
import FeaturePanel from "./components/panels/FeaturePanel";
import ExportDialog from "./components/dialogs/ExportDialog";
import HelpDialog from "./components/dialogs/HelpDialog";

interface ProjectMessage {
  kind: "ok" | "warn" | "error";
  text: string;
}

export default function App() {
  const setConfig = useAppStore((s) => s.setConfig);
  const mousePos = useAppStore((s) => s.mousePos);
  const aoi = useAppStore((s) => s.aoi);
  const features = useAppStore((s) => s.features);
  const loadProject = useAppStore((s) => s.loadProject);
  const exportOpen = useAppStore((s) => s.exportOpen);
  const setExportOpen = useAppStore((s) => s.setExportOpen);
  const [coordInput, setCoordInput] = useState("");
  const [coordError, setCoordError] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [projectMsg, setProjectMsg] = useState<ProjectMessage | null>(null);
  const [mobileDrawer, setMobileDrawer] = useState<
    "imagery" | "features" | null
  >(null);
  const loadInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch((err) => console.error("config load failed", err));
  }, [setConfig]);

  const saveProject = () => {
    const s = useAppStore.getState();
    const json = serializeProject({
      view: { center: s.center, zoom: s.zoom, basemapId: s.basemapId },
      aoi: s.aoi,
      features: s.features,
      commsPlan: s.commsPlan,
      supportDocIds: s.supportDocIds,
      includePref: s.includePref,
      includeCasevacMarker: s.includeCasevacMarker,
    });
    const url = URL.createObjectURL(
      new Blob([json], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = projectFileName("takpack-project");
    a.click();
    URL.revokeObjectURL(url);
    setProjectMsg({ kind: "ok", text: "Project saved." });
  };

  const loadProjectFile = async (file: File) => {
    setProjectMsg(null);
    try {
      const { snapshot, warnings } = parseProjectFile(await file.text());
      loadProject(snapshot);
      window.dispatchEvent(
        new CustomEvent("takpack:set-view", {
          detail: { center: snapshot.view.center, zoom: snapshot.view.zoom },
        }),
      );
      setProjectMsg({
        kind: warnings.length > 0 ? "warn" : "ok",
        text:
          `Loaded ${String(snapshot.features.length)} feature(s).` +
          (warnings.length > 0 ? ` ${warnings.join(" ")}` : ""),
      });
    } catch (err) {
      setProjectMsg({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const onLoadInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-loading the same file
    if (!file) return;
    if (
      features.length > 0 &&
      !window.confirm(
        "Loading a project replaces your current map and comms setup. Continue?",
      )
    ) {
      return;
    }
    void loadProjectFile(file);
  };

  const currentMgrs = mousePos ? formatMgrs(mousePos.lat, mousePos.lon) : "";

  const parseEnteredCoordinate = (): Position | null => {
    const parsed = parseCoordinateInput(coordInput.trim() || currentMgrs);
    setCoordError(parsed === null);
    return parsed;
  };

  const goToCoordinate = () => {
    const position = parseEnteredCoordinate();
    if (!position) return;
    setCoordInput(formatMgrs(position[1], position[0]));
    window.dispatchEvent(
      new CustomEvent("takpack:go-to-coordinate", { detail: { position } }),
    );
  };

  const addCoordinatePoint = () => {
    const position = parseEnteredCoordinate();
    if (!position) return;
    setCoordInput(formatMgrs(position[1], position[0]));
    window.dispatchEvent(
      new CustomEvent("takpack:add-coordinate-point", { detail: { position } }),
    );
  };

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">
          <span className="app-title-main">TAKPACK</span>
          <span className="app-title-sub">STUDIO</span>
        </div>
        <div className="mobile-drawer-toggles mobile-only">
          <button
            type="button"
            className="btn btn-ghost drawer-toggle"
            data-active={mobileDrawer === "imagery"}
            onClick={() =>
              setMobileDrawer((d) => (d === "imagery" ? null : "imagery"))
            }
          >
            IMAGERY
          </button>
          <button
            type="button"
            className="btn btn-ghost drawer-toggle"
            data-active={mobileDrawer === "features"}
            onClick={() =>
              setMobileDrawer((d) => (d === "features" ? null : "features"))
            }
          >
            FEATURES
          </button>
        </div>
        <div className="header-status">
          <span className="status-chip" data-active={aoi !== null}>
            {aoi ? "AOI SET" : "NO AOI"}
          </span>
          <span className="status-chip">{features.length} FEATURES</span>
          <form
            className="coord-entry"
            onSubmit={(e) => {
              e.preventDefault();
              goToCoordinate();
            }}
          >
            <input
              className={`mgrs-readout${coordError ? " invalid" : ""}`}
              value={coordInput}
              onChange={(e) => {
                setCoordInput(e.target.value);
                setCoordError(false);
              }}
              placeholder={currentMgrs || "MGRS or lat, lon"}
              title="Enter MGRS or decimal lat, lon, then press Enter"
            />
            <button className="btn btn-ghost coord-btn" type="submit">
              GO
            </button>
            <button
              className="btn btn-ghost coord-btn"
              type="button"
              onClick={addCoordinatePoint}
              title="Add coordinate point"
            >
              + PT
            </button>
          </form>
        </div>
        <div className="header-actions">
          <button
            className="btn btn-ghost"
            onClick={saveProject}
            disabled={features.length === 0 && aoi === null}
            title="Download a project file of the current map + comms setup"
          >
            SAVE
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => loadInputRef.current?.click()}
            title="Load a saved project file"
          >
            LOAD
          </button>
          <button
            className="btn btn-ghost"
            onClick={() => setHelpOpen(true)}
            title="Help & instructions"
            aria-label="Help"
          >
            ?
          </button>
          <input
            ref={loadInputRef}
            type="file"
            accept=".json,.takproj.json,application/json"
            style={{ display: "none" }}
            onChange={onLoadInput}
          />
          <button
            className="btn btn-primary export-btn"
            onClick={() => {
              setMobileDrawer(null);
              setExportOpen(true);
            }}
            disabled={aoi === null && features.length === 0}
          >
            EXPORT<span className="label-pkg"> PACKAGE</span>
          </button>
        </div>
      </header>

      {projectMsg && (
        <div
          className={`project-toast project-toast-${projectMsg.kind}`}
          role="status"
          onClick={() => setProjectMsg(null)}
          title="Dismiss"
        >
          {projectMsg.text}
        </div>
      )}

      <div className="app-body">
        <aside
          className={`sidebar sidebar-left${
            mobileDrawer === "imagery" ? " open" : ""
          }`}
        >
          <ImageryPanel />
        </aside>

        <main className="map-area">
          <MapCanvas />
          <AnnotationToolbar />
        </main>

        <aside
          className={`sidebar sidebar-right${
            mobileDrawer === "features" ? " open" : ""
          }`}
        >
          <FeaturePanel />
        </aside>

        {mobileDrawer && (
          <div
            className="mobile-scrim"
            onClick={() => setMobileDrawer(null)}
            aria-hidden="true"
          />
        )}
      </div>

      {exportOpen && <ExportDialog />}
      {helpOpen && <HelpDialog onClose={() => setHelpOpen(false)} />}
    </div>
  );
}
