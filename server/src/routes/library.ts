import { Router } from "express";
import { deleteVideo, didLastScanIncludeOld, getEntry, listEntries, scanLibrary, toDTO } from "../lib/library.js";

export const libraryRouter = Router();

libraryRouter.get("/library", (_req, res) => {
  res.json({ videos: listEntries().map(toDTO), includesOld: didLastScanIncludeOld() });
});

libraryRouter.post("/library/rescan", async (req, res) => {
  const includeOld = req.query.includeOld === "true";
  try {
    const result = await scanLibrary({ includeOld });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

libraryRouter.get("/videos/:id", (req, res) => {
  const entry = getEntry(req.params.id);
  if (!entry) {
    res.status(404).json({ error: "Vídeo no encontrado" });
    return;
  }
  res.json(toDTO(entry));
});

libraryRouter.delete("/videos/:id", async (req, res) => {
  if (!getEntry(req.params.id)) {
    res.status(404).json({ error: "Vídeo no encontrado" });
    return;
  }
  try {
    await deleteVideo(req.params.id);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
