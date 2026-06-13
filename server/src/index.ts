import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ADAPTERS } from "./adapters/index.js";
import { createApp } from "./app.js";
import { CATALOG, LIMITS } from "./catalog/imagery-sources.js";
import { ExportQueue } from "./jobs/queue.js";
import { JobStore } from "./jobs/store.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
// moduleDir is server/src (tsx) or server/dist (built) — both one level under server/.
const dataDir =
  process.env.TAKPACK_DATA_DIR ?? path.resolve(moduleDir, "..", "data");
const artifactsDir = path.join(dataDir, "artifacts");
mkdirSync(dataDir, { recursive: true });
mkdirSync(artifactsDir, { recursive: true });

const store = new JobStore(dataDir);
const orphaned = store.reconcileOrphans();
if (orphaned > 0) {
  console.log(`[jobs] marked ${orphaned} orphaned job(s) failed after restart`);
}

// Retention: keep only the most recent completed jobs; prune older rows and
// their zips so artifactsDir + jobs.sqlite don't grow without bound.
const MAX_COMPLETED_JOBS = 100;
const completed = store.list().filter((j) => j.status === "completed");
let pruned = 0;
for (const j of completed.slice(MAX_COMPLETED_JOBS)) {
  if (j.artifactPath) {
    try {
      rmSync(j.artifactPath, { force: true });
    } catch {
      /* locked — the sweep below or the next boot removes it */
    }
  }
  store.delete(j.id);
  pruned++;
}
if (pruned > 0) console.log(`[jobs] pruned ${pruned} old completed job(s)`);

// Sweep artifacts from jobs that did not complete (crash mid-build leaves
// temp .gpkg/.kmz and partial zips behind; buildPackage's finally can't run
// after a hard kill). Remaining completed jobs keep their zip for re-download.
const keep = new Set(
  store
    .list()
    .filter((j) => j.status === "completed" && j.artifactPath)
    .map((j) => path.basename(j.artifactPath!)),
);
let swept = 0;
for (const name of readdirSync(artifactsDir)) {
  if (!keep.has(name)) {
    try {
      rmSync(path.join(artifactsDir, name), { force: true });
      swept++;
    } catch {
      /* locked file — next boot gets it */
    }
  }
}
if (swept > 0) console.log(`[jobs] swept ${swept} stale artifact file(s)`);

const queue = new ExportQueue(store, {
  catalog: CATALOG,
  adapters: ADAPTERS,
  limits: LIMITS,
  outDir: artifactsDir,
});

const app = createApp({
  store,
  queue,
  catalog: CATALOG,
  adapters: ADAPTERS,
  limits: LIMITS,
});

const port = Number(process.env.PORT) || 8745;
const server = app.listen(port, () => {
  console.log(`TAKPack Studio server listening on http://localhost:${port}`);
  console.log(`[data] ${dataDir}`);
});

// Close the SQLite handle on shutdown so WAL is checkpointed cleanly.
let shuttingDown = false;
const shutdown = (sig: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[server] ${sig} received — shutting down`);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  // Don't hang forever on lingering connections.
  setTimeout(() => {
    store.close();
    process.exit(0);
  }, 3000).unref();
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
