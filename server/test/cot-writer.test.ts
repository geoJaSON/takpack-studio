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

  it("emits the exact u-d-f polygon event with unclosed ring links", () => {
    const polygon: MapFeature = {
      id: "22222222-2222-4222-8222-222222222222",
      kind: "polygon",
      name: "AO Bravo",
      geometry: {
        type: "Polygon",
        // Closed exterior ring — the writer must drop the repeated vertex.
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
        fill: "#00ff00",
        fillOpacity: 1,
      },
    };

    const expected = `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0" uid="22222222-2222-4222-8222-222222222222" type="u-d-f" how="h-g-i-g-o" time="${TIME}" start="${TIME}" stale="${STALE}">
  <point lat="34" lon="-117" hae="9999999.0" ce="9999999.0" le="9999999.0"/>
  <detail>
    <contact callsign="AO Bravo"/>
    <remarks></remarks>
    <archive/>
    <link point="34,-117,0.0"/>
    <link point="35,-117,0.0"/>
    <link point="35,-116,0.0"/>
    <strokeColor value="-65536"/>
    <strokeWeight value="2"/>
    <fillColor value="-16711936"/>
    <labels_on value="true"/>
  </detail>
</event>
`;

    const [file] = buildCotEvents([polygon], det);
    expect(file.xml).toBe(expected);
  });

  it("emits u-d-r rectangles with exactly 4 corner links", () => {
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
    expect(file.xml).toContain('type="u-d-r"');
    expect(file.xml.match(/<link point=/g)).toHaveLength(4);
  });

  it("emits the exact u-d-c circle event", () => {
    const circle: MapFeature = {
      id: "55555555-5555-4555-8555-555555555555",
      kind: "circle",
      name: "Blast Radius",
      geometry: { type: "Point", coordinates: [-117.25, 34.5] },
      radiusM: 500,
      style: {
        stroke: "#ff0000",
        strokeOpacity: 1,
        strokeWidth: 2,
        fill: "#ff0000",
        fillOpacity: 0,
      },
    };

    const expected = `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0" uid="55555555-5555-4555-8555-555555555555" type="u-d-c" how="h-g-i-g-o" time="${TIME}" start="${TIME}" stale="${STALE}">
  <point lat="34.5" lon="-117.25" hae="9999999.0" ce="9999999.0" le="9999999.0"/>
  <detail>
    <contact callsign="Blast Radius"/>
    <remarks></remarks>
    <archive/>
    <shape><ellipse major="500" minor="500" angle="360"/></shape>
    <strokeColor value="-65536"/>
    <strokeWeight value="2"/>
    <fillColor value="16711680"/>
  </detail>
</event>
`;

    const [file] = buildCotEvents([circle], det);
    expect(file.xml).toBe(expected);
  });

  it("emits the exact b-m-r route event with checkpoint links", () => {
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
      style: { stroke: "#0000ff", strokeOpacity: 1, strokeWidth: 3 },
    };

    const expected = `<?xml version="1.0" encoding="UTF-8"?>
<event version="2.0" uid="44444444-4444-4444-8444-444444444444" type="b-m-r" how="h-g-i-g-o" time="${TIME}" start="${TIME}" stale="${STALE}">
  <point lat="34" lon="-117" hae="9999999.0" ce="9999999.0" le="9999999.0"/>
  <detail>
    <contact callsign="Infil Route"/>
    <remarks></remarks>
    <archive/>
    <link uid="44444444-4444-4444-8444-444444444444.0" callsign="" type="b-m-p-w" point="34,-117,0.0" remarks="" relation="c"/>
    <link uid="44444444-4444-4444-8444-444444444444.1" callsign="" type="b-m-p-w" point="34.2,-116.5,0.0" remarks="" relation="c"/>
    <link uid="44444444-4444-4444-8444-444444444444.2" callsign="" type="b-m-p-w" point="34.4,-116,0.0" remarks="" relation="c"/>
    <link_attr planningmethod="Infil" color="-16776961" method="Driving" prefix="CP" type="On Foot" stroke="3"/>
  </detail>
</event>
`;

    const [file] = buildCotEvents([route], det);
    expect(file.xml).toBe(expected);
  });

  it("produces NO CoT for kind 'line'", () => {
    const line: MapFeature = {
      id: "66666666-6666-4666-8666-666666666666",
      kind: "line",
      name: "Phase Line",
      geometry: {
        type: "LineString",
        coordinates: [
          [-117, 34],
          [-116, 34],
        ],
      },
      style: { stroke: "#00ff00", strokeOpacity: 1, strokeWidth: 2 },
    };
    expect(buildCotEvents([line], det)).toHaveLength(0);
  });
});
