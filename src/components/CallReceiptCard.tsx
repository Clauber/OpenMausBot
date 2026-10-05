import { Phone } from "lucide-react";

import { formatCallDuration } from "../../shared/call-receipt";
import type { Message } from "@/state/store";

/** The receipt a Live call leaves in its thread: how long it ran, how it
 * ended, and what was said, folded away until opened. The harness updates it
 * in place if transcript arrives after the call ended. */
export function CallReceiptCard({ message }: { message: Message }) {
  const receipt = message.callReceipt;
  if (!receipt) return null;
  const failed = receipt.outcome === "failed";
  const asked = receipt.compute?.length ?? 0;
  return (
    <details className="max-w-[600px] rounded-xl border border-hairline/40 bg-panel px-3 py-2 text-[12px] text-ink-secondary" data-testid="call-receipt">
      <summary className="flex cursor-pointer items-center gap-1.5 font-medium">
        <Phone size={12} />
        <span>{failed ? "Call ended with a problem" : "Call"} · {formatCallDuration(receipt.durationSec)}</span>
        {asked > 0 && <span className="font-normal">· {asked} delegated</span>}
      </summary>
      {receipt.error && <p className="mt-2 text-danger">{receipt.error}</p>}
      {receipt.lines.length === 0 ? (
        <p className="mt-2">Nothing was transcribed.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-1">
          {receipt.lines.map((line, index) => (
            <li key={index} className="break-words">
              <span className="font-medium text-ink">{line.side === "you" ? "You" : "Bot"}:</span> {line.text}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
