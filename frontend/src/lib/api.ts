import type { AppConfig, ExportRequest, JobRecord } from "../types";

/** Thin typed client for the TAKPack server API. */

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* non-JSON error body */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

export async function getConfig(): Promise<AppConfig> {
  return json(await fetch("/api/config"));
}

export async function startExport(req: ExportRequest): Promise<{ jobId: string }> {
  return json(
    await fetch("/api/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    }),
  );
}

export async function getJob(id: string): Promise<JobRecord> {
  return json(await fetch(`/api/jobs/${encodeURIComponent(id)}`));
}

export function jobDownloadUrl(id: string): string {
  return `/api/jobs/${encodeURIComponent(id)}/download`;
}

export function aoiPreviewUrl(
  sourceId: string,
  aoi: { north: number; south: number; east: number; west: number },
  key?: string,
): string {
  const params = new URLSearchParams({
    sourceId,
    n: String(aoi.north),
    s: String(aoi.south),
    e: String(aoi.east),
    w: String(aoi.west),
  });
  if (key) params.set("key", key);
  return `/api/preview/aoi-image?${params.toString()}`;
}
