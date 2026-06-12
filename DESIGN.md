# TAKPack Studio — Design & Contracts

Single-runtime TypeScript app that builds **ATAK data packages**: offline imagery as
GeoPackage tile pyramids, editable annotations as CoT events, styled KML overlays, and
MOBAC map-source XML for stream-only sources. One Node process + SQLite; no Python, no
PostgreSQL. `npm install && npm run build && npm start`.

This document is the **contract**. `server/src/types.ts` and `frontend/src/types.ts`
are law — module builders implement to these signatures exactly.

## Repo layout

```
takpack-studio/
  server/                 Express 5 (ESM), better-sqlite3, sharp, archiver
    src/
      types.ts            ★ owned by integrator — all shared contracts
      app.ts index.ts     express app + entry
      catalog/imagery-sources.ts
      adapters/           xyz.ts arcgis-export.ts sentinel-pc.ts sentinel-hub.ts
      export/             tile-math.ts xml.ts manifest.ts kml-writer.ts cot-writer.ts
                          mapsource-xml.ts gpkg-writer.ts grg-kmz.ts package-builder.ts
      jobs/               store.ts queue.ts
      routes/             health.ts config.ts export.ts jobs.ts preview.ts planet.ts
    test/                 vitest — golden-file + unit tests per writer
  frontend/               Vite + React 18 + react-leaflet 4 + zustand + milsymbol + mgrs
    src/
      types.ts store/use-app-store.ts App.tsx lib/api.ts   ★ owned by integrator
      components/map/     MapCanvas.tsx AnnotationLayer.tsx
      components/toolbar/ AnnotationToolbar.tsx
      components/panels/  ImageryPanel.tsx FeaturePanel.tsx
      components/dialogs/ ExportDialog.tsx
      lib/                milsymbol-utils.ts estimate.ts geojson-import.ts mgrs-format.ts
      styles.css          ported tactical design system
  docs/atak-validation.md
```

## ATAK format requirements (digest of ATAK-CIV source research — DO NOT deviate)

### Data package zip
- Manifest at **exact** zip path `MANIFEST/manifest.xml` (case-sensitive, forward slashes).
- Root `<MissionPackageManifest version="2">`; `<Configuration>` MUST have Parameters
  `uid` (fresh UUID v4 per package) and `name`. Optional `remarks`, `onReceiveImport`.
- Each `<Content ignore="false" zipEntry="...">` — zipEntry must byte-for-byte match a
  zip entry path (no leading slash, no backslashes — archiver must be given
  forward-slash names). Convention: `<uuid>/<filename>` per content.
- CoT content: zipEntry ends in `.cot` (auto-detected) AND add
  `<Parameter name="uid" value="<event-uid>"/>` + `<Parameter name="isCoT" value="true"/>`.
- KML/KMZ content: `<Parameter name="contentType" value="KML"/>` + `visible`.
- GeoPackage / map-source XML content: just `name` Parameter — import is by content
  sniffing (extension matters; never rename extensions).
- ALL attribute values XML-escaped.

### GeoPackage (offline imagery) — EPSG:3857, GoogleMapsCompatible, 256px
SQLite file with:
- `PRAGMA application_id = 0x47504B47` ('GPKG'), `PRAGMA user_version = 10300`.
- `gpkg_spatial_ref_sys` rows: srs_id -1 (undefined cartesian), 0 (undefined geographic),
  4326 (WGS84), 3857 (Web Mercator, organization EPSG, proper WKT).
- `gpkg_contents`: one row, `data_type='tiles'`, `srs_id=3857`, min_x/min_y/max_x/max_y =
  actual data extent **in meters** (AOI converted to 3857).
- `gpkg_tile_matrix_set`: srs_id=3857, extent = FULL Web Mercator
  (±20037508.342789244) — this makes tile_column/tile_row equal global XYZ indices.
- `gpkg_tile_matrix`: one row per zoom z in [minZoom..maxZoom] (CONTIGUOUS — missing
  levels render blank/blurry in ATAK): matrix_width = matrix_height = 2^z,
  tile_width = tile_height = 256, pixel_x_size = pixel_y_size = 156543.03392804097 / 2^z.
- Tile table `CREATE TABLE "<tableName>" (id INTEGER PRIMARY KEY AUTOINCREMENT,
  zoom_level INTEGER NOT NULL, tile_column INTEGER NOT NULL, tile_row INTEGER NOT NULL,
  tile_data BLOB NOT NULL, UNIQUE (zoom_level, tile_column, tile_row))`.
- GeoPackage tile origin is **top-left** → with the full-extent matrix set,
  `tile_column = XYZ x`, `tile_row = XYZ y` directly (NO TMS flip).
- JPEG tiles (quality ~80) for photo imagery; PNG when transparency matters.
- Test MUST diff metadata tables against a GDAL-generated reference
  (`gdal_translate -of GPKG -co TILE_FORMAT=JPEG -co TILING_SCHEME=GoogleMapsCompatible`
  + `gdaladdo`) when `gdal_translate` is on PATH (it is on this machine); skip gracefully otherwise.

### CoT events (editable native ATAK objects) — one event per `.cot` file
Common skeleton (every event):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0" uid="{uuid}" type="{type}" how="h-g-i-g-o"
       time="{nowISO}" start="{nowISO}" stale="{now+1yISO}">
  <point lat="{lat}" lon="{lon}" hae="9999999.0" ce="9999999.0" le="9999999.0"/>
  <detail>
    <contact callsign="{name-escaped}"/>
    <remarks>{remarks-escaped}</remarks>
    <archive/>
    ...kind-specific...
  </detail>
</event>
```
- **Marker**: type = `sidcToCotType(sidc)`. 2525C 15-char SIDC → CoT type:
  `a-{affiliation}-{battleDimension}-{fn chars}` where affiliation = SIDC[1] mapped
  {F,A,D,M,J,K→f; H,S→h; N,L→n; else→u}; battleDimension = SIDC[2] (uppercase, P→A?
  no — keep as-is except Z→G fallback); function chars = SIDC[4..9] stopping at first
  `-`, each emitted as `-X`. Example `SFGPUCI----K---` → `a-f-G-U-C-I`. Detail adds
  `<color argb="{argb}"/>`. point = geometry coordinates.
- **Polygon / freehand** (kind polygon): type `u-d-f`. point = first vertex (or centroid).
  Detail: one `<link point="{lat},{lon},0.0"/>` per exterior-ring vertex (unclosed —
  do NOT repeat first vertex), then
  `<strokeColor value="{argbInt}"/><strokeWeight value="{width}"/><fillColor value="{fillArgbInt}"/>`
  and `<labels_on value="true"/>`.
- **Rectangle** (kind rectangle): type `u-d-r`, same detail as polygon with exactly 4 corner links.
- **Circle** (kind circle): type `u-d-c`, point = center. Detail:
  `<shape><ellipse major="{radiusM}" minor="{radiusM}" angle="360"/></shape>` + stroke/fill params.
- **Route** (kind route): type `b-m-r`. point = first vertex. Detail: per vertex
  `<link uid="{eventUid}.{i}" callsign="" type="b-m-p-w" point="{lat},{lon},0.0" remarks="" relation="c"/>`
  then `<link_attr planningmethod="Infil" color="{argbInt}" method="Driving" prefix="CP" type="On Foot" stroke="{width}"/>`.
- **Line** (kind line): export as route? NO — plain line: type `u-d-f` with links and
  `<fillColor value="0"/>` is wrong; use KML for lines AND emit no CoT (lines are
  overlay graphics). Decision: kinds marker/route/polygon/rectangle/circle → CoT;
  kind line → KML only.
- ARGB int = signed 32-bit two's-complement of 0xAARRGGBB (e.g. opaque red = -65536).

### KML overlay (styled, non-editable backup of all shapes/lines)
- Colors are **aabbggrr** hex (alpha, blue, green, red) — convert from #rrggbb + opacity.
- XML-escape every user string. Circle → 64-point tessellated polygon.
- LineString: `<tessellate>1</tessellate>`. Polygon: outerBoundaryIs (+ holes if present).
- Markers included as `<Placemark><Point>` with name; styling via per-feature `<Style>`.
- No NetworkLink, no Region/LOD (ATAK ignores them).

### MOBAC map-source XML (streaming sources)
One file per source, root `<customMapSource>` (lowercase element names):
```xml
<?xml version="1.0" encoding="UTF-8"?>
<customMapSource>
    <name>{name}</name>
    <minZoom>{minZoom}</minZoom>
    <maxZoom>{maxZoom}</maxZoom>
    <tileType>{jpg|png}</tileType>
    <url><![CDATA[{url with {$z}/{$x}/{$y} placeholders}]]></url>
</customMapSource>
```
- Convert `{z}/{x}/{y}` → `{$z}/{$x}/{$y}`. CDATA-wrap URLs. NEVER emit URLs containing
  an API key unless the user explicitly opted in (`includeKeyInXml`).
- ArcGIS tile endpoints are `/tile/{z}/{y}/{x}` — y before x. Preserve order when converting.

### KMZ GRG (single rectified image, secondary option for small AOIs)
- Zip: `doc.kml` at root + `files/overlay.jpg`. doc.kml has one `<GroundOverlay>` with
  `<Icon><href>files/overlay.jpg</href></Icon>` + `<LatLonBox>` (north/south/east/west).
- Image must stay well under 100 MB / ~8192px per side. Imported by ATAK as a GRG.

## Licensing policy (server-enforced, not just UI)
`streamOnly: true` sources MUST be rejected by `POST /api/export` for gpkg/kmz-grg modes
(400 with message). They may appear in map-source XML output. Esri, Mapbox, OSM tile
servers, EOX Sentinel-2 cloudless (CC-BY-NC-SA), OpenTopoMap → streamOnly. USGS/NAIP
(public domain), Sentinel-2 via Planetary Computer (open), Sentinel Hub + Planet +
MapTiler (user's own key/quota; MapTiler marked offline-capable only via user opt-in
checkbox acknowledging their plan permits it — flag `offlineRequiresPlanCheck`).
Attribution text is baked into every package (`attribution.txt` entry + KML description).

## Module contracts

All shared types/signatures live in `server/src/types.ts` (already written — READ IT).
Key invariants:
- AOI is `{north, south, east, west}` degrees; tile keys are XYZ (top-origin) z/x/y.
- `MapFeature.id` is UUID v4 and becomes the CoT event uid.
- Adapters: `fetchPyramid()` returns every tile that succeeded; failures counted +
  warned, NEVER silently composited as black. `>20%` tile failure ⇒ job warning;
  `>60%` ⇒ job failure.
- `package-builder.ts` orchestrates: fetch pyramid → write gpkg (or grg-kmz) → write
  cot/kml/xml/attribution → manifest → archiver zip (streamed to disk, forward-slash
  entry names) → returns entries list for tests.
- Job queue: p-queue concurrency 1 (one export at a time), per-job timeout 15 min,
  `reconcileOrphans()` marks running→failed on boot.
- API keys arrive per-request (`imagery.apiKey`), are redacted from logs/job records,
  never persisted.
- Tile budget: `countTiles(aoi, minZ, maxZ) > limits.maxTilesPerExport` ⇒ 400.

## HTTP API
- `GET  /api/health` → `{ ok: true }`
- `GET  /api/config` → `{ sources: ImagerySourceDef[], limits: Limits }`
- `POST /api/export` (zod-validated ExportRequest) → 202 `{ jobId }`
- `GET  /api/jobs/:id` → JobRecord (artifactPath stripped)
- `GET  /api/jobs/:id/download` → application/zip stream, Content-Disposition filename
- `GET  /api/preview/aoi-image?sourceId&n&s&e&w[&key]` → image/jpeg (arcgis-export sources)
- `POST /api/planet/auth` `{clientId, clientSecret}` → `{token, expiresIn}`;
  `GET /api/planet/mosaics?token=`; `GET /api/planet/tiles/:mosaic/:z/:x/:y?token=`
  (ported from Tactical-Map-Pack planet.ts)

## Frontend wiring (store is law — see frontend/src/store/use-app-store.ts)
- Three-step flow: ① pick basemap/imagery + AOI → ② annotate → ③ export.
- `MapCanvas` owns Leaflet; `MapController` is the single `useMapEvents` tool state
  machine (port pattern from Tactical-Map-Pack MapCanvas.tsx:94-248): click behavior
  switches on `tool`; AOI tool = two-click rectangle; double-click or Enter finishes
  multi-point drafts; Escape cancels.
- Markers render as milsymbol DivIcons (module import, NOT window.ms).
- MGRS readout via `mgrs` npm package (`mgrs-format.ts` wraps forward()).
- API keys in localStorage `takpack_key_{keyId}` (port getStoredKey/setStoredKey pattern).
- ExportDialog: live tile count + size estimate (35 KB/jpeg-tile heuristic), zoom-range
  slider clamped to source min/max, warns > 300 MB and suggests sideload, polls job
  every 1.5 s, surfaces warnings[], download button on completion.

## Port sources (read these before writing the corresponding module)
- `C:/Users/jason/Documents/Dev/atak_map_app/Tactical-Map-Pack/artifacts/api-server/src/lib/tile-stitch.ts` → adapters/xyz.ts core (tile math, bounded concurrency)
- `C:/Users/jason/Documents/Dev/atak_map_app/Tactical-Map-Pack/artifacts/atak-mapper/src/lib/imagery-sources.ts` → catalog + frontend key UX
- `C:/Users/jason/Documents/Dev/atak_map_app/Tactical-Map-Pack/artifacts/atak-mapper/src/lib/milsymbol-utils.ts` → frontend/lib/milsymbol-utils.ts
- `C:/Users/jason/Documents/Dev/atak_map_app/Tactical-Map-Pack/artifacts/api-server/src/routes/planet.ts` → routes/planet.ts
- `C:/Users/jason/Documents/Dev/atak_map_app/Tactical-Map-Pack/artifacts/atak-mapper/src/components/map/MapCanvas.tsx` → MapController pattern
- `C:/Users/jason/Documents/Dev/atak_map_app/Tactical-Map-Pack/artifacts/atak-mapper/src/components/panels/ImageryPanel.tsx` → ImageryPanel (drop setTimeout hacks)
- `C:/Users/jason/Documents/Dev/atak_map_app/Tactical-Map-Pack/artifacts/atak-mapper/src/components/dialogs/ExportDialog.tsx` → ExportDialog UX
- `C:/Users/jason/Documents/Dev/atak_map_app/atak_mapper/frontend/src/styles.css` → frontend/src/styles.css (tactical design system)
- `C:/Users/jason/Documents/Dev/atak_map_app/atak_mapper/frontend/src/AnnotationToolbar.tsx` + `AnnotationLayer.tsx` + `annotations.ts` → toolbar/layer patterns (swap hand-rolled MGRS for mgrs npm; UUID feature ids)
- `C:/Users/jason/Documents/Dev/atak_map_app/atak_mapper/backend/worker/sources/naip.py` → adapters/arcgis-export.ts logic (meters-per-pixel sizing, grid stitch, pixel budget) — repoint to `https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPImagery/ImageServer`
- `C:/Users/jason/Documents/Dev/atak_map_app/atak_mapper/backend/worker/sources/sentinel.py` → adapters/sentinel-pc.ts (Planetary Computer STAC + titiler)
- `C:/Users/jason/Documents/Dev/atak_map_app/atak_mapper/backend/api/src/server.ts:326-370` → sentinel-hub OAuth token cache pattern
- `C:/Users/jason/Documents/Dev/atak_map_app/atak_mapper/backend/worker/export/kmz.py:69-79` → circle tessellation

## Testing
- vitest in `server/test/`. No network in tests — inject fetch mocks.
- Golden-file tests: manifest, KML, CoT, map-source XML (string snapshots with fixed
  UUIDs/timestamps injected via options params — writers accept optional `now`/uid
  factories for determinism).
- gpkg-writer: build small pyramid from sharp-generated solid tiles; assert all
  metadata rows; diff vs GDAL reference when available.
- package-builder integration test: full ExportRequest with mock adapter → unzip
  (use `yauzl` or read zip with archiver counterpart — dev-dep `adm-zip` is fine for
  tests only) → assert manifest parses, every zipEntry exists, gpkg opens.
