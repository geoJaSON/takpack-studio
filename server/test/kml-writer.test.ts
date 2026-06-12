import { describe, expect, it } from "vitest";
import { buildKmlDocument, circleRing } from "../src/export/kml-writer.js";
import type { MapFeature } from "../src/types.js";

describe("buildKmlDocument", () => {
  it("emits the exact document for marker + line + polygon with hole", () => {
    const features: MapFeature[] = [
      {
        id: "m1",
        kind: "marker",
        name: 'HQ "Alpha"',
        geometry: { type: "Point", coordinates: [-117.25, 34.5] },
        style: { stroke: "#ff0000", strokeOpacity: 1, strokeWidth: 2 },
        remarks: "Main <CP>",
      },
      {
        id: "l1",
        kind: "line",
        name: "Phase Line",
        geometry: {
          type: "LineString",
          coordinates: [
            [-117, 34],
            [-116.5, 34.2],
          ],
        },
        style: { stroke: "#00ff00", strokeOpacity: 0.5, strokeWidth: 3 },
      },
      {
        id: "p1",
        kind: "polygon",
        name: "AO Bravo",
        geometry: {
          type: "Polygon",
          coordinates: [
            // Closed exterior ring stays as-is.
            [
              [-117, 34],
              [-117, 35],
              [-116, 35],
              [-117, 34],
            ],
            // Unclosed hole — the writer must close it.
            [
              [-116.9, 34.4],
              [-116.8, 34.6],
              [-116.7, 34.4],
            ],
          ],
        },
        style: {
          stroke: "#0000ff",
          strokeOpacity: 1,
          strokeWidth: 2,
          fill: "#0000ff",
          fillOpacity: 0.25,
        },
      },
    ];

    const expected = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Overlay &amp; &lt;Ops&gt;</name>
    <Placemark>
      <name>HQ &quot;Alpha&quot;</name>
      <description>Main &lt;CP&gt;</description>
      <Style>
        <IconStyle><color>ff0000ff</color><scale>1.1</scale></IconStyle>
      </Style>
      <Point><coordinates>-117.25,34.5,0</coordinates></Point>
    </Placemark>
    <Placemark>
      <name>Phase Line</name>
      <Style>
        <LineStyle><color>8000ff00</color><width>3</width></LineStyle>
      </Style>
      <LineString><tessellate>1</tessellate><coordinates>-117,34,0 -116.5,34.2,0</coordinates></LineString>
    </Placemark>
    <Placemark>
      <name>AO Bravo</name>
      <Style>
        <LineStyle><color>ffff0000</color><width>2</width></LineStyle>
        <PolyStyle><color>40ff0000</color></PolyStyle>
      </Style>
      <Polygon>
        <outerBoundaryIs><LinearRing><coordinates>-117,34,0 -117,35,0 -116,35,0 -117,34,0</coordinates></LinearRing></outerBoundaryIs>
        <innerBoundaryIs><LinearRing><coordinates>-116.9,34.4,0 -116.8,34.6,0 -116.7,34.4,0 -116.9,34.4,0</coordinates></LinearRing></innerBoundaryIs>
      </Polygon>
    </Placemark>
  </Document>
</kml>
`;

    expect(buildKmlDocument("Overlay & <Ops>", features)).toBe(expected);
  });

  it("uses aabbggrr color order (red #ff0000 @1 -> ff0000ff)", () => {
    const marker: MapFeature = {
      id: "m1",
      kind: "marker",
      name: "Red",
      geometry: { type: "Point", coordinates: [0, 0] },
      style: { stroke: "#ff0000", strokeOpacity: 1, strokeWidth: 2 },
    };
    const xml = buildKmlDocument("doc", [marker]);
    expect(xml).toContain("<color>ff0000ff</color>");
    expect(xml).not.toContain("<color>ffff0000</color>");
  });

  it("renders routes as tessellated LineStrings", () => {
    const route: MapFeature = {
      id: "r1",
      kind: "route",
      name: "Route",
      geometry: {
        type: "LineString",
        coordinates: [
          [-117, 34],
          [-116, 34.5],
        ],
      },
      style: { stroke: "#ff0000", strokeOpacity: 1, strokeWidth: 3 },
    };
    const xml = buildKmlDocument("doc", [route]);
    expect(xml).toContain("<LineString><tessellate>1</tessellate>");
  });

  it("escapes XML-hostile names like A & B <\"test\">", () => {
    const marker: MapFeature = {
      id: "m1",
      kind: "marker",
      name: 'A & B <"test">',
      geometry: { type: "Point", coordinates: [0, 0] },
      style: { stroke: "#ff0000", strokeOpacity: 1, strokeWidth: 2 },
    };
    const xml = buildKmlDocument('A & B <"test">', [marker]);
    expect(xml).toContain("<name>A &amp; B &lt;&quot;test&quot;&gt;</name>");
    expect(xml).not.toContain('<name>A & B <"test"></name>');
  });

  it("tessellates circles to a closed 65-point ring", () => {
    const ring = circleRing([10, 45], 1000);
    expect(ring).toHaveLength(65);
    expect(ring[0]).toEqual(ring[ring.length - 1]);

    const circle: MapFeature = {
      id: "c1",
      kind: "circle",
      name: "Circle",
      geometry: { type: "Point", coordinates: [10, 45] },
      radiusM: 1000,
      style: {
        stroke: "#ff0000",
        strokeOpacity: 1,
        strokeWidth: 2,
        fill: "#ff0000",
        fillOpacity: 0.25,
      },
    };
    const xml = buildKmlDocument("doc", [circle]);
    const m = /<outerBoundaryIs><LinearRing><coordinates>([^<]*)<\/coordinates>/.exec(xml);
    expect(m).not.toBeNull();
    const coords = m![1].split(" ");
    expect(coords).toHaveLength(65);
    expect(coords[0]).toBe(coords[coords.length - 1]);
    expect(xml).not.toContain("NetworkLink");
    expect(xml).not.toContain("<Region");
  });
});
