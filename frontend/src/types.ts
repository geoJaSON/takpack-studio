/**
 * Frontend mirror of the server domain contracts (server/src/types.ts).
 * Keep in sync — these shapes cross the HTTP boundary verbatim.
 */

export interface Aoi {
  north: number;
  south: number;
  east: number;
  west: number;
}

export type Position = [number, number];

export interface PointGeometry {
  type: "Point";
  coordinates: Position;
}
export interface LineStringGeometry {
  type: "LineString";
  coordinates: Position[];
}
export interface PolygonGeometry {
  type: "Polygon";
  coordinates: Position[][];
}
export type Geometry = PointGeometry | LineStringGeometry | PolygonGeometry;

export type Affiliation = "friendly" | "hostile" | "neutral" | "unknown";

export type FeatureKind =
  | "marker"
  | "label"
  | "line"
  | "route"
  | "polygon"
  | "rectangle"
  | "circle";

export type LineStyle = "solid" | "dashed" | "dotted" | "outlined";

export interface FeatureStyle {
  stroke: string;
  strokeOpacity: number;
  strokeWidth: number;
  lineStyle?: LineStyle;
  fill?: string;
  fillOpacity?: number;
}

export interface MapFeature {
  id: string;
  kind: FeatureKind;
  name: string;
  sidc?: string;
  affiliation?: Affiliation;
  geometry: Geometry;
  radiusM?: number;
  style: FeatureStyle;
  remarks?: string;
  showLabel?: boolean;
}

export type SourceCategory = "free" | "api";

export type FetchStrategy =
  | "xyz"
  | "arcgis-export"
  | "stac-sentinel2"
  | "sentinel-hub"
  | "planet";

export interface ImagerySourceDef {
  id: string;
  name: string;
  description: string;
  category: SourceCategory;
  keyId?: string;
  keyLabel?: string;
  keyPlaceholder?: string;
  attribution: string;
  license: string;
  streamOnly: boolean;
  offlineRequiresPlanCheck?: boolean;
  strategy: FetchStrategy;
  tileUrlTemplate?: string;
  exportUrlBase?: string;
  usOnly?: boolean;
  minZoom: number;
  maxZoom: number;
  defaultTileFormat: "jpeg" | "png";
}

export interface Limits {
  maxTilesPerExport: number;
  recommendedMaxPackageBytes: number;
  maxGrgPixels: number;
}

export interface AppConfig {
  sources: ImagerySourceDef[];
  limits: Limits;
}

export type ImageryExportMode = "gpkg" | "kmz-grg";

export interface ImageryExportSpec {
  sourceId: string;
  mode: ImageryExportMode;
  minZoom: number;
  maxZoom: number;
  tileFormat: "jpeg" | "png";
  apiKey?: string;
  planConfirmed?: boolean;
}

export interface ExportRequest {
  packageName: string;
  aoi: Aoi;
  features: MapFeature[];
  imagery?: ImageryExportSpec;
  mapSourceXmlIds: string[];
  includeKeyInXml?: boolean;
  includeKmlOverlay?: boolean;
}

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface JobProgress {
  phase: string;
  percent: number;
  message?: string;
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  progress: JobProgress;
  warnings: string[];
  error?: string;
  artifactName?: string;
  sizeBytes?: number;
  createdAt: string;
  updatedAt: string;
}

/** Map interaction tools. */
export type ToolType =
  | "select"
  | "marker"
  | "label"
  | "line"
  | "route"
  | "polygon"
  | "rectangle"
  | "circle"
  | "aoi";

/** Basemaps for the editing canvas (streaming only, not exported). */
export interface BasemapDef {
  id: string;
  name: string;
  url: string;
  attribution: string;
  maxZoom: number;
}

export const BASEMAPS: BasemapDef[] = [
  {
    id: "osm",
    name: "OpenStreetMap",
    url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  },
  {
    id: "esri-imagery",
    name: "Esri World Imagery",
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: "© Esri, Maxar, Earthstar Geographics",
    maxZoom: 19,
  },
  {
    id: "carto-dark",
    name: "Carto Dark",
    url: "https://basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
    attribution: "© OpenStreetMap contributors © CARTO",
    maxZoom: 20,
  },
  {
    id: "usgs-topo",
    name: "USGS Topo",
    url: "https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}",
    attribution: "© USGS",
    maxZoom: 16,
  },
];
