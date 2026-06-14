import type {
  Aoi,
  CommsPlan,
  FeatureKind,
  MapFeature,
  Position,
  SupportDocId,
} from "../types";

/**
 * Project file (.takproj.json) — a portable snapshot of the whole working map
 * so a session can be saved to disk and reloaded later WITHOUT a login or
 * server-side storage. Deliberately excludes API keys (those live only in this
 * browser's localStorage and must never travel in a shareable file).
 */

export const PROJECT_FORMAT = "takpack-studio-project";
export const PROJECT_VERSION = 1;

export interface ProjectSnapshot {
  view: { center: Position; zoom: number; basemapId: string };
  aoi: Aoi | null;
  features: MapFeature[];
  commsPlan: CommsPlan;
  supportDocIds: SupportDocId[];
  includePref: boolean;
  includeCasevacMarker: boolean;
}

interface ProjectFile extends ProjectSnapshot {
  format: typeof PROJECT_FORMAT;
  version: number;
  savedAt: string;
}

const FEATURE_KINDS: FeatureKind[] = [
  "marker",
  "label",
  "line",
  "route",
  "polygon",
  "rectangle",
  "circle",
];
const SUPPORT_DOC_IDS: SupportDocId[] = ["comms", "pace", "medevac", "checklist"];
const GEOMETRY_TYPES = ["Point", "LineString", "Polygon"];

/** Serialize the current project to a downloadable JSON string. */
export function serializeProject(
  snapshot: ProjectSnapshot,
  now: Date = new Date(),
): string {
  const file: ProjectFile = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    savedAt: now.toISOString(),
    ...snapshot,
  };
  return JSON.stringify(file, null, 2);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPosition(v: unknown): v is Position {
  return (
    Array.isArray(v) &&
    v.length === 2 &&
    typeof v[0] === "number" &&
    typeof v[1] === "number" &&
    Math.abs(v[0]) <= 180 &&
    Math.abs(v[1]) <= 90
  );
}

/** Structural guard — keeps a corrupt entry from crashing the map renderer. */
function isMapFeature(v: unknown): v is MapFeature {
  if (!isObject(v)) return false;
  if (typeof v.id !== "string" || typeof v.name !== "string") return false;
  if (!FEATURE_KINDS.includes(v.kind as FeatureKind)) return false;
  if (!isObject(v.geometry)) return false;
  if (!GEOMETRY_TYPES.includes(v.geometry.type as string)) return false;
  if (!("coordinates" in v.geometry)) return false;
  if (!isObject(v.style) || typeof v.style.stroke !== "string") return false;
  return true;
}

function coerceAoi(v: unknown): Aoi | null {
  if (!isObject(v)) return null;
  const { north, south, east, west } = v;
  if (
    typeof north === "number" &&
    typeof south === "number" &&
    typeof east === "number" &&
    typeof west === "number"
  ) {
    return { north, south, east, west };
  }
  return null;
}

function coerceCommsPlan(v: unknown): CommsPlan {
  return isObject(v) ? (v as CommsPlan) : {};
}

export interface ParsedProject {
  snapshot: ProjectSnapshot;
  warnings: string[];
}

/**
 * Parse + validate a project file. Throws on a file that isn't a usable
 * TAKPack project; drops individual malformed features with a warning so one
 * bad entry can't sink an otherwise-good load.
 */
export function parseProjectFile(text: string): ParsedProject {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Not a valid JSON file.");
  }
  if (!isObject(raw) || raw.format !== PROJECT_FORMAT) {
    throw new Error("Not a TAKPack Studio project file.");
  }
  if (typeof raw.version === "number" && raw.version > PROJECT_VERSION) {
    throw new Error(
      `This project was saved by a newer version (v${String(raw.version)}). Update TAKPack Studio to open it.`,
    );
  }

  const warnings: string[] = [];

  const featuresRaw = Array.isArray(raw.features) ? raw.features : [];
  const features = featuresRaw.filter(isMapFeature);
  if (features.length < featuresRaw.length) {
    warnings.push(
      `Skipped ${String(featuresRaw.length - features.length)} unreadable feature(s).`,
    );
  }

  const view = isObject(raw.view) ? raw.view : {};
  const center = isPosition(view.center) ? view.center : ([-111.891, 40.761] as Position);
  const zoom = typeof view.zoom === "number" ? view.zoom : 12;
  const basemapId = typeof view.basemapId === "string" ? view.basemapId : "osm";

  const supportDocIds = (
    Array.isArray(raw.supportDocIds) ? raw.supportDocIds : []
  ).filter((id): id is SupportDocId =>
    SUPPORT_DOC_IDS.includes(id as SupportDocId),
  );

  return {
    snapshot: {
      view: { center, zoom, basemapId },
      aoi: coerceAoi(raw.aoi),
      features,
      commsPlan: coerceCommsPlan(raw.commsPlan),
      supportDocIds,
      includePref: raw.includePref === true,
      includeCasevacMarker: raw.includeCasevacMarker === true,
    },
    warnings,
  };
}

/** Filename-safe project name → "<name>.takproj.json". */
export function projectFileName(name: string): string {
  const base =
    name.trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") ||
    "takpack-project";
  return `${base}.takproj.json`;
}
