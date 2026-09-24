import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

function parseList(value: string | undefined, fallback: string[]): string[] {
  if (!value || value.trim().length === 0) return fallback;
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

const port = Number(process.env.PORT ?? 4000);
const httpsKeyPath = process.env.HTTPS_KEY?.trim() || undefined;
const httpsCertPath = process.env.HTTPS_CERT?.trim() || undefined;

export const config = {
  port,
  /**
   * Second port for an *additional* HTTPS listener on the same app, only
   * used so the web UI itself can be opened as a secure context from a
   * phone/other PC (required to use the Cast Web Sender SDK there). The TV
   * never talks to this port — see `useHttps` below for why.
   */
  httpsPort: Number(process.env.HTTPS_PORT ?? port + 1),
  mediaDirs: parseList(process.env.MEDIA_DIRS, []),
  cacheDir: path.resolve(process.env.CACHE_DIR ?? "./.cache"),
  /** Persistent user settings (e.g. subtitle style) — unlike cacheDir, never safe to wipe. */
  dataDir: path.resolve(process.env.DATA_DIR ?? "./data"),
  httpsKeyPath,
  httpsCertPath,
  /**
   * Whether to run the extra HTTPS listener at all (see httpsPort). Gated on
   * NODE_ENV so the two-port dev setup (tsx watch + Vite, which only ever
   * proxies to plain HTTP) never trips over it — see README.
   *
   * Note this only controls the *web UI* listener. Video/subtitle/thumbnail
   * URLs handed to the Cast SDK always point at the plain HTTP port
   * regardless of this flag: the TV fetches those directly (not through the
   * browser), so it would need to trust our certificate to use HTTPS there —
   * and a Chromecast/Google TV has no way to trust a locally-generated
   * mkcert CA, only a real one. Sending it plain HTTP isn't a "mixed
   * content" issue either, since the browser never fetches that URL itself —
   * it just hands the string to the Cast device, which fetches it on its own.
   */
  useHttps: Boolean(httpsKeyPath && httpsCertPath) && process.env.NODE_ENV !== "development",
  allowTranscode: (process.env.ALLOW_TRANSCODE ?? "true").toLowerCase() !== "false",
  /** Default "recent videos" filter window, in months. See RECENT_MONTHS in .env. */
  recentMonths: Number(process.env.RECENT_MONTHS ?? 3),
  videoExtensions: parseList(process.env.VIDEO_EXTENSIONS, [
    ".mp4",
    ".mkv",
    ".webm",
    ".mov",
    ".m4v",
    ".avi",
  ]).map((ext) => (ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`)),
  /** Shows/enables the "Apagar el PC del servidor" button in Configuración > Varios. Off by default. */
  shutdownEnabled: (process.env.SHUTDOWN_ENABLED ?? "false").toLowerCase() === "true",
  /**
   * Required to actually shut down, independent of shutdownEnabled — even
   * with the feature flag on, an empty/unset password disables the route
   * rather than allowing a no-password shutdown.
   */
  shutdownPassword: process.env.SHUTDOWN_PASSWORD?.trim() || undefined,
};

if (config.mediaDirs.length === 0) {
  // eslint-disable-next-line no-console
  console.warn(
    "[config] MEDIA_DIRS no está configurado. Copia server/.env.example a server/.env y define al menos una carpeta con vídeos."
  );
}
