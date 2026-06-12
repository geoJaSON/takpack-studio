import { Router, type IRouter } from "express";
import type { JobStore } from "../jobs/store.js";

export function jobsRouter(store: JobStore): IRouter {
  const router = Router();

  router.get("/jobs/:id", (req, res) => {
    const job = store.get(req.params.id);
    if (!job) {
      res.status(404).json({ error: "job not found" });
      return;
    }
    // Server filesystem paths never leave the API.
    const { artifactPath: _artifactPath, ...publicJob } = job;
    res.json(publicJob);
  });

  router.get("/jobs/:id/download", (req, res) => {
    const job = store.get(req.params.id);
    if (!job || job.status !== "completed" || !job.artifactPath) {
      res.status(404).json({ error: "package not available" });
      return;
    }
    res.download(job.artifactPath, job.artifactName ?? "takpack.zip", (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ error: "artifact missing on disk" });
      }
    });
  });

  return router;
}
