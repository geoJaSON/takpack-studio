import { Router, type IRouter } from "express";
import { CATALOG, LIMITS } from "../catalog/imagery-sources.js";

export const configRouter: IRouter = Router();

configRouter.get("/config", (_req, res) => {
  res.json({ sources: CATALOG, limits: LIMITS });
});
