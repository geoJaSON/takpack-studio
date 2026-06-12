import ms from "milsymbol";
import * as L from "leaflet";
import type { Affiliation } from "../types";

/**
 * milsymbol helpers and the MIL-STD-2525C marker catalog.
 * SIDCs are normalized to the standard 15 characters; affiliation is applied
 * dynamically (SIDC char index 1) so one catalog serves all four affiliations.
 */

export interface SymbolEntry {
  sidc: string;
  name: string;
}

export interface SymbolCategory {
  name: string;
  symbols: SymbolEntry[];
}

/** Pad/trim a letter-based 2525C SIDC to the standard 15 characters. */
export function normalizeSidc(sidc: string): string {
  return (sidc + "---------------").slice(0, 15);
}

const AFFILIATION_CHAR: Record<Affiliation, string> = {
  friendly: "F",
  hostile: "H",
  neutral: "N",
  unknown: "U",
};

/** UI metadata for the affiliation segmented controls. */
export const AFFILIATIONS: { id: Affiliation; label: string; color: string }[] = [
  { id: "friendly", label: "F", color: "#38bdf8" },
  { id: "hostile", label: "H", color: "#ef4444" },
  { id: "neutral", label: "N", color: "#4ade80" },
  { id: "unknown", label: "U", color: "#facc15" },
];

/** Returns `sidc` with the affiliation character (index 1) replaced. */
export function applyAffiliation(sidc: string, affiliation: Affiliation): string {
  const s = normalizeSidc(sidc);
  return s.charAt(0) + AFFILIATION_CHAR[affiliation] + s.slice(2);
}

/** True when two SIDCs are the same symbol ignoring affiliation (char 1). */
export function sameSymbol(a: string, b: string): boolean {
  const na = normalizeSidc(a);
  const nb = normalizeSidc(b);
  return na.charAt(0) === nb.charAt(0) && na.slice(2) === nb.slice(2);
}

function cat(
  name: string,
  entries: ReadonlyArray<readonly [sidc: string, name: string]>,
): SymbolCategory {
  return {
    name,
    symbols: entries.map(([sidc, symbolName]) => ({
      sidc: normalizeSidc(sidc),
      name: symbolName,
    })),
  };
}

/** Ported from Tactical-Map-Pack milsymbol-utils COMMON_SYMBOLS (markers only). */
export const SYMBOL_CATEGORIES: SymbolCategory[] = [
  cat("Infantry & Armor", [
    ["SFG-UCI----", "Infantry"],
    ["SFG-UCIM---", "Mech Infantry"],
    ["SFG-UCA----", "Armor"],
    ["SFG-UCAT---", "Anti-Armor"],
    ["SFG-UCR----", "Recon"],
    ["SFG-UCAA---", "Air Assault"],
    ["SFG-UCAAA--", "Airborne"],
  ]),
  cat("Fires & Aviation", [
    ["SFG-UCF----", "Field Artillery"],
    ["SFG-UCAAD--", "Air Defense"],
    ["SFG-UCVR---", "Rotary Wing"],
    ["SFG-UCVF---", "Fixed Wing"],
    ["SFG-UCVRH--", "Attack Helo"],
    ["SFG-UCVU---", "UAV"],
  ]),
  cat("Combat Support", [
    ["SFG-UCE----", "Engineer"],
    ["SFG-UCS----", "Signal"],
    ["SFG-UCIZ---", "MP"],
    ["SFG-UCXE---", "CBRN"],
    ["SFG-USC----", "Civil Affairs"],
    ["SFG-USP----", "PsyOps"],
  ]),
  cat("C2, CSS & Medical", [
    ["SFG-UCI--H-", "HQ / CP"],
    ["SFG-USS----", "Supply"],
    ["SFG-UCM----", "Medical"],
    ["SFG-USMM---", "Maintenance"],
    ["SFG-USTM---", "Transport"],
    ["SFF-UCI----", "Special Forces"],
  ]),
  cat("Hostile — Ground", [
    ["SHG-UCI----", "Infantry"],
    ["SHG-UCIM---", "Mech Infantry"],
    ["SHG-UCA----", "Armor"],
    ["SHG-UCF----", "Artillery"],
    ["SHG-UCAAD--", "Air Defense"],
    ["SHG-UCR----", "Recon"],
  ]),
  cat("Hostile — Air & Other", [
    ["SHA-MFHA---", "Attack Helo"],
    ["SHA-MFF----", "Fixed Wing"],
    ["SUG-UC-----", "Unknown Ground"],
    ["SUA--------", "Unknown Air"],
    ["SSG-UC-----", "Suspected"],
  ]),
  cat("Neutral & Unknown", [
    ["SNG-UC-----", "Neutral Ground"],
    ["SNA--------", "Neutral Air"],
    ["SUG--------", "Unknown Ground"],
    ["SNG-EVC----", "Civilian"],
  ]),
  cat("Installations & Sites", [
    ["SFG-IBF----", "Forward Base"],
    ["SFG-IBP----", "COP / Patrol Base"],
    ["SFG-IBM----", "Aid Station"],
    ["SFG-IBA----", "Airfield"],
    ["SFG-IBOS---", "Supply Depot"],
    ["SFG-IBOF---", "Fuel Point"],
  ]),
  cat("Equipment & Vehicles", [
    ["SFG-EVCA---", "Tank"],
    ["SFG-EVCAH--", "APC"],
    ["SFG-EVT----", "Truck"],
    ["SFG-EVH----", "Helicopter"],
    ["SFG-EVCA-F-", "Artillery Piece"],
    ["SHG-EVC----", "Hostile Vehicle"],
  ]),
];

/** Base64 SVG data URL for <img> previews (palette, feature rows). */
export function getSymbolDataUrl(sidc: string, size?: number): string {
  const svg = new ms.Symbol(sidc, { size: size ?? 28 }).asSVG();
  // btoa() only handles Latin-1; round-trip through UTF-8 percent-escapes first.
  return "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(svg)));
}

/** Leaflet DivIcon anchored at the milsymbol anchor point (octagon center). */
export function makeSymbolDivIcon(sidc: string, selected: boolean): L.DivIcon {
  const sym = new ms.Symbol(sidc, { size: 28 });
  const anchor = sym.getAnchor();
  const size = sym.getSize();
  return L.divIcon({
    html: sym.asSVG(),
    className: "milsymbol-icon" + (selected ? " selected" : ""),
    iconSize: [size.width, size.height],
    iconAnchor: [anchor.x, anchor.y],
  });
}
