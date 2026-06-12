import { describe, expect, it } from "vitest";
import { buildManifestXml } from "../src/export/manifest.js";
import type { ManifestEntry } from "../src/types.js";

describe("buildManifestXml", () => {
  it("emits the exact MissionPackageManifest v2 document", () => {
    const entries: ManifestEntry[] = [
      { zipEntry: "u1/imagery.gpkg", name: "imagery.gpkg" },
      {
        zipEntry: "u2/marker1.cot",
        name: "marker1.cot",
        uid: "evt-uid-1",
        isCot: true,
      },
      {
        zipEntry: "u3/overlay.kml",
        name: "overlay.kml",
        contentType: "KML",
        visible: true,
      },
    ];

    const expected = `<?xml version="1.0" encoding="UTF-8"?>
<MissionPackageManifest version="2">
  <Configuration>
    <Parameter name="uid" value="pkg-uid-1234"/>
    <Parameter name="name" value="Op Anvil"/>
  </Configuration>
  <Contents>
    <Content ignore="false" zipEntry="u1/imagery.gpkg">
      <Parameter name="name" value="imagery.gpkg"/>
    </Content>
    <Content ignore="false" zipEntry="u2/marker1.cot">
      <Parameter name="name" value="marker1.cot"/>
      <Parameter name="uid" value="evt-uid-1"/>
      <Parameter name="isCoT" value="true"/>
    </Content>
    <Content ignore="false" zipEntry="u3/overlay.kml">
      <Parameter name="name" value="overlay.kml"/>
      <Parameter name="contentType" value="KML"/>
      <Parameter name="visible" value="true"/>
    </Content>
  </Contents>
</MissionPackageManifest>
`;

    expect(buildManifestXml("pkg-uid-1234", "Op Anvil", entries)).toBe(expected);
  });

  it("XML-escapes every attribute value", () => {
    const xml = buildManifestXml('uid<"&">', 'A & B <"test">', [
      { zipEntry: "u1/a&b.cot", name: 'A & B <"test">', uid: "u<1>", isCot: true },
    ]);
    expect(xml).toContain('value="A &amp; B &lt;&quot;test&quot;&gt;"');
    expect(xml).toContain('value="uid&lt;&quot;&amp;&quot;&gt;"');
    expect(xml).toContain('zipEntry="u1/a&amp;b.cot"');
    expect(xml).toContain('value="u&lt;1&gt;"');
    // No raw special chars may survive inside attribute values
    // (& is only legal as part of an entity reference).
    expect(xml).not.toMatch(/value="[^"]*(<|>|&(?!(amp|lt|gt|quot|apos);))[^"]*"/);
  });

  it("strips XML-illegal control characters while preserving tab/LF/CR", () => {
    const ctl = String.fromCharCode;
    // Form feed + BEL in the package name, NUL/unit-separator/VT in entries —
    // all illegal in XML 1.0 even when escaped; they must be stripped so the
    // manifest stays parseable on the device.
    const xml = buildManifestXml("u", `Op${ctl(12)}Anvil${ctl(7)}`, [
      {
        zipEntry: "u1/a.cot",
        name: `N${ctl(0)}ame${ctl(31)}`,
        uid: `u${ctl(11)}1${ctl(127)}`,
        isCot: true,
      },
    ]);
    expect(xml).toContain('value="OpAnvil"');
    expect(xml).toContain('value="Name"');
    expect(xml).toContain('value="u1"');
    for (const code of [0, 7, 11, 12, 31, 127]) {
      expect(xml).not.toContain(ctl(code));
    }
    // Legal XML whitespace must survive the strip.
    const tabbed = buildManifestXml("u", `a${ctl(9)}b`, []);
    expect(tabbed).toContain(`a${ctl(9)}b`);
  });

  it("emits visible=false explicitly when set", () => {
    const xml = buildManifestXml("u", "n", [
      { zipEntry: "u1/o.kml", name: "o.kml", contentType: "KML", visible: false },
    ]);
    expect(xml).toContain('<Parameter name="visible" value="false"/>');
  });
});
