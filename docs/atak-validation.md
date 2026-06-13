# ATAK Validation Checklist

Format requirements in this app were derived from reading the ATAK-CIV source
(MissionPackageExtractor/Builder, GeoPackageImporter, KmzLayerInfoSpi, MBTilesInfo,
importfiles/sort/*). What is verified **locally** by the test suite:

- Mission package zip contains `MANIFEST/manifest.xml` with version="2", uid + name.
- Every manifest `zipEntry` matches a real zip entry (forward slashes).
- GeoPackage metadata tables byte-match a GDAL `TILING_SCHEME=GoogleMapsCompatible`
  reference (when GDAL is installed) and pass spec assertions otherwise.
- KML colors are aabbggrr; all XML is escaped; circles tessellate to closed rings.
- CoT events parse as XML, carry valid uid/type/time/start/stale and `<point>`.

## On-device checks still required (no ATAK device in the build environment)

1. Import a generated package zip via ATAK → Import Manager → Local SD.
2. Confirm the GeoPackage appears under Imagery and renders at every exported zoom
   (pan and zoom across the AOI; look for blank rings between zoom levels).
3. Confirm markers import as native, editable 2525 symbols (correct affiliation
   color/shape), not generic pins.
4. Confirm routes import as editable ATAK routes (u-d / b-m-r details honored).
5. Confirm polygon/rectangle/circle shapes render with stroke + fill colors.
6. Confirm the KML overlay renders with matching colors (no red/blue swap).
7. Confirm map-source XML files appear in the map source list and stream tiles.
8. KMZ-GRG mode: confirm the GroundOverlay registers at the right location.
9. Note your ATAK version and any deviations here.

## Known unknowns (validate on device, adjust writers if needed)

- CoT `u-d-c` circle: `<ellipse major/minor>` is assumed to be radius meters,
  angle 360. If circles import at half/double size, flip to diameter in
  `server/src/export/cot-writer.ts`.
- CoT `b-m-r` route `link_attr` attribute set is the common community shape; some
  ATAK versions may want `__routeinfo`/navcues for full editability.
- Package-level `onReceiveImport` only affects network-received packages; local
  imports always go through content sniffing.
- KMZ-GRG mode writes a degrees-linear `<LatLonBox>` over a Web-Mercator-linear
  image, so a tall AOI is vertically offset (negligible for small AOIs; a tall
  box at mid/high latitude can be off by hundreds of metres). The builder warns
  past ~0.5° of latitude span and steers large areas to GeoPackage mode, which
  carries its own CRS and has no such offset. If small-AOI GRGs still land
  offset on device, reproject the image to EPSG:4326 in the single-image
  adapters before `buildGrgKmz`.
