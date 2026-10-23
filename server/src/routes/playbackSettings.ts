import { Router } from "express";
import { getPlaybackSettings, writePlaybackSettings } from "../lib/playbackSettings.js";

export const playbackSettingsRouter = Router();

playbackSettingsRouter.get("/playback-settings", (_req, res) => {
  res.json(getPlaybackSettings());
});

playbackSettingsRouter.put("/playback-settings", async (req, res) => {
  try {
    res.json(await writePlaybackSettings(req.body));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
