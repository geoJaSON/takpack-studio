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
  /** JPEG-encoded rectified image covering `bounds`. */
  image: Buffer;
  bounds: Aoi;
}

function groundOverlayKml(name: string, b: Aoi): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <GroundOverlay>
    <name>${esc(name)}</name>
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
    archive.append(groundOverlayKml(opts.name, opts.bounds), { name: "doc.kml" });
    archive.append(opts.image, { name: "files/overlay.jpg" });
    void archive.finalize();
  });
}
