import { Router, type IRouter } from "express";

/**
 * Planet OAuth + basemap proxy, ported from Tactical-Map-Pack
 * api-server/src/routes/planet.ts. Tokens travel per-request and are
 * never persisted or logged.
 */

const PLANET_TOKEN_URL = "https://api.planet.com/auth/v1/oauth/token";
const PLANET_MOSAICS_URL = "https://api.planet.com/basemaps/v1/mosaics";

export const planetRouter: IRouter = Router();

// ─── POST /api/planet/auth ──────────────────────────────────────────────────
// Exchange Planet clientId + clientSecret for an OAuth2 access token
// (client_credentials grant, HTTP basic auth).
planetRouter.post("/planet/auth", async (req, res) => {
  const { clientId, clientSecret } = (req.body ?? {}) as {
    clientId?: unknown;
    clientSecret?: unknown;
  };

  if (
    typeof clientId !== "string" ||
    clientId.length === 0 ||
    typeof clientSecret !== "string" ||
    clientSecret.length === 0
  ) {
    res.status(400).json({ error: "clientId and clientSecret are required" });
    return;
  }

  try {
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const resp = await fetch(PLANET_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
    });

    const text = await resp.text();
    if (!resp.ok) {
      res
        .status(resp.status)
        .json({ error: `Planet auth failed: ${text.slice(0, 300)}` });
      return;
    }

    let data: { access_token?: unknown; expires_in?: unknown };
    try {
      data = JSON.parse(text) as typeof data;
    } catch {
      res.status(502).json({ error: "unexpected Planet auth response" });
      return;
    }
    if (typeof data.access_token !== "string") {
      res.status(502).json({ error: "Planet auth response missing access_token" });
      return;
    }

    res.json({
      token: data.access_token,
      expiresIn: typeof data.expires_in === "number" ? data.expires_in : 3600,
    });
  } catch {
    res.status(502).json({ error: "failed to contact Planet API" });
  }
});

// ─── GET /api/planet/mosaics ────────────────────────────────────────────────
// List basemap mosaics for the account. Token via ?token= or Authorization:
// Bearer header.
planetRouter.get("/planet/mosaics", async (req, res) => {
  const headerToken = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  const queryToken =
    typeof req.query.token === "string" ? req.query.token : undefined;
  const token = headerToken || queryToken;

  if (!token) {
    res.status(401).json({ error: "authorization token required" });
    return;
  }

  try {
    const resp = await fetch(`${PLANET_MOSAICS_URL}?_page_size=250`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
      res.status(resp.status).json({ error: "failed to fetch Planet mosaics" });
      return;
    }

    const raw = (await resp.json()) as {
      mosaics?: Array<{
        id?: string;
        name?: string;
        interval?: string;
        updated?: string;
      }>;
    };

    const mosaics = (raw.mosaics ?? [])
      .filter((m): m is { id: string; name: string; interval?: string; updated?: string } =>
        Boolean(m.id && m.name),
      )
      .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""))
      .map((m) => ({
        id: m.id,
        name: m.name,
        interval: m.interval ?? "",
        updated: m.updated ?? "",
        label: m.name.replace(/_/g, " "),
      }));

    res.json({ mosaics });
  } catch {
    res.status(502).json({ error: "failed to contact Planet API" });
  }
});

// ─── GET /api/planet/tiles/:mosaic/:z/:x/:y ─────────────────────────────────
// Tile proxy — adds the Bearer auth header so Leaflet can display Planet
// tiles without CORS or auth-param issues. Token via ?token=.
planetRouter.get("/planet/tiles/:mosaic/:z/:x/:y", async (req, res) => {
  const { mosaic, z, x, y } = req.params;
  const token = typeof req.query.token === "string" ? req.query.token : undefined;

  if (!token) {
    res.status(401).json({ error: "token required" });
    return;
  }
  if (![z, x, y].every((v) => /^\d+$/.test(v))) {
    res.status(400).json({ error: "z, x, y must be non-negative integers" });
    return;
  }

  const tileUrl = `https://tiles.planet.com/basemaps/v1/planet-tiles/${encodeURIComponent(mosaic)}/gmap/${z}/${x}/${y}.png`;

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 15_000);
    const resp = await fetch(tileUrl, {
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    clearTimeout(tid);

    if (!resp.ok) {
      res.status(resp.status).end();
      return;
    }

    const contentType = resp.headers.get("content-type") ?? "image/png";
    const buf = Buffer.from(await resp.arrayBuffer());

    res.setHeader("Content-Type", contentType);
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.send(buf);
  } catch {
    console.warn(`[planet] tile proxy error for ${tileUrl}`);
    res.status(502).end();
  }
});
