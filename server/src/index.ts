import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { config } from "./config.js";
import { checkFfmpegAvailable, checkFfprobeAvailable } from "./lib/ffprobe.js";
import { scanLibrary } from "./lib/library.js";
import { pruneStaleCache } from "./lib/mediaCache.js";
import { getLanIp } from "./lib/networkInfo.js";
import { libraryRouter } from "./routes/library.js";
import { streamRouter } from "./routes/stream.js";
import { serverInfoRouter } from "./routes/serverInfo.js";
import { subtitleStyleRouter } from "./routes/subtitleStyle.js";
import { systemRouter } from "./routes/system.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const [hasFfprobe, hasFfmpeg] = await Promise.all([checkFfprobeAvailable(), checkFfmpegAvailable()]);
  if (!hasFfprobe || !hasFfmpeg) {
    console.warn(
      "[startup] ffmpeg/ffprobe not found on PATH. Install it (see README) — " +
        "without it, video metadata can't be read and subtitles can't be extracted."
    );
  }

  // Clear out cached remuxes from previous runs before serving anything —
  // see pruneStaleCache's own comment for why only today's .mp4s survive.
  try {
    const { removed } = await pruneStaleCache();
    if (removed > 0) {
      console.log(`[startup] Video cache: deleted ${removed} old file(s).`);
    }
  } catch (err) {
    console.warn("[startup] Couldn't clean up the video cache:", (err as Error).message);
  }

  const app = express();
  app.use(cors());
  app.use(express.json());

  // One line when a video/subtitle request arrives and one when it ends, so
  // a cast stuck on "loading" shows whether the TV ever asked for the file,
  // which byte range, and whether it hung up mid-transfer.
  app.use("/api/videos", (req, res, next) => {
    if (!/\/(stream|subtitles\/)/.test(req.path)) return next();
    const started = Date.now();
    const who = `${req.ip} ${(req.headers["user-agent"] ?? "").slice(0, 50)}`;
    console.log(`[media] ← ${req.method} ${req.originalUrl} range=${req.headers.range ?? "-"} (${who})`);
    res.on("close", () => {
      const outcome = res.writableFinished ? "complete" : "cut off by the client";
      console.log(
        `[media] → ${res.statusCode} ${req.originalUrl} ${outcome} in ${Date.now() - started} ms ` +
          `(${res.getHeader("Content-Range") ?? res.getHeader("Content-Length") ?? "?"})`
      );
    });
    next();
  });

  app.use("/api", libraryRouter);
  app.use("/api", streamRouter);
  app.use("/api", serverInfoRouter);
  app.use("/api", subtitleStyleRouter);
  app.use("/api", systemRouter);

  // In production, serve the built Vue app from the same server so there's
  // only one process/port to run on the machine that hosts the library.
  const clientDist = path.resolve(__dirname, "../../client/dist");
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api")) return next();
      res.sendFile(path.join(clientDist, "index.html"));
    });
  }

  // The video/subtitle/thumbnail URLs handed to the Cast SDK always use
  // this plain HTTP listener — see the long comment on config.useHttps for
  // why (the TV can't trust a local mkcert CA, and it doesn't need to: it
  // fetches content directly, not through the browser, so this isn't a
  // "mixed content" situation even when the web UI itself is loaded over
  // HTTPS below).
  const httpServer = http.createServer(app);

  const lanIp = getLanIp();

  function afterFirstListen() {
    // The library scan (ffprobe on every file) can take a while on a large
    // library. Run it *after* we're already listening so the API — and the
    // "rescan" button — work immediately instead of racing the initial scan.
    if (config.mediaDirs.length === 0) return;
    console.log(
      `[startup] Scanning library in the background (last ${config.recentMonths} months only): ` +
        config.mediaDirs.join(", ")
    );
    scanLibrary()
      .then(({ count, errors, skipped }) => {
        console.log(
          `[startup] ${count} video(s) indexed${errors ? `, ${errors} with errors` : ""}` +
            `${skipped ? `, ${skipped} old one(s) skipped` : ""}.`
        );
      })
      .catch((err) => {
        console.error("[startup] Error scanning the library:", err);
      });
  }

  httpServer.listen(config.port, "0.0.0.0", () => {
    console.log(`\n[startup] Server listening on http://0.0.0.0:${config.port}`);
    console.log(`[startup] Reachable on your local network at: http://${lanIp}:${config.port}`);

    if (config.useHttps) {
      console.log(
        `[startup] Also reachable over HTTPS at: https://${lanIp}:${config.httpsPort} ` +
          "(use it to control casting from your phone or another PC at home; the TV itself still " +
          "receives the videos over HTTP, so this doesn't affect playback)."
      );
    } else if (process.env.NODE_ENV === "development" && config.httpsKeyPath && config.httpsCertPath) {
      console.log(
        "[startup] HTTPS is configured but disabled in development mode (use 'npm run build && npm start' " +
          "to serve over HTTPS too)."
      );
    } else {
      console.log(
        "[startup] Warning: without HTTPS, controlling casting from devices other than 'localhost' may fail " +
          "(Chrome requires a secure context for the Cast API). See the README to set up HTTPS with mkcert."
      );
    }

    afterFirstListen();
  });

  if (config.useHttps) {
    const key = fs.readFileSync(config.httpsKeyPath as string);
    const cert = fs.readFileSync(config.httpsCertPath as string);
    const httpsServer = https.createServer({ key, cert }, app);
    httpsServer.listen(config.httpsPort, "0.0.0.0");
  }
}

main().catch((err) => {
  console.error("[startup] Fatal error:", err);
  process.exit(1);
});
