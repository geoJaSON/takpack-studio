import type {
  Aoi,
  CommsIdentity,
  CommsPlan,
  Medevac9Line,
  SupportDocId,
} from "../types.js";
import { esc } from "./xml.js";

/**
 * Generators for the comms/PACE/MEDEVAC reference cards (printable HTML), the
 * Op checklist, and the ATAK `config.pref` (callsign/team/role/server, applied
 * silently by ATAK's ImportPrefSort on import). The CASEVAC CoT marker lives in
 * cot-writer.ts; this module is the document/preference side.
 */

const CARD_CSS =
  "body{font-family:Arial,Helvetica,sans-serif;margin:24px;line-height:1.45;color:#111}" +
  "h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:18px 0 6px}" +
  ".meta{color:#555;font-size:12px;margin:0 0 12px}" +
  "table{border-collapse:collapse;width:100%;margin:6px 0 14px}" +
  "td,th{border:1px solid #999;padding:6px 8px;text-align:left;vertical-align:top;font-size:13px}" +
  "th{background:#eee}.k{background:#f3f3f3;font-weight:bold;width:32%}" +
  "pre{white-space:pre-wrap;background:#f6f6f6;border:1px solid #ddd;padding:8px;font-size:12px}" +
  "@media print{body{margin:10mm}}";

function htmlDoc(title: string, packageName: string, body: string): string {
  return [
    "<!doctype html>",
    '<html><head><meta charset="utf-8">',
    `<title>${esc(packageName)} — ${esc(title)}</title>`,
    `<style>${CARD_CSS}</style>`,
    "</head><body>",
    `<h1>${esc(title)}</h1>`,
    `<p class="meta">Package: ${esc(packageName)}</p>`,
    body,
    "</body></html>",
    "",
  ].join("\n");
}

function notesBlock(notes: string | undefined): string {
  return notes && notes.trim()
    ? `<h2>Notes</h2><pre>${esc(notes)}</pre>`
    : "";
}

function commsCardHtml(plan: CommsPlan, packageName: string): string {
  const nets = plan.nets ?? [];
  const rows =
    nets.length > 0
      ? nets
          .map(
            (n) =>
              `<tr><td>${esc(n.name)}</td><td>${esc(n.frequency)}</td><td>${esc(n.callsign)}</td><td>${esc(n.notes ?? "")}</td></tr>`,
          )
          .join("")
      : '<tr><td colspan="4" style="color:#888">No nets entered</td></tr>';
  const body = [
    "<h2>Communications Nets</h2>",
    "<table><thead><tr><th>Net / Channel</th><th>Frequency</th><th>Callsign</th><th>Notes</th></tr></thead>",
    `<tbody>${rows}</tbody></table>`,
    notesBlock(plan.notes),
  ].join("\n");
  return htmlDoc("Comms Plan", packageName, body);
}

function paceCardHtml(plan: CommsPlan, packageName: string): string {
  const p = plan.pace ?? { primary: "", alternate: "", contingency: "", emergency: "" };
  const row = (k: string, v: string) =>
    `<tr><td class="k">${esc(k)}</td><td>${esc(v) || "&mdash;"}</td></tr>`;
  const body = [
    "<h2>PACE Plan</h2>",
    "<table><tbody>",
    row("Primary", p.primary),
    row("Alternate", p.alternate),
    row("Contingency", p.contingency),
    row("Emergency", p.emergency),
    "</tbody></table>",
    notesBlock(plan.notes),
  ].join("\n");
  return htmlDoc("PACE Plan", packageName, body);
}

/** Ordered 9-line label + value pairs for the card. */
export function medevacLines(m: Medevac9Line): { label: string; value: string }[] {
  const line2 = [m.freq, m.callsign].filter((s) => s && s.trim()).join(" / ");
  return [
    { label: "Line 1 — Pickup location", value: m.location ?? "" },
    { label: "Line 2 — Frequency / callsign", value: line2 },
    { label: "Line 3 — Patients by precedence", value: m.precedence ?? "" },
    { label: "Line 4 — Special equipment", value: m.equipment ?? "" },
    { label: "Line 5 — Patients by type (L/A)", value: m.patientType ?? "" },
    { label: "Line 6 — Security at pickup", value: m.security ?? "" },
    { label: "Line 7 — Marking method", value: m.marking ?? "" },
    { label: "Line 8 — Patient nationality/status", value: m.nationality ?? "" },
    { label: "Line 9 — Terrain / obstacles (or CBRN)", value: m.terrain ?? "" },
  ];
}

function medevacCardHtml(plan: CommsPlan, packageName: string): string {
  const m = plan.medevac ?? {};
  const rows = medevacLines(m)
    .map(
      (l) =>
        `<tr><td class="k">${esc(l.label)}</td><td>${esc(l.value) || "&mdash;"}</td></tr>`,
    )
    .join("");
  const body = [
    "<h2>MEDEVAC 9-Line</h2>",
    `<table><tbody>${rows}</tbody></table>`,
    notesBlock(plan.notes),
  ].join("\n");
  return htmlDoc("MEDEVAC 9-Line", packageName, body);
}

function checklistHtml(packageName: string, aoi: Aoi): string {
  const items = [
    "Package imported and visible in ATAK",
    "Offline imagery (GeoPackage) renders at expected zooms",
    "Markers / routes / shapes present and editable",
    "Comms + PACE confirmed on net",
    "MEDEVAC plan briefed",
    "config.pref applied (callsign / team / server, if included)",
    "Attachments open on device",
  ];
  const body = [
    `<p class="meta">AOI: N ${aoi.north.toFixed(5)}, S ${aoi.south.toFixed(5)}, E ${aoi.east.toFixed(5)}, W ${aoi.west.toFixed(5)}</p>`,
    "<h2>Pre-Mission Checklist</h2>",
    "<table><tbody>",
    items.map((i) => `<tr><td style="width:28px;text-align:center">☐</td><td>${esc(i)}</td></tr>`).join(""),
    "</tbody></table>",
  ].join("\n");
  return htmlDoc("Op Checklist", packageName, body);
}

export interface SupportCard {
  id: SupportDocId;
  fileBase: string;
  html: string;
}

/** Build the HTML cards selected in supportDocIds, filled from commsPlan. */
export function buildSupportCards(
  ids: SupportDocId[],
  plan: CommsPlan,
  packageName: string,
  aoi: Aoi,
): SupportCard[] {
  const out: SupportCard[] = [];
  for (const id of ids) {
    switch (id) {
      case "comms":
        out.push({ id, fileBase: "comms-plan", html: commsCardHtml(plan, packageName) });
        break;
      case "pace":
        out.push({ id, fileBase: "pace-plan", html: paceCardHtml(plan, packageName) });
        break;
      case "medevac":
        out.push({ id, fileBase: "medevac-9line", html: medevacCardHtml(plan, packageName) });
        break;
      case "checklist":
        out.push({ id, fileBase: "op-checklist", html: checklistHtml(packageName, aoi) });
        break;
    }
  }
  return out;
}

// ── ATAK config.pref ─────────────────────────────────────────────────────────

function prefEntry(key: string, cls: string, value: string): string {
  return `    <entry key="${esc(key)}" class="${cls}">${esc(value)}</entry>`;
}

/** True when identity has anything worth writing to a .pref. */
export function hasPrefContent(identity: CommsIdentity | undefined): boolean {
  if (!identity) return false;
  return Boolean(
    identity.callsign?.trim() ||
      identity.team?.trim() ||
      identity.role?.trim() ||
      identity.serverHost?.trim(),
  );
}

/**
 * Build an ATAK `config.pref`. Identity entries go in `com.atakmap.app_preferences`;
 * a TAK-server endpoint (if provided) goes in `cot_streams`. Applied silently on
 * local import by ImportPrefSort.
 */
export function buildConfigPref(identity: CommsIdentity): string {
  const appEntries: string[] = [];
  const S = "class java.lang.String";
  if (identity.callsign?.trim())
    appEntries.push(prefEntry("locationCallsign", S, identity.callsign.trim()));
  if (identity.team?.trim())
    appEntries.push(prefEntry("locationTeam", S, identity.team.trim()));
  if (identity.role?.trim())
    appEntries.push(prefEntry("atakRoleType", S, identity.role.trim()));

  const blocks: string[] = [];
  if (appEntries.length > 0) {
    blocks.push(
      `  <preference version="1" name="com.atakmap.app_preferences">\n${appEntries.join("\n")}\n  </preference>`,
    );
  }
  const host = identity.serverHost?.trim();
  if (host) {
    const port = (identity.serverPort?.trim() || "8089").replace(/[^0-9]/g, "") || "8089";
    const proto = identity.serverProto === "tcp" ? "tcp" : "ssl";
    const name = identity.serverName?.trim() || "Mission Server";
    const streamEntries = [
      prefEntry("count", "class java.lang.Integer", "1"),
      prefEntry("description0", S, name),
      prefEntry("enabled0", "class java.lang.Boolean", "true"),
      prefEntry("connectString0", S, `${host}:${port}:${proto}`),
    ];
    blocks.push(
      `  <preference version="1" name="cot_streams">\n${streamEntries.join("\n")}\n  </preference>`,
    );
  }
  return [
    "<?xml version='1.0' encoding='ASCII' standalone='yes'?>",
    "<preferences>",
    blocks.join("\n"),
    "</preferences>",
    "",
  ].join("\n");
}
