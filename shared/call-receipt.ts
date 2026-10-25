// The durable record of one Live call, kept in the bot's thread so the call
// leaves something behind once the audio is gone. The harness builds it from
// the sideband transcript; clients only draw it.
import type { LiveEndReason } from "./wire.ts";

export const RECEIPT_MAX_LINES = 120;
export const RECEIPT_LINE_CHARS = 600;
export const RECEIPT_MAX_COMPUTE = 6;

export interface CallReceiptLine {
  /** you: heard from the person; bot: said by the voice */
  side: "you" | "bot";
  text: string;
}

export type CallReceiptOutcome = "completed" | "failed";

export interface CallReceiptData {
  callId: string;
  botId: string;
  threadId: string;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  outcome: CallReceiptOutcome;
  endReason?: LiveEndReason;
  error?: string;
  lines: CallReceiptLine[];
  /** requests the voice handed to the bot's own engine with ask_compute */
  compute?: Array<{ request: string; ok: boolean }>;
}

/** Joins transcript fragments into lines: a new line starts when the side
 * changes or the speaker paused (when the fragments carry timing). */
export class ReceiptTranscript {
  readonly lines: CallReceiptLine[] = [];
  private lastEndMs: number | null = null;

  add(side: CallReceiptLine["side"], fragment: string, startMs?: number, endMs?: number): boolean {
    if (!fragment) return false;
    const last = this.lines.at(-1);
    const paused = this.lastEndMs !== null && Number.isFinite(startMs) && (startMs as number) - this.lastEndMs > 1_500;
    if (Number.isFinite(endMs)) this.lastEndMs = endMs as number;
    if (last && last.side === side && !paused) {
      last.text = clampLine(`${last.text}${fragment}`);
      return true;
    }
    if (this.lines.length >= RECEIPT_MAX_LINES) return false;
    this.lines.push({ side, text: clampLine(fragment) });
    return true;
  }

  /** Lines with whitespace tidied, empty ones dropped. */
  snapshot(): CallReceiptLine[] {
    return this.lines
      .map((line) => ({ side: line.side, text: line.text.replace(/\s+/g, " ").trim() }))
      .filter((line) => line.text);
  }
}

function clampLine(text: string): string {
  return text.length > RECEIPT_LINE_CHARS ? `${text.slice(0, RECEIPT_LINE_CHARS - 1)}…` : text;
}

export function formatCallDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(total / 60);
  return minutes ? `${minutes}m ${String(total % 60).padStart(2, "0")}s` : `${total}s`;
}

/** The message `text`: what search, exports and clients that do not draw the
 * card read. */
export function callReceiptText(receipt: CallReceiptData): string {
  const head = `Call ${receipt.outcome === "failed" ? "ended with a problem" : "ended"} · ${formatCallDuration(receipt.durationSec)}`;
  const lines = receipt.lines.map((line) => `${line.side === "you" ? "You" : "Bot"}: ${line.text}`);
  return [head, ...lines].join("\n");
}
