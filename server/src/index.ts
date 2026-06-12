import { mkdirSync } from "node:fs";
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
app.listen(port, () => {
  console.log(`TAKPack Studio server listening on http://localhost:${port}`);
  console.log(`[data] ${dataDir}`);
});
