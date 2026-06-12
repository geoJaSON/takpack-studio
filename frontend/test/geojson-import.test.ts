import { describe, expect, it } from "vitest";
import { featuresFromGeoJson } from "../src/lib/geojson-import";

const DEFAULTS = { sidc: "SFGPU------" };

describe("featuresFromGeoJson WGS84 bounds validation", () => {
  it("imports valid WGS84 coordinates", () => {
    const out = featuresFromGeoJson(
      JSON.stringify({
        type: "Feature",
        properties: { name: "OP 1" },
        geometry: { type: "Point", coordinates: [-111.891, 40.761] },
      }),
      DEFAULTS,
    );
    expect(out).toHaveLength(1);
    expect(out[0].kind).toBe("marker");
    expect(out[0].geometry).toEqual({
      type: "Point",
      coordinates: [-111.891, 40.761],
    });
  });

  it("rejects projected-CRS coordinates (EPSG:3857 meters) with a helpful message", () => {
    const text = JSON.stringify({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [-12476943, 4974511] },
    });
    expect(() => featuresFromGeoJson(text, DEFAULTS)).toThrowError(
      /out of WGS84 range.*projected CRS.*EPSG:3857.*EPSG:4326/s,
    );
  });

  it("rejects out-of-range latitude (lat 91)", () => {
    const text = JSON.stringify({
      type: "Feature",
      properties: {},
      geometry: { type: "Point", coordinates: [10, 91] },
    });
    expect(() => featuresFromGeoJson(text, DEFAULTS)).toThrowError(
      /out of WGS84 range/,
    );
  });

  it("rejects out-of-range longitude (lon 200) nested in a polygon ring", () => {
    const text = JSON.stringify({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: {},
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [200, 0],
                [201, 0],
                [201, 1],
                [200, 0],
              ],
            ],
          },
        },
      ],
    });
    expect(() => featuresFromGeoJson(text, DEFAULTS)).toThrowError(
      /out of WGS84 range/,
    );
  });

  it("accepts boundary values (lon ±180, lat ±90)", () => {
    const out = featuresFromGeoJson(
      JSON.stringify({
        type: "Feature",
        properties: {},
        geometry: { type: "Point", coordinates: [-180, 90] },
      }),
      DEFAULTS,
    );
    expect(out).toHaveLength(1);
  });
});
