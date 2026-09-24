import { Router } from "express";
import { config } from "../config.js";
import { passwordsMatch, shutdownServerPc } from "../lib/systemShutdown.js";

export const systemRouter = Router();

/**
 * Shuts down the PC the server runs on. Gated on two independent things,
 * both required: config.shutdownEnabled (the feature flag) and a matching
 * config.shutdownPassword (checked here regardless of what the client UI
 * shows/hides, since a hidden button is not access control).
 */
systemRouter.post("/system/shutdown", (req, res) => {
  if (!config.shutdownEnabled) {
    res.status(403).json({ error: "El apagado remoto no está habilitado (SHUTDOWN_ENABLED en server/.env)." });
    return;
  }
  if (!config.shutdownPassword) {
    res.status(500).json({ error: "SHUTDOWN_PASSWORD no está configurada en server/.env." });
    return;
  }

  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!passwordsMatch(password, config.shutdownPassword)) {
    res.status(401).json({ error: "Contraseña incorrecta." });
    return;
  }

  try {
    shutdownServerPc();
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
    return;
  }

  res.json({ ok: true });
});
