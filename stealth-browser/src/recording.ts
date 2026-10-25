import { spawn } from "child_process";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from "fs";
import { join } from "path";
import { v4 as uuidv4 } from "uuid";
import type { Recording, TabEntry } from "./types";

const RECORDINGS_DIR = process.env.RECORDINGS_DIR ?? "/tmp/recordings";
mkdirSync(RECORDINGS_DIR, { recursive: true });

export const recordings = new Map<string, Recording>();

export async function startRecording(
  tab: TabEntry,
  tabId: string,
  opts: { fps: number; maxDurationMs: number; quality?: string },
): Promise<Recording> {
  const id = uuidv4();
  const framesDir = join(RECORDINGS_DIR, id);
  mkdirSync(framesDir, { recursive: true });

  const cdp = await tab.page.context().newCDPSession(tab.page);
  const rec: Recording = {
    id,
    tabId,
    startedAt: Date.now(),
    fps: opts.fps,
    maxDurationMs: opts.maxDurationMs,
    framesDir,
    frameCount: 0,
    cdpSession: cdp,
  };
  recordings.set(id, rec);

  cdp.on("Page.screencastFrame", async (params: any) => {
    const idx = String(rec.frameCount).padStart(5, "0");
    writeFileSync(
      join(framesDir, `frame-${idx}.jpg`),
      Buffer.from(params.data, "base64"),
    );
    rec.frameCount += 1;
    try {
      await cdp.send("Page.screencastFrameAck", {
        sessionId: params.sessionId,
      });
    } catch {
      // CDP may be detached — ignore
    }
  });

  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 70,
    everyNthFrame: Math.max(1, Math.floor(60 / opts.fps)),
  });

  // safety auto-stop
  setTimeout(() => {
    if (recordings.has(id))
      stopRecording(id).catch(() => {
        // already stopping / stopped
      });
  }, opts.maxDurationMs).unref();

  return rec;
}

export async function stopRecording(
  id: string,
): Promise<{ rec: Recording; gif: Buffer; sizeBytes: number }> {
  const rec = recordings.get(id);
  if (!rec) throw new Error("not_found");

  await rec.cdpSession.send("Page.stopScreencast").catch(() => {});
  await rec.cdpSession.detach().catch(() => {});

  if (rec.frameCount === 0) {
    // Nothing captured — produce empty GIF path marker
    const placeholder = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
    const outPath = join(RECORDINGS_DIR, `${id}.gif`);
    writeFileSync(outPath, placeholder);
    rec.finalGifPath = outPath;
    rec.finalSizeBytes = placeholder.length;
    rmSync(rec.framesDir, { recursive: true, force: true });
    return { rec, gif: placeholder, sizeBytes: placeholder.length };
  }

  const outPath = join(RECORDINGS_DIR, `${id}.gif`);
  await mux(rec.framesDir, outPath, rec.fps);

  const stat = statSync(outPath);
  rec.finalGifPath = outPath;
  rec.finalSizeBytes = stat.size;

  rmSync(rec.framesDir, { recursive: true, force: true });

  return { rec, gif: readFileSync(outPath), sizeBytes: stat.size };
}

function mux(framesDir: string, outPath: string, fps: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tryFfmpeg = () => {
      const ff = spawn("ffmpeg", [
        "-y",
        "-framerate",
        String(fps),
        "-i",
        join(framesDir, "frame-%05d.jpg"),
        "-vf",
        `fps=${fps},scale=1024:-1:flags=lanczos`,
        outPath,
      ]);
      ff.on("error", reject);
      ff.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error("ffmpeg failed")),
      );
    };

    const gifski = spawn(
      "gifski",
      [
        "--fps",
        String(fps),
        "--quality",
        "80",
        "-o",
        outPath,
        `${framesDir}/frame-*.jpg`,
      ],
      { shell: true },
    );
    gifski.on("error", () => tryFfmpeg());
    gifski.on("exit", (code) => {
      if (code === 0) resolve();
      else tryFfmpeg();
    });
  });
}

// Periodic cleanup of old gif files (>2hr)
setInterval(
  () => {
    for (const [id, rec] of recordings) {
      if (rec.finalGifPath && existsSync(rec.finalGifPath)) {
        const ageMs = Date.now() - statSync(rec.finalGifPath).mtimeMs;
        if (ageMs > 2 * 3600 * 1000) {
          rmSync(rec.finalGifPath, { force: true });
          recordings.delete(id);
        }
      }
    }
  },
  60 * 60 * 1000,
).unref();
