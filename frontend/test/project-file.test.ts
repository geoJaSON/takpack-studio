import { describe, expect, it } from "vitest";
import {
  PROJECT_VERSION,
  parseProjectFile,
  projectFileName,
  serializeProject,
  type ProjectSnapshot,
} from "../src/lib/project-file";
import type { MapFeature } from "../src/types";

const marker: MapFeature = {
  id: "11111111-1111-4111-8111-111111111111",
  kind: "marker",
  name: "RP North",
  noteIcon: "flag",
  geometry: { type: "Point", coordinates: [-111.04, 40.22] },
  style: { stroke: "#ffaa00", strokeOpacity: 1, strokeWidth: 2 },
  attachments: [{ name: "p.jpg", contentType: "image/jpeg", base64: "AAAA" }],
};

const rbLine: MapFeature = {
  id: "22222222-2222-4222-8222-222222222222",
  kind: "line",
  name: "RB",
  rangeBearing: true,
  geometry: {
    type: "LineString",
    coordinates: [
      [-111.05, 40.2],
      [-111.0, 40.2],
    ],
  },
  style: { stroke: "#ff0000", strokeOpacity: 1, strokeWidth: 2 },
};

const snapshot: ProjectSnapshot = {
  view: { center: [-111.891, 40.761], zoom: 13, basemapId: "osm" },
  aoi: { north: 40.3, south: 40.1, east: -110.9, west: -111.1 },
  features: [marker, rbLine],
  commsPlan: {
    nets: [{ name: "CMD", frequency: "30.00", callsign: "BASE" }],
    pace: { primary: "VHF", alternate: "HF", contingency: "SAT", emergency: "RUNNER" },
    identity: { callsign: "ALPHA" },
    medevac: {},
    notes: "",
  },
  supportDocIds: ["comms", "pace"],
  includePref: true,
  includeCasevacMarker: false,
};

describe("project file round-trip", () => {
  it("serializes and parses back to the same snapshot (incl. attachments + rangeBearing)", () => {
    const { snapshot: parsed, warnings } = parseProjectFile(
      serializeProject(snapshot, new Date("2026-06-14T00:00:00Z")),
    );
    expect(warnings).toEqual([]);
    expect(parsed).toEqual(snapshot);
    expect(parsed.features[0].attachments).toHaveLength(1);
    expect(parsed.features[1].rangeBearing).toBe(true);
  });

  it("stamps format, version, and savedAt", () => {
    const obj = JSON.parse(
      serializeProject(snapshot, new Date("2026-06-14T12:00:00Z")),
    );
    expect(obj.format).toBe("takpack-studio-project");
    expect(obj.version).toBe(PROJECT_VERSION);
    expect(obj.savedAt).toBe("2026-06-14T12:00:00.000Z");
  });
});

describe("parseProjectFile validation", () => {
  it("rejects non-JSON", () => {
    expect(() => parseProjectFile("not json {")).toThrow(/valid JSON/);
  });

  it("rejects a file that isn't a TAKPack project", () => {
    expect(() => parseProjectFile(JSON.stringify({ hello: 1 }))).toThrow(
      /TAKPack Studio project/,
    );
  });

  it("rejects a project saved by a newer version", () => {
    const future = JSON.stringify({
      format: "takpack-studio-project",
      version: PROJECT_VERSION + 1,
      features: [],
    });
    expect(() => parseProjectFile(future)).toThrow(/newer version/);
  });

  it("drops malformed features with a warning instead of failing the load", () => {
    const file = JSON.stringify({
      format: "takpack-studio-project",
      version: PROJECT_VERSION,
      features: [
        marker,
        { id: "x", kind: "banana", name: "bad" },
        { kind: "marker" },
      ],
    });
    const { snapshot: parsed, warnings } = parseProjectFile(file);
    expect(parsed.features).toHaveLength(1);
    expect(parsed.features[0].id).toBe(marker.id);
    expect(warnings[0]).toMatch(/Skipped 2 unreadable feature/);
  });

  it("filters unknown supportDocIds and falls back on a missing view", () => {
    const file = JSON.stringify({
      format: "takpack-studio-project",
      version: PROJECT_VERSION,
      features: [],
      supportDocIds: ["comms", "bogus"],
    });
    const { snapshot: parsed } = parseProjectFile(file);
    expect(parsed.supportDocIds).toEqual(["comms"]);
    expect(parsed.view.basemapId).toBe("osm");
    expect(parsed.aoi).toBeNull();
  });
});

describe("projectFileName", () => {
  it("produces a safe .takproj.json name", () => {
    expect(projectFileName("Op Anvil!")).toBe("Op_Anvil.takproj.json");
    expect(projectFileName("   ")).toBe("takpack-project.takproj.json");
  });
});
