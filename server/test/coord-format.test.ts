import { describe, expect, it } from "vitest";
import { fmtCoord } from "../src/export/xml.js";
import { buildKmlDocument } from "../src/export/kml-writer.js";
import { buildCotEvents } from "../src/export/cot-writer.js";
import type { MapFeature } from "../src/types.js";

const DET = { now: () => new Date("2026-01-01T00:00:00.000Z") };

describe("fmtCoord", () => {
  it("never emits scientific notation", () => {
    for (const n of [5.5e-19, 1.1e-18, -4e-7, 1e-12, 0.0089831, -179.999999]) {
      expect(fmtCoord(n)).not.toMatch(/[eE]/);
    }
  });

  it("snaps near-zero to 0 and trims trailing zeros", () => {
    expect(fmtCoord(5.5e-19)).toBe("0");
    expect(fmtCoord(0)).toBe("0");
    expect(fmtCoord(12.34)).toBe("12.34");
    expect(fmtCoord(-111.891)).toBe("-111.891");
    expect(fmtCoord(40)).toBe("40");
  });
});

// A circle tessellated near the equator produces tessellation deltas like
// 5.5e-19 — the exact case that made ATAK drop the whole LinearRing.
const equatorCircle: MapFeature = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "circle",
  name: "NAI Equator",
  geometry: { type: "Point", coordinates: [0, 0] },
  radiusM: 1000,
  style: {
    stroke: "#ff5577",
    strokeOpacity: 1,
    strokeWidth: 2,
    fill: "#ff5577",
    fillOpacity: 0.1,
  },
};

describe("coordinate formatting in writers", () => {
  it("KML coordinates carry no exponent notation for an equator circle", () => {
    const kml = buildKmlDocument("pkg", [equatorCircle]);
    const coords = [...kml.matchAll(/<coordinates>([^<]*)<\/coordinates>/g)]
      .map((m) => m[1])
      .join(" ");
    expect(coords.length).toBeGreaterThan(0);
    expect(coords).not.toMatch(/[eE]/);
  });

  it("CoT shape coordinates carry no exponent notation", () => {
    const [event] = buildCotEvents([equatorCircle], DET);
    expect(event.xml).not.toMatch(/(?:lat|lon|point)="[^"]*[eE][^"]*"/);
  });
});

// A feature with a fill COLOR but no explicit fillOpacity must render visible,
// not fully transparent (alpha 00).
const filledNoOpacity: MapFeature = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "polygon",
  name: "AO",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-1, -1],
        [1, -1],
        [1, 1],
        [-1, 1],
        [-1, -1],
      ],
    ],
  },
  style: { stroke: "#00ff00", strokeOpacity: 1, strokeWidth: 2, fill: "#00ff00" },
};

describe("fill opacity defaulting", () => {
  it("KML PolyStyle is visible when a fill color is set without opacity", () => {
    const kml = buildKmlDocument("pkg", [filledNoOpacity]);
    const m = kml.match(/<PolyStyle><color>([0-9a-f]{8})<\/color>/);
    expect(m).not.toBeNull();
    // aabbggrr — alpha is the first byte; must not be fully transparent.
    expect(m![1].slice(0, 2)).not.toBe("00");
  });

  it("CoT fillColor is visible when a fill color is set without opacity", () => {
    const [event] = buildCotEvents([filledNoOpacity], DET);
    const m = event.xml.match(/<fillColor value="(-?\d+)"\/>/);
    expect(m).not.toBeNull();
    const argb = Number(m![1]) >>> 0; // unsigned 32-bit
    const alpha = (argb >>> 24) & 0xff;
    expect(alpha).toBeGreaterThan(0);
  });
});
