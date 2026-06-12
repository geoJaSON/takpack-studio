import { create } from "zustand";
import type {
  Aoi,
  Affiliation,
  AppConfig,
  JobRecord,
  MapFeature,
  Position,
  ToolType,
} from "../types";

/**
 * Single Zustand store for all app state. Components read slices; the
 * MapController in MapCanvas drives the tool state machine.
 */
export interface AppState {
  // ── map view ──
  center: Position; // [lon, lat]
  zoom: number;
  setView: (center: Position, zoom: number) => void;
  /** Throttled cursor position for the MGRS readout (null off-map). */
  mousePos: { lat: number; lon: number } | null;
  setMousePos: (p: { lat: number; lon: number } | null) => void;

  // ── basemap & imagery preview ──
  basemapId: string;
  setBasemapId: (id: string) => void;
  previewSourceId: string | null;
  setPreviewSourceId: (id: string | null) => void;
  previewOpacity: number; // 0..1
  setPreviewOpacity: (o: number) => void;

  // ── server config ──
  config: AppConfig | null;
  setConfig: (c: AppConfig) => void;

  // ── AOI ──
  aoi: Aoi | null;
  setAoi: (aoi: Aoi | null) => void;

  // ── tool state machine ──
  tool: ToolType;
  setTool: (t: ToolType) => void;
  /** In-progress drawing vertices ([lon, lat]). */
  draftPoints: Position[];
  pushDraftPoint: (p: Position) => void;
  popDraftPoint: () => void;
  clearDraft: () => void;

  // ── marker palette ──
  activeSidc: string;
  setActiveSidc: (sidc: string) => void;
  activeAffiliation: Affiliation;
  setActiveAffiliation: (a: Affiliation) => void;

  // ── features ──
  features: MapFeature[];
  addFeature: (f: MapFeature) => void;
  updateFeature: (id: string, patch: Partial<MapFeature>) => void;
  removeFeature: (id: string) => void;
  clearFeatures: () => void;
  selectedFeatureId: string | null;
  setSelectedFeatureId: (id: string | null) => void;

  // ── export ──
  exportOpen: boolean;
  setExportOpen: (open: boolean) => void;
  activeJob: JobRecord | null;
  setActiveJob: (j: JobRecord | null) => void;
}

const DEFAULT_SIDC = "SFGPU------ ----".replace(/\s/g, "");

export const useAppStore = create<AppState>((set) => ({
  center: [-111.891, 40.761],
  zoom: 12,
  setView: (center, zoom) => set({ center, zoom }),
  mousePos: null,
  setMousePos: (mousePos) => set({ mousePos }),

  basemapId: "osm",
  setBasemapId: (basemapId) => set({ basemapId }),
  previewSourceId: null,
  setPreviewSourceId: (previewSourceId) => set({ previewSourceId }),
  previewOpacity: 0.8,
  setPreviewOpacity: (previewOpacity) => set({ previewOpacity }),

  config: null,
  setConfig: (config) => set({ config }),

  aoi: null,
  setAoi: (aoi) => set({ aoi }),

  tool: "select",
  setTool: (tool) => set({ tool, draftPoints: [] }),
  draftPoints: [],
  pushDraftPoint: (p) =>
    set((s) => ({ draftPoints: [...s.draftPoints, p] })),
  popDraftPoint: () =>
    set((s) => ({ draftPoints: s.draftPoints.slice(0, -1) })),
  clearDraft: () => set({ draftPoints: [] }),

  activeSidc: DEFAULT_SIDC,
  setActiveSidc: (activeSidc) => set({ activeSidc }),
  activeAffiliation: "friendly",
  setActiveAffiliation: (activeAffiliation) => set({ activeAffiliation }),

  features: [],
  addFeature: (f) => set((s) => ({ features: [...s.features, f] })),
  updateFeature: (id, patch) =>
    set((s) => ({
      features: s.features.map((f) => (f.id === id ? { ...f, ...patch } : f)),
    })),
  removeFeature: (id) =>
    set((s) => ({
      features: s.features.filter((f) => f.id !== id),
      selectedFeatureId:
        s.selectedFeatureId === id ? null : s.selectedFeatureId,
    })),
  clearFeatures: () => set({ features: [], selectedFeatureId: null }),
  selectedFeatureId: null,
  setSelectedFeatureId: (selectedFeatureId) => set({ selectedFeatureId }),

  exportOpen: false,
  setExportOpen: (exportOpen) => set({ exportOpen }),
  activeJob: null,
  setActiveJob: (activeJob) => set({ activeJob }),
}));

// ── API key storage (localStorage, never sent anywhere except per-export) ──

export function getStoredKey(keyId: string): string {
  return localStorage.getItem(`takpack_key_${keyId}`) ?? "";
}

export function setStoredKey(keyId: string, value: string): void {
  if (value) localStorage.setItem(`takpack_key_${keyId}`, value);
  else localStorage.removeItem(`takpack_key_${keyId}`);
}
