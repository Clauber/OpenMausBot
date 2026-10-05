// Live call receipts on disk: one small JSON file per call under the data
// directory, so a call can be audited even if its thread is later deleted.
// The same data rides in the thread as a call_receipt message (index.ts).
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallReceiptData } from "../shared/call-receipt.ts";
import { redactSecretsInText } from "../shared/redact.ts";
import { DATA_DIR } from "./config.ts";

const SAFE_ID = /^[\w-]{1,120}$/;
const dir = () => join(DATA_DIR, "call-receipts");

export function saveCallReceipt(receipt: CallReceiptData): void {
  if (!SAFE_ID.test(receipt.callId)) return;
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  const file = join(dir(), `${receipt.callId}.json`);
  const tmp = `${file}.tmp`;
  // transcripts are private conversation: owner-only, like messages.db
  writeFileSync(tmp, JSON.stringify(receipt), { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch { /* best effort */ }
}

export function readCallReceipt(callId: string): CallReceiptData | null {
  if (!SAFE_ID.test(callId)) return null;
  try {
    return JSON.parse(readFileSync(join(dir(), `${callId}.json`), "utf8")) as CallReceiptData;
  } catch {
    return null;
  }
}

export function listCallReceipts(): CallReceiptData[] {
  try {
    return readdirSync(dir())
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => readCallReceipt(name.slice(0, -5)) ?? [])
      .sort((a, b) => a.startedAt - b.startedAt);
  } catch {
    return [];
  }
}

/** What was said on a call may include a secret read aloud; it is scrubbed like any bot-authored text. */
export function redactCallReceipt(receipt: CallReceiptData): CallReceiptData {
  return {
    ...receipt,
    lines: receipt.lines.map((line) => ({ ...line, text: redactSecretsInText(line.text) })),
    ...(receipt.error ? { error: redactSecretsInText(receipt.error) } : {}),
    ...(receipt.compute ? { compute: receipt.compute.map((item) => ({ ...item, request: redactSecretsInText(item.request) })) } : {}),
  };
}
