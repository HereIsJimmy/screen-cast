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
import { getLanIp } from "./lib/networkInfo.js";
import { libraryRouter } from "./routes/library.js";
import { streamRouter } from "./routes/stream.js";
import { serverInfoRouter } from "./routes/serverInfo.js";
import { subtitleStyleRouter } from "./routes/subtitleStyle.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  const [hasFfprobe, hasFfmpeg] = await Promise.all([checkFfprobeAvailable(), checkFfmpegAvailable()]);
  if (!hasFfprobe || !hasFfmpeg) {
    console.warn(
      "[startup] No se encuentra ffmpeg/ffprobe en el PATH. Instálalo (ver README) — " +
        "sin él no se puede leer metadata de los vídeos ni extraer subtítulos."
    );
  }

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.use("/api", libraryRouter);
  app.use("/api", streamRouter);
  app.use("/api", serverInfoRouter);
  app.use("/api", subtitleStyleRouter);

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
      `[startup] Escaneando biblioteca en segundo plano (solo últimos ${config.recentMonths} meses): ` +
        config.mediaDirs.join(", ")
    );
    scanLibrary()
      .then(({ count, errors, skipped }) => {
        console.log(
          `[startup] ${count} vídeo(s) indexados${errors ? `, ${errors} con errores` : ""}` +
            `${skipped ? `, ${skipped} antiguo(s) omitidos` : ""}.`
        );
      })
      .catch((err) => {
        console.error("[startup] Error escaneando la biblioteca:", err);
      });
  }

  httpServer.listen(config.port, "0.0.0.0", () => {
    console.log(`\n[startup] Servidor escuchando en http://0.0.0.0:${config.port}`);
    console.log(`[startup] Accesible en tu red local en: http://${lanIp}:${config.port}`);

    if (config.useHttps) {
      console.log(
        `[startup] También accesible por HTTPS en: https://${lanIp}:${config.httpsPort} ` +
          "(úsala para controlar el cast desde el móvil u otro PC de casa; la propia TV sigue " +
          "recibiendo los vídeos por HTTP, así que esto no afecta a la reproducción)."
      );
    } else if (process.env.NODE_ENV === "development" && config.httpsKeyPath && config.httpsCertPath) {
      console.log(
        "[startup] HTTPS configurado pero desactivado en modo desarrollo (usa 'npm run build && npm start' " +
          "para servir también por HTTPS)."
      );
    } else {
      console.log(
        "[startup] Aviso: sin HTTPS, controlar el cast desde dispositivos que no sean 'localhost' puede fallar " +
          "(Chrome exige un contexto seguro para usar la API de Cast). Ver README para configurar HTTPS con mkcert."
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
  console.error("[startup] Error fatal:", err);
  process.exit(1);
});
