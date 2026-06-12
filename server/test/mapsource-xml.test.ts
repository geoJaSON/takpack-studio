import { describe, expect, it } from "vitest";
import { buildMapSourceXml } from "../src/export/mapsource-xml.js";
import type { ImagerySourceDef } from "../src/types.js";

function source(overrides: Partial<ImagerySourceDef> = {}): ImagerySourceDef {
  return {
    id: "test-xyz",
    name: "Test Tiles",
    description: "test source",
    category: "free",
    attribution: "© Test",
    license: "test license",
    streamOnly: true,
    strategy: "xyz",
    tileUrlTemplate: "https://tile.example.com/{z}/{x}/{y}.jpg",
    minZoom: 0,
    maxZoom: 19,
    defaultTileFormat: "jpeg",
    ...overrides,
  };
}

describe("buildMapSourceXml", () => {
  it("emits the exact customMapSource document", () => {
    const expected = `<?xml version="1.0" encoding="UTF-8"?>
<customMapSource>
    <name>Test Tiles</name>
    <minZoom>0</minZoom>
    <maxZoom>19</maxZoom>
    <tileType>jpg</tileType>
    <url><![CDATA[https://tile.example.com/{$z}/{$x}/{$y}.jpg]]></url>
</customMapSource>
`;
    expect(buildMapSourceXml(source())).toBe(expected);
  });

  it("preserves ArcGIS {z}/{y}/{x} placeholder order", () => {
    const xml = buildMapSourceXml(
      source({
        tileUrlTemplate:
          "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
      }),
    );
    expect(xml).toContain("/tile/{$z}/{$y}/{$x}]]>");
  });

  it("escapes the source name and maps png tileType", () => {
    const xml = buildMapSourceXml(
      source({ name: 'A & B <"test">', defaultTileFormat: "png" }),
    );
    expect(xml).toContain("<name>A &amp; B &lt;&quot;test&quot;&gt;</name>");
    expect(xml).toContain("<tileType>png</tileType>");
  });

  it("substitutes {key} only with explicit opt-in plus a key", () => {
    const keyed = source({
      tileUrlTemplate: "https://api.example.com/{z}/{x}/{y}.png?key={key}",
      defaultTileFormat: "png",
    });
    const xml = buildMapSourceXml(keyed, { apiKey: "SECRET", includeKey: true });
    expect(xml).toContain(
      "<url><![CDATA[https://api.example.com/{$z}/{$x}/{$y}.png?key=SECRET]]></url>",
    );
    expect(xml).not.toContain("{key}");
  });

  it("throws for {key} templates without opt-in or without a key", () => {
    const keyed = source({
      tileUrlTemplate: "https://api.example.com/{z}/{x}/{y}.png?key={key}",
    });
    expect(() => buildMapSourceXml(keyed)).toThrow(/includeKey/);
    expect(() => buildMapSourceXml(keyed, { apiKey: "SECRET" })).toThrow(
      /includeKey/,
    );
    expect(() => buildMapSourceXml(keyed, { includeKey: true })).toThrow(
      /includeKey/,
    );
  });

  it("throws when the source has no tileUrlTemplate", () => {
    expect(() =>
      buildMapSourceXml(source({ tileUrlTemplate: undefined })),
    ).toThrow(/tileUrlTemplate/);
  });
});
