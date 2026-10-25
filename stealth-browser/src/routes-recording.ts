import type { Express, Request, Response } from "express";
import { existsSync } from "fs";
import { tabs } from "./browser";
import { sendTabNotFound } from "./errors";
import { recordings, startRecording, stopRecording } from "./recording";

export function registerRecordingRoutes(app: Express): void {
  app.post("/tabs/:id/recording/start", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const tab = tabs.get(id);
    if (!tab) return sendTabNotFound(res, id);
    tab.lastUsedAt = Date.now();

    if (tab.activeRecordingId) {
      return res.status(409).json({
        error: "already_recording",
        recordingId: tab.activeRecordingId,
      });
    }

    const { fps = 10, maxDurationMs = 30_000 } = req.body ?? {};
    const cap = Math.min(
      120_000,
      Math.max(1_000, Number(maxDurationMs) || 30_000),
    );
    const rec = await startRecording(tab, id, {
      fps: Number(fps) || 10,
      maxDurationMs: cap,
    });
    tab.activeRecordingId = rec.id;
    res.json({
      ok: true,
      recordingId: rec.id,
      startedAt: new Date(rec.startedAt).toISOString(),
    });
  });

  app.post("/tabs/:id/recording/stop", async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const tab = tabs.get(id);
    if (!tab) return sendTabNotFound(res, id);
    tab.lastUsedAt = Date.now();

    const { recordingId } = req.body ?? {};
    if (!recordingId || !recordings.has(recordingId)) {
      return res
        .status(404)
        .json({ error: "recording_not_found", id: recordingId });
    }

    const { rec, gif, sizeBytes } = await stopRecording(recordingId);
    tab.activeRecordingId = undefined;

    const inline = sizeBytes <= 5 * 1024 * 1024;
    res.json({
      ok: true,
      frames: rec.frameCount,
      durationMs: Date.now() - rec.startedAt,
      sizeBytes,
      path: rec.finalGifPath,
      gif: inline ? gif.toString("base64") : null,
      omittedReason: inline ? null : "size",
    });
  });

  app.get("/recordings/:id/file", (req: Request, res: Response) => {
    const rec = recordings.get(req.params.id as string);
    if (!rec || !rec.finalGifPath || !existsSync(rec.finalGifPath)) {
      return res
        .status(404)
        .json({ error: "recording_not_found", id: req.params.id });
    }
    res
      .type("image/gif")
      .set(
        "Content-Disposition",
        `attachment; filename="recording-${req.params.id}.gif"`,
      )
      .sendFile(rec.finalGifPath);
  });
}
