import { create } from "zustand";
import type {
  Aoi,
  Affiliation,
  AppConfig,
  CommsPlan,
  JobRecord,
  MapFeature,
  NoteIconType,
  Position,
  SupportDocId,
  ToolType,
} from "../types";
import type { ProjectSnapshot } from "../lib/project-file";

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
  activeNoteIcon: NoteIconType;
  setActiveNoteIcon: (icon: NoteIconType) => void;

  // ── API keys (reactive mirror of localStorage takpack_key_*) ──
  keys: Record<string, string>;
  /** Persist a key to localStorage AND the store so consumers re-render. */
  setStoredKey: (keyId: string, value: string) => void;

  // ── features ──
  features: MapFeature[];
  addFeature: (f: MapFeature) => void;
  updateFeature: (id: string, patch: Partial<MapFeature>) => void;
  removeFeature: (id: string) => void;
  clearFeatures: () => void;
  selectedFeatureId: string | null;
  setSelectedFeatureId: (id: string | null) => void;
  /** Replace the whole working map from a loaded project file. */
  loadProject: (snapshot: ProjectSnapshot) => void;

  // ── comms / support pack ──
  supportDocIds: SupportDocId[];
  setSupportDocIds: (ids: SupportDocId[]) => void;
  commsPlan: CommsPlan;
  setCommsPlan: (patch: Partial<CommsPlan>) => void;
  includePref: boolean;
  setIncludePref: (v: boolean) => void;
  includeCasevacMarker: boolean;
  setIncludeCasevacMarker: (v: boolean) => void;

  // ── export ──
  exportOpen: boolean;
  setExportOpen: (open: boolean) => void;
  activeJob: JobRecord | null;
  setActiveJob: (j: JobRecord | null) => void;
}

const DEFAULT_SIDC = "SFGPU------ ----".replace(/\s/g, "");

// ── API key storage (localStorage, never sent anywhere except per-export) ──

const KEY_PREFIX = "takpack_key_";

function hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined";
}

/** Hydrate the reactive key slice from every takpack_key_* entry. */
function readStoredKeys(): Record<string, string> {
  const out: Record<string, string> = {};
  if (!hasLocalStorage()) return out;
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i);
    if (k && k.startsWith(KEY_PREFIX)) {
      out[k.slice(KEY_PREFIX.length)] = localStorage.getItem(k) ?? "";
    }
  }
  return out;
}

/** Imperative read for non-React callers; components should select s.keys. */
export function getStoredKey(keyId: string): string {
  if (!hasLocalStorage()) return "";
  return localStorage.getItem(`${KEY_PREFIX}${keyId}`) ?? "";
}

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
  activeNoteIcon: "pin",
  setActiveNoteIcon: (activeNoteIcon) => set({ activeNoteIcon }),

  keys: readStoredKeys(),
  setStoredKey: (keyId, value) => {
    if (hasLocalStorage()) {
      if (value) localStorage.setItem(`${KEY_PREFIX}${keyId}`, value);
      else localStorage.removeItem(`${KEY_PREFIX}${keyId}`);
    }
    set((s) => {
      const keys = { ...s.keys };
      if (value) keys[keyId] = value;
      else delete keys[keyId];
      return { keys };
    });
  },

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
  loadProject: (snapshot) =>
    set({
      center: snapshot.view.center,
      zoom: snapshot.view.zoom,
      basemapId: snapshot.view.basemapId,
      aoi: snapshot.aoi,
      features: snapshot.features,
      selectedFeatureId: null,
      commsPlan: snapshot.commsPlan,
      supportDocIds: snapshot.supportDocIds,
      includePref: snapshot.includePref,
      includeCasevacMarker: snapshot.includeCasevacMarker,
      tool: "select",
      draftPoints: [],
    }),

  supportDocIds: ["comms", "pace", "medevac", "checklist"],
  setSupportDocIds: (supportDocIds) => set({ supportDocIds }),
  commsPlan: {
    nets: [],
    pace: { primary: "", alternate: "", contingency: "", emergency: "" },
    identity: {},
    medevac: {},
    notes: "",
  },
  setCommsPlan: (patch) =>
    set((s) => ({ commsPlan: { ...s.commsPlan, ...patch } })),
  includePref: false,
  setIncludePref: (includePref) => set({ includePref }),
  includeCasevacMarker: false,
  setIncludeCasevacMarker: (includeCasevacMarker) =>
    set({ includeCasevacMarker }),

  exportOpen: false,
  setExportOpen: (exportOpen) => set({ exportOpen }),
  activeJob: null,
  setActiveJob: (activeJob) => set({ activeJob }),
}));
