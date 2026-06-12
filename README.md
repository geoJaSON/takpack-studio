# TAKPack Studio

Build **ATAK data packages** in your browser: pick an area of interest on a map, choose
an imagery source (open/free or your own API key), drop MIL-STD-2525 annotations, and
export a `.zip` that ATAK imports cleanly — with **real offline imagery**.

## What the export contains

| Payload | Format | Why |
|---|---|---|
| Offline imagery | **GeoPackage** (`.gpkg`) — EPSG:3857 GoogleMapsCompatible 256px tile pyramid | The format ATAK's importer reads CRS metadata from; multi-zoom offline basemap, not a single stretched picture |
| Markers / shapes / routes | **CoT event files** (`.cot`) | Import as *native, editable* ATAK objects with proper 2525 symbology — not generic pins |
| Styled overlay | **KML** (aabbggrr colors, escaped, circles tessellated) | Visual backup of all graphics incl. plain lines |
| Streaming sources | **MOBAC `customMapSource` XML** | For sources whose ToS forbid offline packaging (Esri, Mapbox, OSM…) — users stream + self-cache in ATAK legally |
| Manifest | `MANIFEST/manifest.xml` (Mission Package v2) | uid + name, exact zipEntry paths, CoT/KML content typing |
| Attribution | `attribution.txt` | License/attribution lines for every included source |

Single rectified-image KMZ (GRG) export is available as a secondary mode for small AOIs.

## Run it

```bash
npm install
npm run build
npm start        # serves UI + API on http://localhost:8745
```

Dev mode (hot reload): `npm run dev` → UI on http://localhost:5173 (proxies to API on 8745).

Tests: `npm test` (golden-file tests for every writer; GeoPackage output is diffed
against a GDAL-generated reference fixture).

## Imagery sources

- **Free, offline-capable:** USGS Imagery / Topo / Imagery+Topo (US, public domain),
  USDA NAIP ~1 m aerial (US, public domain), Sentinel-2 via Microsoft Planetary
  Computer (global, 10 m).
- **API key, offline within your plan:** Sentinel Hub, MapTiler (plan confirmation
  required — the server refuses otherwise).
- **Stream-only (map-source XML, never pre-baked):** Esri World Imagery/Topo,
  OpenStreetMap, OpenTopoMap, EOX Sentinel-2 Cloudless (CC-BY-NC-SA), Planet
  (in-app preview via OAuth proxy).

Licensing is enforced **server-side**: stream-only sources are rejected for offline
packaging, and API keys are session-scoped — never persisted, never written into
exported files unless you explicitly opt in for map-source XML.

## Validate on a device

The test suite verifies everything that can be verified without an Android device.
Before relying on packages in the field, run the checklist in
[`docs/atak-validation.md`](docs/atak-validation.md) on a real ATAK install once.

## Lineage

Hybrid rebuild of two earlier prototypes (`atak_mapper`, `Tactical-Map-Pack`):
annotation UX and job API shape from the first; imagery catalog, tile engine,
2525 symbol picker, and Planet proxy from the second; the export engine — the part
both got wrong — built new against the ATAK-CIV source.
