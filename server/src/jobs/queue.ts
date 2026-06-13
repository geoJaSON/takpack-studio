import PQueue from "p-queue";
import type {
  BuildPackageOutput,
  ExportRequest,
  FetchStrategy,
  ImageryAdapter,
  ImagerySourceDef,
  JobRecord,
  Limits,
} from "../types.js";
import type { JobStore } from "./store.js";

export interface ExportQueueDeps {
  catalog: ImagerySourceDef[];
  adapters: Partial<Record<FetchStrategy, ImageryAdapter>>;
  limits: Limits;
  /** Directory for built zips and temp files. */
  outDir: string;
}

const JOB_TIMEOUT_MS = 15 * 60 * 1000;

/** Replace every occurrence of the secret in a message — keys never leak into job records. */
function redactSecret(message: string, secret: string | undefined): string {
  if (!secret) return message;
  return message.split(secret).join("[redacted]");
}

/** Windows/zip-safe download stem derived from the user's package name. */
function sanitizeArtifactStem(packageName: string): string {
  const cleaned = packageName
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "");
  return cleaned.length > 0 ? cleaned : "takpack";
}

/**
 * One-at-a-time export runner. Jobs persist through JobStore; the request
 * (which may carry an apiKey) lives only in memory for the job's lifetime.
 */
export class ExportQueue {
  private readonly queue = new PQueue({ concurrency: 1 });

  constructor(
    private readonly store: JobStore,
    private readonly deps: ExportQueueDeps,
  ) {}

  /** Create the job record and schedule the build. Returns immediately. */
  enqueue(request: ExportRequest): JobRecord {
    const job = this.store.create();
    this.queue
      .add(() => this.run(job.id, request))
      .catch((err: unknown) => {
        // run() catches its own errors; this guards the runner itself.
        console.error(`[queue] job ${job.id} runner crashed:`, err);
      });
    return job;
  }

  private async run(jobId: string, request: ExportRequest): Promise<void> {
    const apiKey = request.imagery?.apiKey;
    this.store.update(jobId, {
      status: "running",
      progress: { phase: "starting", percent: 0 },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JOB_TIMEOUT_MS);
    let buildPromise: Promise<BuildPackageOutput> | undefined;
    try {
      if (request.imagery) {
        const source = this.deps.catalog.find(
          (s) => s.id === request.imagery?.sourceId,
        );
        if (!source) {
          throw new Error(`unknown imagery source: ${request.imagery.sourceId}`);
        }
      }

      // Imported lazily so loading the queue (e.g. in unit tests) doesn't pull
      // in sharp/archiver until a job actually runs.
      const { buildPackage } = await import("../export/package-builder.js");

      const timedOut = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new Error("export timed out after 15 minutes")),
          { once: true },
        );
      });

      buildPromise = buildPackage({
        request,
        jobId,
        outDir: this.deps.outDir,
        catalog: this.deps.catalog,
        adapters: this.deps.adapters,
        limits: this.deps.limits,
        onProgress: (p) => {
          this.store.update(jobId, { progress: p });
        },
        signal: controller.signal,
      });
      // Swallow a late rejection if the build loses the race to the timeout —
      // we await it explicitly in catch, so this only prevents an unhandled
      // rejection warning.
      buildPromise.catch(() => {});

      const result = await Promise.race([buildPromise, timedOut]);

      this.store.update(jobId, {
        status: "completed",
        progress: { phase: "completed", percent: 100 },
        artifactPath: result.zipPath,
        artifactName: `${sanitizeArtifactStem(request.packageName)}.zip`,
        sizeBytes: result.sizeBytes,
        warnings: result.warnings,
      });
    } catch (err) {
      // Abort and WAIT for the build to actually unwind before we return, or
      // p-queue (concurrency 1) would start the next job while a timed-out
      // build is still fetching/encoding — and its onProgress writes would
      // keep mutating this now-failed job's record.
      controller.abort();
      if (buildPromise) await buildPromise.catch(() => {});
      const message = err instanceof Error ? err.message : String(err);
      this.store.update(jobId, {
        status: "failed",
        progress: { phase: "failed", percent: 0 },
        error: redactSecret(message, apiKey),
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
