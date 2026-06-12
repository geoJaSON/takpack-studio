import type { ManifestEntry } from "../types.js";
import { esc } from "./xml.js";

/**
 * MANIFEST/manifest.xml for an ATAK data package (MissionPackageManifest v2).
 * zipEntry values must byte-for-byte match archive entry paths
 * (forward slashes, no leading slash) — the caller guarantees that.
 */
export function buildManifestXml(
  packageUid: string,
  packageName: string,
  entries: ManifestEntry[],
): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<MissionPackageManifest version="2">',
    "  <Configuration>",
    `    <Parameter name="uid" value="${esc(packageUid)}"/>`,
    `    <Parameter name="name" value="${esc(packageName)}"/>`,
    "  </Configuration>",
    "  <Contents>",
  ];
  for (const entry of entries) {
    lines.push(
      `    <Content ignore="false" zipEntry="${esc(entry.zipEntry)}">`,
      `      <Parameter name="name" value="${esc(entry.name)}"/>`,
    );
    if (entry.uid !== undefined) {
      lines.push(`      <Parameter name="uid" value="${esc(entry.uid)}"/>`);
    }
    if (entry.isCot) {
      lines.push('      <Parameter name="isCoT" value="true"/>');
    }
    if (entry.contentType !== undefined) {
      lines.push(
        `      <Parameter name="contentType" value="${esc(entry.contentType)}"/>`,
      );
    }
    if (entry.visible !== undefined) {
      lines.push(
        `      <Parameter name="visible" value="${entry.visible ? "true" : "false"}"/>`,
      );
    }
    lines.push("    </Content>");
  }
  lines.push("  </Contents>", "</MissionPackageManifest>", "");
  return lines.join("\n");
}
