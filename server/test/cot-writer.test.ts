import { describe, expect, it } from "vitest";
import { buildCotEvents, sidcToCotType } from "../src/export/cot-writer.js";
import type { MapFeature, WriterDeterminism } from "../src/types.js";

const det: WriterDeterminism = {
  now: () => new Date("2026-01-02T03:04:05.000Z"),
};
const TIME = "2026-01-02T03:04:05.000Z";
const STALE = "2027-01-02T03:04:05.000Z";

describe("sidcToCotType", () => {
  it("maps friendly infantry", () => {
    expect(sidcToCotType("SFGPUCI----K---")).toBe("a-f-G-U-C-I");
  });
  it("maps hostile affiliation", () => {
    expect(sidcToCotType("SHGPUCA----")).toBe("a-h-G-U-C-A");
  });
  it("maps neutral affiliation", () => {
    expect(sidcToCotType("SNGPU------")).toBe("a-n-G-U");
  });
  it("falls back to unknown for unmapped affiliation chars", () => {
    expect(sidcToCotType("SPGPU------")).toBe("a-u-G-U");
    expect(sidcToCotType("SGGPU------")).toBe("a-u-G-U");
  });
  it("maps battle dimension Z to G", () => {
    expect(sidcToCotType("SFZPU------")).toBe("a-f-G-U");
  });
});

describe("buildCotEvents", () => {
  it("emits the exact marker event with escaped strings", () => {
    const marker: MapFeature = {
      id: "11111111-1111-4111-8111-111111111111",
      kind: "marker",
      name: 'A & B <"test">',
      sidc: "SFGPUCI----K---",
      geometry: { type: "Point", coordinates: [-117.25, 34.5] },
      style: { stroke: "#ff0000", strokeOpacity: 1, strokeWidth: 2 },
      remarks: "watch <here>",
    };

    const expected = `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0" uid="11111111-1111-4111-8111-111111111111" type="a-f-G-U-C-I" how="h-g-i-g-o" time="${TIME}" start="${TIME}" stale="${STALE}">
  <point lat="34.5" lon="-117.25" hae="9999999.0" ce="9999999.0" le="9999999.0"/>
  <detail>
    <contact callsign="A &amp; B &lt;&quot;test&quot;&gt;"/>
    <remarks>watch &lt;here&gt;</remarks>
    <archive/>
    <color argb="-65536"/>
  </detail>
</event>
`;

    const files = buildCotEvents([marker], det);
    expect(files).toHaveLength(1);
    expect(files[0].uid).toBe(marker.id);
    expect(files[0].xml).toBe(expected);
  });

  it("falls back to affiliation type for markers without a SIDC", () => {
    const marker: MapFeature = {
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      kind: "marker",
      name: "Unknown contact",
      affiliation: "hostile",
      geometry: { type: "Point", coordinates: [10, 45] },
      style: { stroke: "#ff0000", strokeOpacity: 1, strokeWidth: 2 },
    };
    const [file] = buildCotEvents([marker], det);
    expect(file.xml).toContain('type="a-h-G"');
  });

  const links = (xml: string): string[] =>
    [...xml.matchAll(/<link point="([^"]+)"\/>/g)].map((m) => m[1]);

  it("emits a CLOSED u-d-f polygon (first link repeated as last) with style + labels", () => {
    const polygon: MapFeature = {
      id: "22222222-2222-4222-8222-222222222222",
      kind: "polygon",
      name: "AO Bravo",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-117, 34],
            [-117, 35],
            [-116, 35],
            [-117, 34],
          ],
        ],
      },
      style: {
        stroke: "#ff0000",
        strokeOpacity: 1,
        strokeWidth: 2,
        lineStyle: "dashed",
        fill: "#00ff00",
        fillOpacity: 1,
      },
    };
    const [file] = buildCotEvents([polygon], det);
    expect(file.xml).toContain('type="u-d-f"');
    const l = links(file.xml);
    // ATAK only treats a u-d-f as closed when first point === last point.
    expect(l.length).toBeGreaterThan(2);
    expect(l[0]).toBe(l[l.length - 1]);
    expect(file.xml).toContain('<strokeStyle value="dashed"/>');
    expect(file.xml).toContain('<fillColor value="-16711936"/>');
    expect(file.xml).toContain('<labels_on value="true"/>');
  });

  it("emits a CLOSED u-d-f rectangle", () => {
    const rectangle: MapFeature = {
      id: "33333333-3333-4333-8333-333333333333",
      kind: "rectangle",
      name: "Box",
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [-117, 34],
            [-117, 34.1],
            [-116.9, 34.1],
            [-116.9, 34],
            [-117, 34],
          ],
        ],
      },
      style: { stroke: "#ff0000", strokeOpacity: 1, strokeWidth: 2 },
    };
    const [file] = buildCotEvents([rectangle], det);
    expect(file.xml).toContain('type="u-d-f"');
    const l = links(file.xml);
    expect(l[0]).toBe(l[l.length - 1]); // closed
  });

  it("emits the u-d-c circle with stroke style and labels", () => {
    const circle: MapFeature = {
      id: "55555555-5555-4555-8555-555555555555",
      kind: "circle",
      name: "Blast Radius",
      geometry: { type: "Point", coordinates: [-117.25, 34.5] },
      radiusM: 500,
      style: { stroke: "#ff0000", strokeOpacity: 1, strokeWidth: 2 },
    };
    const [file] = buildCotEvents([circle], det);
    expect(file.xml).toContain('type="u-d-c"');
    expect(file.xml).toContain('<ellipse major="500" minor="500" angle="360"/>');
    expect(file.xml).toContain('<strokeStyle value="solid"/>');
    expect(file.xml).toContain('<labels_on value="true"/>');
  });

  it("emits the b-m-r route with stroke style and labels", () => {
    const route: MapFeature = {
      id: "44444444-4444-4444-8444-444444444444",
      kind: "route",
      name: "Infil Route",
      geometry: {
        type: "LineString",
        coordinates: [
          [-117, 34],
          [-116.5, 34.2],
          [-116, 34.4],
        ],
      },
      style: { stroke: "#0000ff", strokeOpacity: 1, strokeWidth: 3, lineStyle: "dotted" },
    };
    const [file] = buildCotEvents([route], det);
    expect(file.xml).toContain('type="b-m-r"');
    expect(file.xml.match(/type="b-m-p-w"/g)).toHaveLength(3);
    expect(file.xml).toContain('<strokeStyle value="dotted"/>');
    expect(file.xml).toContain('<labels_on value="true"/>');
  });

  it("emits an OPEN u-d-f line (first link != last) with no fill", () => {
    const line: MapFeature = {
      id: "66666666-6666-4666-8666-666666666666",
      kind: "line",
      name: "Phase Line",
      geometry: {
        type: "LineString",
        coordinates: [
          [-117, 34],
          [-116, 34],
          [-115, 34.5],
        ],
      },
      style: { stroke: "#00ff00", strokeOpacity: 1, strokeWidth: 2, lineStyle: "dashed" },
    };
    const [file] = buildCotEvents([line], det);
    expect(file).toBeDefined();
    expect(file.xml).toContain('type="u-d-f"');
    const l = links(file.xml);
    expect(l).toHaveLength(3);
    expect(l[0]).not.toBe(l[l.length - 1]); // open
    expect(file.xml).toContain('<strokeStyle value="dashed"/>');
    expect(file.xml).not.toContain("<fillColor"); // open lines carry no fill
  });

  it("emits a b-m-p-s-m spot marker for a text label", () => {
    const label: MapFeature = {
      id: "77777777-7777-4777-8777-777777777777",
      kind: "label",
      name: "OBJ RAVEN",
      geometry: { type: "Point", coordinates: [-117, 34] },
      style: { stroke: "#ffff00", strokeOpacity: 1, strokeWidth: 2 },
    };
    const [file] = buildCotEvents([label], det);
    expect(file.xml).toContain('type="b-m-p-s-m"');
    expect(file.xml).toContain('<contact callsign="OBJ RAVEN"/>');
  });

  it("suppresses a marker label with <hideLabel/> when showLabel is false", () => {
    const marker: MapFeature = {
      id: "88888888-8888-4888-8888-888888888888",
      kind: "marker",
      name: "Silent",
      sidc: "SFGPUCI----K---",
      geometry: { type: "Point", coordinates: [-117, 34] },
      style: { stroke: "#ff0000", strokeOpacity: 1, strokeWidth: 2 },
      showLabel: false,
    };
    const [file] = buildCotEvents([marker], det);
    expect(file.xml).toContain("<hideLabel/>");
  });
});
