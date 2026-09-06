import { Router } from "express";
import { readSubtitleStyle, writeSubtitleStyle } from "../lib/subtitleStyle.js";

export const subtitleStyleRouter = Router();

subtitleStyleRouter.get("/subtitle-style", async (_req, res) => {
  res.json(await readSubtitleStyle());
});

subtitleStyleRouter.put("/subtitle-style", async (req, res) => {
  try {
    const saved = await writeSubtitleStyle(req.body);
    res.json(saved);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
