import { rmSync } from "node:fs";
import Database from "better-sqlite3";
import type { GpkgWriteOptions, PyramidTile } from "../types.js";
import { WEB_MERCATOR_EXTENT, aoiTo3857, pixelSizeForZoom } from "./tile-math.js";

/**
 * GeoPackage tile writer — EPSG:3857, GoogleMapsCompatible, 256px tiles.
 *
 * Layout matches what GDAL produces for
 * `gdal_translate -of GPKG -co TILING_SCHEME=GoogleMapsCompatible` + `gdaladdo`:
 * - gpkg_tile_matrix_set spans the FULL Web Mercator extent so
 *   tile_column/tile_row equal global XYZ x/y (top-origin, NO TMS flip).
 * - gpkg_tile_matrix has one row for EVERY zoom 0..maxZoom (GDAL writes the
 *   whole ladder even when tiles only exist at [minZoom..maxZoom]).
 * - gpkg_contents extent is the actual AOI converted to 3857 meters.
 */

const APPLICATION_ID = 0x47504b47; // 'GPKG'
const USER_VERSION = 10300; // GeoPackage 1.3.0

const WKT_4326 =
  'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';
const WKT_3857 =
  'PROJCS["WGS 84 / Pseudo-Mercator",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Mercator_1SP"],PARAMETER["central_meridian",0],PARAMETER["scale_factor",1],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1]]';

export function writeGeoPackage(opts: GpkgWriteOptions): { tileCount: number } {
  const { filePath, tableName, aoi, maxZoom } = opts;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tableName)) {
    throw new Error(`gpkg tableName is not SQL-identifier-safe: ${tableName}`);
  }

  // Stale temp files from a previous run would corrupt the output.
  rmSync(filePath, { force: true });

  const db = new Database(filePath);
  try {
    db.pragma(`application_id = ${APPLICATION_ID}`);
    db.pragma(`user_version = ${USER_VERSION}`);

    db.exec(`
      CREATE TABLE gpkg_spatial_ref_sys (
        srs_name TEXT NOT NULL,
        srs_id INTEGER NOT NULL PRIMARY KEY,
        organization TEXT NOT NULL,
        organization_coordsys_id INTEGER NOT NULL,
        definition TEXT NOT NULL,
        description TEXT
      );
      CREATE TABLE gpkg_contents (
        table_name TEXT NOT NULL PRIMARY KEY,
        data_type TEXT NOT NULL,
        identifier TEXT UNIQUE,
        description TEXT DEFAULT '',
        last_change DATETIME NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        min_x DOUBLE,
        min_y DOUBLE,
        max_x DOUBLE,
        max_y DOUBLE,
        srs_id INTEGER,
        CONSTRAINT fk_gc_r_srs_id FOREIGN KEY (srs_id)
          REFERENCES gpkg_spatial_ref_sys(srs_id)
      );
      CREATE TABLE gpkg_tile_matrix_set (
        table_name TEXT NOT NULL PRIMARY KEY,
        srs_id INTEGER NOT NULL,
        min_x DOUBLE NOT NULL,
        min_y DOUBLE NOT NULL,
        max_x DOUBLE NOT NULL,
        max_y DOUBLE NOT NULL,
        CONSTRAINT fk_gtms_table_name FOREIGN KEY (table_name)
          REFERENCES gpkg_contents(table_name),
        CONSTRAINT fk_gtms_srs FOREIGN KEY (srs_id)
          REFERENCES gpkg_spatial_ref_sys(srs_id)
      );
      CREATE TABLE gpkg_tile_matrix (
        table_name TEXT NOT NULL,
        zoom_level INTEGER NOT NULL,
        matrix_width INTEGER NOT NULL,
        matrix_height INTEGER NOT NULL,
        tile_width INTEGER NOT NULL,
        tile_height INTEGER NOT NULL,
        pixel_x_size DOUBLE NOT NULL,
        pixel_y_size DOUBLE NOT NULL,
        CONSTRAINT pk_ttm PRIMARY KEY (table_name, zoom_level),
        CONSTRAINT fk_tmm_table_name FOREIGN KEY (table_name)
          REFERENCES gpkg_contents(table_name)
      );
      CREATE TABLE "${tableName}" (id INTEGER PRIMARY KEY AUTOINCREMENT,
        zoom_level INTEGER NOT NULL, tile_column INTEGER NOT NULL, tile_row INTEGER NOT NULL,
        tile_data BLOB NOT NULL, UNIQUE (zoom_level, tile_column, tile_row));
    `);

    const insertSrs = db.prepare(
      `INSERT INTO gpkg_spatial_ref_sys
         (srs_name, srs_id, organization, organization_coordsys_id, definition, description)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertSrs.run(
      "Undefined Cartesian SRS",
      -1,
      "NONE",
      -1,
      "undefined",
      "undefined Cartesian coordinate reference system",
    );
    insertSrs.run(
      "Undefined geographic SRS",
      0,
      "NONE",
      0,
      "undefined",
      "undefined geographic coordinate reference system",
    );
    insertSrs.run(
      "WGS 84 geodetic",
      4326,
      "EPSG",
      4326,
      WKT_4326,
      "longitude/latitude coordinates in decimal degrees on the WGS 84 spheroid",
    );
    insertSrs.run("WGS 84 / Pseudo-Mercator", 3857, "EPSG", 3857, WKT_3857, null);

    const extent = aoiTo3857(aoi);
    db.prepare(
      `INSERT INTO gpkg_contents
         (table_name, data_type, identifier, description, last_change,
          min_x, min_y, max_x, max_y, srs_id)
       VALUES (?, 'tiles', ?, '', ?, ?, ?, ?, ?, 3857)`,
    ).run(
      tableName,
      tableName,
      new Date().toISOString(),
      extent.minX,
      extent.minY,
      extent.maxX,
      extent.maxY,
    );

    db.prepare(
      `INSERT INTO gpkg_tile_matrix_set (table_name, srs_id, min_x, min_y, max_x, max_y)
       VALUES (?, 3857, ?, ?, ?, ?)`,
    ).run(
      tableName,
      -WEB_MERCATOR_EXTENT,
      -WEB_MERCATOR_EXTENT,
      WEB_MERCATOR_EXTENT,
      WEB_MERCATOR_EXTENT,
    );

    // GDAL writes the full zoom ladder 0..maxZoom even when tiles exist only
    // at [minZoom..maxZoom]; ATAK needs [minZoom..maxZoom] contiguous anyway.
    const insertMatrix = db.prepare(
      `INSERT INTO gpkg_tile_matrix
         (table_name, zoom_level, matrix_width, matrix_height,
          tile_width, tile_height, pixel_x_size, pixel_y_size)
       VALUES (?, ?, ?, ?, 256, 256, ?, ?)`,
    );
    for (let z = 0; z <= maxZoom; z++) {
      const n = 2 ** z;
      const px = pixelSizeForZoom(z);
      insertMatrix.run(tableName, z, n, n, px, px);
    }

    // Full-extent matrix set ⇒ tile_column/tile_row = global XYZ x/y directly.
    const insertTile = db.prepare(
      `INSERT INTO "${tableName}" (zoom_level, tile_column, tile_row, tile_data)
       VALUES (?, ?, ?, ?)`,
    );
    const insertAll = db.transaction((tiles: Iterable<PyramidTile>) => {
      let count = 0;
      for (const t of tiles) {
        insertTile.run(t.z, t.x, t.y, t.data);
        count++;
      }
      return count;
    });
    const tileCount = insertAll(opts.tiles);

    return { tileCount };
  } finally {
    db.close();
  }
}
