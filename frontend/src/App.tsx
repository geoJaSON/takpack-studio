import { useEffect } from "react";
import { useAppStore } from "./store/use-app-store";
import { getConfig } from "./lib/api";
import { formatMgrs } from "./lib/mgrs-format";
import MapCanvas from "./components/map/MapCanvas";
import AnnotationToolbar from "./components/toolbar/AnnotationToolbar";
import ImageryPanel from "./components/panels/ImageryPanel";
import FeaturePanel from "./components/panels/FeaturePanel";
import ExportDialog from "./components/dialogs/ExportDialog";

export default function App() {
  const setConfig = useAppStore((s) => s.setConfig);
  const mousePos = useAppStore((s) => s.mousePos);
  const aoi = useAppStore((s) => s.aoi);
  const features = useAppStore((s) => s.features);
  const exportOpen = useAppStore((s) => s.exportOpen);
  const setExportOpen = useAppStore((s) => s.setExportOpen);

  useEffect(() => {
    getConfig()
      .then(setConfig)
      .catch((err) => console.error("config load failed", err));
  }, [setConfig]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-title">
          <span className="app-title-main">TAKPACK</span>
          <span className="app-title-sub">STUDIO</span>
        </div>
        <div className="header-status">
          <span className="status-chip" data-active={aoi !== null}>
            {aoi ? "AOI SET" : "NO AOI"}
          </span>
          <span className="status-chip">{features.length} FEATURES</span>
          <span className="mgrs-readout">
            {mousePos ? formatMgrs(mousePos.lat, mousePos.lon) : "——"}
          </span>
        </div>
        <button
          className="btn btn-primary export-btn"
          onClick={() => setExportOpen(true)}
          disabled={aoi === null && features.length === 0}
        >
          EXPORT PACKAGE
        </button>
      </header>

      <div className="app-body">
        <aside className="sidebar sidebar-left">
          <ImageryPanel />
        </aside>

        <main className="map-area">
          <MapCanvas />
          <AnnotationToolbar />
        </main>

        <aside className="sidebar sidebar-right">
          <FeaturePanel />
        </aside>
      </div>

      {exportOpen && <ExportDialog />}
    </div>
  );
}
