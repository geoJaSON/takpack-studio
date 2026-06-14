import { createWriteStream } from "node:fs";
import archiver from "archiver";
import type { Aoi } from "../types.js";
import { esc } from "./xml.js";

/**
 * KMZ GRG: zip with doc.kml at root containing a single GroundOverlay that
 * references files/overlay.jpg. Imported by ATAK as a rectified GRG image.
 */
export interface GrgKmzOptions {
  filePath: string;
  name: string;
  /**
   * Attribution/license text baked into doc.kml (licensing policy: attribution
   * must travel with the imagery, even when the KMZ is shared standalone).
   */
  description?: string;
  /** JPEG-encoded rectified image covering `bounds`. */
  image: Buffer;
  bounds: Aoi;
}

function groundOverlayKml(name: string, b: Aoi, description?: string): string {
  const descriptionLine =
    description !== undefined && description.length > 0
      ? `\n    <description>${esc(description)}</description>`
      : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <GroundOverlay>
    <name>${esc(name)}</name>${descriptionLine}
    <Icon>
      <href>files/overlay.jpg</href>
    </Icon>
    <LatLonBox>
      <north>${b.north}</north>
      <south>${b.south}</south>
      <east>${b.east}</east>
      <west>${b.west}</west>
    </LatLonBox>
  </GroundOverlay>
</kml>
`;
}

export async function buildGrgKmz(opts: GrgKmzOptions): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(opts.filePath);
    const archive = archiver("zip", { zlib: { level: 6 } });
    out.on("close", resolve);
    out.on("error", reject);
    archive.on("error", reject);
    archive.pipe(out);
    archive.append(groundOverlayKml(opts.name, opts.bounds, opts.description), {
      name: "doc.kml",
    });
    archive.append(opts.image, { name: "files/overlay.jpg" });
    void archive.finalize();
  });
}

/**
 * KMZ overlay: doc.kml + embedded `files/*` (e.g. note-icon PNGs) so relative
 * hrefs in the KML resolve offline on the device. `docKml` must reference the
 * files by `files/<name>`.
 */
export async function buildOverlayKmz(
  filePath: string,
  docKml: string,
  files: { name: string; content: Buffer }[],
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(filePath);
    const archive = archiver("zip", { zlib: { level: 6 } });
    const fail = (err: unknown) => {
      archive.destroy();
      out.destroy();
      reject(err);
    };
    out.on("close", resolve);
    out.on("error", fail);
    archive.on("error", fail);
    archive.pipe(out);
    archive.append(docKml, { name: "doc.kml" });
    for (const f of files) archive.append(f.content, { name: `files/${f.name}` });
    void archive.finalize();
  });
}
