import type { ImagerySourceDef } from "../types.js";
import { esc } from "./xml.js";

export interface MapSourceXmlOptions {
  apiKey?: string;
  /** Explicit user opt-in to embed the key in the emitted XML. */
  includeKey?: boolean;
}

/**
 * MOBAC customMapSource XML for a streaming source. Throws when the URL
 * template requires an API key and the caller has not explicitly opted in
 * (callers filter key-bearing sources out instead of catching).
 */
export function buildMapSourceXml(
  source: ImagerySourceDef,
  opts: MapSourceXmlOptions = {},
): string {
  const template = source.tileUrlTemplate;
  if (!template) {
    throw new Error(
      `source ${source.id} has no tileUrlTemplate; cannot emit map-source XML`,
    );
  }

  let url = template;
  if (url.includes("{key}")) {
    if (!opts.includeKey || !opts.apiKey) {
      throw new Error(
        `source ${source.id} URL requires an API key; refusing to emit map-source XML without explicit includeKey opt-in and a key`,
      );
    }
    url = url.split("{key}").join(opts.apiKey);
  }

  // {z}/{x}/{y} → MOBAC {$z}/{$x}/{$y}. Per-token replacement preserves
  // placeholder order (ArcGIS /tile/{z}/{y}/{x} keeps y before x).
  url = url
    .replace(/\{z\}/g, "{$z}")
    .replace(/\{x\}/g, "{$x}")
    .replace(/\{y\}/g, "{$y}");

  // A literal "]]>" in the URL would terminate the CDATA section early.
  const cdataSafeUrl = url.split("]]>").join("]]]]><![CDATA[>");
  const tileType = source.defaultTileFormat === "png" ? "png" : "jpg";

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<customMapSource>",
    `    <name>${esc(source.name)}</name>`,
    `    <minZoom>${String(source.minZoom)}</minZoom>`,
    `    <maxZoom>${String(source.maxZoom)}</maxZoom>`,
    `    <tileType>${tileType}</tileType>`,
    `    <url><![CDATA[${cdataSafeUrl}]]></url>`,
    "</customMapSource>",
    "",
  ].join("\n");
}
