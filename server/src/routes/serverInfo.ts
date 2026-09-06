import { Router } from "express";
import { config } from "../config.js";
import { getLanIp } from "../lib/networkInfo.js";

export const serverInfoRouter = Router();

serverInfoRouter.get("/server-info", (_req, res) => {
  res.json({
    ip: getLanIp(),
    // Always the plain HTTP port — every URL built from this (video stream,
    // subtitle .vtt, thumbnails) is fetched directly by the TV, which can
    // never trust our local HTTPS cert, so it must stay HTTP regardless of
    // whether the web UI itself is also being served over HTTPS right now.
    // See config.useHttps for the full explanation.
    port: config.port,
    protocol: "http" as const,
    // Only informational — e.g. so the UI could show "controla desde el
    // móvil en https://..." — never used to build media URLs.
    httpsPort: config.useHttps ? config.httpsPort : null,
    recentMonths: config.recentMonths,
  });
});
