import { describe, expect, it } from "vitest";
import {
  buildConfigPref,
  buildSupportCards,
  hasPrefContent,
} from "../src/export/comms-docs.js";
import { buildCasevacEvent } from "../src/export/cot-writer.js";
import type { Aoi, CommsPlan } from "../src/types.js";

const AOI: Aoi = { north: 40.78, south: 40.74, east: -111.86, west: -111.92 };

describe("buildConfigPref", () => {
  it("emits app_preferences (callsign/team/role) and cot_streams", () => {
    const pref = buildConfigPref({
      callsign: "RAVEN01",
      team: "Cyan",
      role: "Team Lead",
      serverHost: "tak.example.com",
      serverPort: "8089",
      serverProto: "ssl",
      serverName: "Mission",
    });
    expect(pref).toContain('name="com.atakmap.app_preferences"');
    expect(pref).toContain('key="locationCallsign" class="class java.lang.String">RAVEN01<');
    expect(pref).toContain('key="locationTeam" class="class java.lang.String">Cyan<');
    expect(pref).toContain('key="atakRoleType" class="class java.lang.String">Team Lead<');
    expect(pref).toContain('name="cot_streams"');
    expect(pref).toContain(">tak.example.com:8089:ssl<");
  });

  it("omits cot_streams when no server host is given", () => {
    const pref = buildConfigPref({ callsign: "X" });
    expect(pref).not.toContain("cot_streams");
  });

  it("escapes XML and sanitizes the port", () => {
    const pref = buildConfigPref({ callsign: 'A & B <x>', serverHost: "h", serverPort: "80a9" });
    expect(pref).toContain("A &amp; B &lt;x&gt;");
    expect(pref).toContain(">h:809:ssl<"); // non-digits stripped from port
  });

  it("hasPrefContent reflects whether anything is set", () => {
    expect(hasPrefContent(undefined)).toBe(false);
    expect(hasPrefContent({})).toBe(false);
    expect(hasPrefContent({ callsign: "X" })).toBe(true);
    expect(hasPrefContent({ serverHost: "h" })).toBe(true);
  });
});

describe("buildSupportCards", () => {
  it("generates filled comms / pace / medevac cards + checklist", () => {
    const plan: CommsPlan = {
      nets: [{ name: "Command", frequency: "30.1", callsign: "RAVEN MAIN" }],
      pace: { primary: "VHF", alternate: "HF", contingency: "SAT", emergency: "Cell" },
      medevac: { freq: "30.55", callsign: "DUSTOFF", precedence: "2 Urgent" },
      notes: "auth per SOI",
    };
    const cards = buildSupportCards(
      ["comms", "pace", "medevac", "checklist"],
      plan,
      "OP TEST",
      AOI,
    );
    expect(cards.map((c) => c.id).sort()).toEqual(["checklist", "comms", "medevac", "pace"]);
    const byId = Object.fromEntries(cards.map((c) => [c.id, c.html]));
    expect(byId.comms).toContain("RAVEN MAIN");
    expect(byId.comms).toContain("auth per SOI");
    expect(byId.pace).toContain("VHF");
    expect(byId.medevac).toContain("30.55 / DUSTOFF");
    expect(byId.medevac).toContain("2 Urgent");
    // escaping
    const esc = buildSupportCards(["comms"], { nets: [{ name: "A & B", frequency: "<x>", callsign: "C" }] }, "P", AOI);
    expect(esc[0].html).toContain("A &amp; B");
    expect(esc[0].html).not.toContain("<x>");
  });
});

describe("buildCasevacEvent", () => {
  const det = { now: () => new Date("2026-01-02T03:04:05.000Z") };
  it("emits a b-r-f-h-c marker with a _medevac_ detail and 9-line remarks", () => {
    const { uid, xml } = buildCasevacEvent(
      {
        location: "12S VK 1 2",
        freq: "30.55",
        callsign: "DUSTOFF 6",
        precedence: "2 Urgent",
        patientType: "2 Litter",
      },
      { lat: 40.76, lon: -111.89 },
      det,
    );
    expect(uid).toBeTruthy();
    expect(xml).toContain('type="b-r-f-h-c"');
    expect(xml).toContain('how="h-g-i-g-o"');
    expect(xml).toContain('<contact callsign="DUSTOFF 6"/>');
    expect(xml).toContain("<_medevac_ ");
    expect(xml).toContain('casevac="true"');
    expect(xml).toContain('freq="30.55"');
    expect(xml).toContain("2 Urgent");
    expect(xml).toContain("2 Litter");
  });

  it("falls back to the AOI center when no marker position is given", () => {
    const { xml } = buildCasevacEvent({ freq: "1" }, { lat: 12.5, lon: -34.25 }, det);
    expect(xml).toContain('lat="12.5"');
    expect(xml).toContain('lon="-34.25"');
    expect(xml).toContain('callsign="CASEVAC"'); // default callsign
  });
});
