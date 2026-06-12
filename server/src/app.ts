import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, {
  type NextFunction,
  type Request,
  type Response,
} from "express";
import type { ExportQueue } from "./jobs/queue.js";
import type { JobStore } from "./jobs/store.js";
import { configRouter } from "./routes/config.js";
import { exportRouter } from "./routes/export.js";
import { healthRouter } from "./routes/health.js";
import { jobsRouter } from "./routes/jobs.js";
import { planetRouter } from "./routes/planet.js";
import { previewRouter } from "./routes/preview.js";
import type { FetchStrategy, ImageryAdapter, ImagerySourceDef, Limits } from "./types.js";

export interface AppDeps {
  store: JobStore;
  queue: ExportQueue;
  catalog: ImagerySourceDef[];
  adapters: Partial<Record<FetchStrategy, ImageryAdapter>>;
  limits: Limits;
}

/** Pull every secret-ish value off a request so logs/error bodies can be scrubbed. */
function collectSecrets(req: Request): string[] {
  const secrets: string[] = [];
  const query = req.query as Record<string, unknown>;
  for (const name of ["key", "token", "apiKey"]) {
    const value = query[name];
    if (typeof value === "string" && value.length > 0) secrets.push(value);
  }
  const body: unknown = req.body;
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    for (const name of ["apiKey", "clientId", "clientSecret"]) {
      const value = b[name];
      if (typeof value === "string" && value.length > 0) secrets.push(value);
    }
    const imagery = b.imagery;
    if (imagery && typeof imagery === "object") {
      const apiKey = (imagery as Record<string, unknown>).apiKey;
      if (typeof apiKey === "string" && apiKey.length > 0) secrets.push(apiKey);
    }
  }
  return secrets;
}

function redactAll(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "20mb" }));

  app.use("/api", healthRouter);
  app.use("/api", configRouter);
  app.use("/api", exportRouter(deps));
  app.use("/api", jobsRouter(deps.store));
  app.use("/api", previewRouter(deps));
  app.use("/api", planetRouter);

  // Unknown /api paths get JSON, never the SPA shell.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // Production: serve the built frontend when it exists next to the server
  // (works from both src/ via tsx and dist/ after tsc — ../../frontend/dist).
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const frontendDist = path.resolve(moduleDir, "../../frontend/dist");
  if (existsSync(path.join(frontendDist, "index.html"))) {
    app.use(express.static(frontendDist));
    // SPA fallback for non-/api GETs (client-side routing).
    app.use((req, res, next) => {
      if (req.method !== "GET" || req.path.startsWith("/api")) {
        next();
        return;
      }
      res.sendFile(path.join(frontendDist, "index.html"));
    });
  }

  app.use(
    (err: unknown, req: Request, res: Response, _next: NextFunction) => {
      const secrets = collectSecrets(req);
      const message = redactAll(
        err instanceof Error ? err.message : String(err),
        secrets,
      );
      const status =
        typeof (err as { status?: unknown }).status === "number"
          ? (err as { status: number }).status
          : 500;
      console.error(
        `[api] ${req.method} ${redactAll(req.originalUrl, secrets)} -> ${status}: ${message}`,
      );
      if (res.headersSent) return;
      res.status(status).json({ error: message });
    },
  );

  return app;
}
