import { describe, expect, it } from "vitest";
import { aoiFromCorners, countTilesForAoi } from "../src/lib/estimate";

const MAX_MERC_LAT = 85.05112877980659;

describe("countTilesForAoi (mirrors server tileRangeForAoi half-open SE corner)", () => {
  it("does not pull in an extra row/column when the AOI edge sits exactly on a tile boundary", () => {
    // AOI exactly covering tile (0,0) at z=1: lon [-180, 0], lat [0, maxMercLat].
    // The east/south edges land exactly on the tile boundary — the old
    // floor-based math counted 4 tiles; the half-open SE corner counts 1.
    const aoi = { west: -180, east: 0, south: 0, north: MAX_MERC_LAT };
    expect(countTilesForAoi(aoi, 1, 1)).toBe(1);
  });

  it("still counts the neighboring row/column once the AOI actually overlaps it", () => {
    const aoi = { west: -180, east: 0.1, south: -0.1, north: MAX_MERC_LAT };
    // Crosses both the x and y boundary by a sliver → 2x2 tiles at z=1.
    expect(countTilesForAoi(aoi, 1, 1)).toBe(4);
  });

  it("counts a sub-tile AOI as a single tile", () => {
    const aoi = { west: 10, east: 20, south: 10, north: 20 };
    expect(countTilesForAoi(aoi, 0, 0)).toBe(1);
    expect(countTilesForAoi(aoi, 2, 2)).toBe(1);
  });

  it("sums across the inclusive zoom range", () => {
    const aoi = { west: -180, east: 0, south: 0, north: MAX_MERC_LAT };
    // z=1 → 1 tile; z=2 → 2x2 = 4 tiles (quarter of the world above equator).
    expect(countTilesForAoi(aoi, 1, 2)).toBe(5);
  });
});

describe("aoiFromCorners", () => {
  it("builds a min/max box from two corners", () => {
    expect(aoiFromCorners([10, 5], [20, -5])).toEqual({
      north: 5,
      south: -5,
      east: 20,
      west: 10,
    });
  });

  it("is corner-order independent", () => {
    expect(aoiFromCorners([20, -5], [10, 5])).toEqual(
      aoiFromCorners([10, 5], [20, -5]),
    );
  });

  it("rejects corners that straddle the antimeridian", () => {
    expect(aoiFromCorners([179, 10], [-179, -10])).toBeNull();
    expect(aoiFromCorners([-179, -10], [179, 10])).toBeNull();
  });

  it("accepts a wide-but-legal box (delta exactly 180 or less)", () => {
    expect(aoiFromCorners([-90, 10], [90, -10])).toEqual({
      north: 10,
      south: -10,
      east: 90,
      west: -90,
    });
  });
});
