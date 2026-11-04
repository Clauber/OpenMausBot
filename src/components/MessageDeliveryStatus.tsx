import { memo } from "react";
import { Clock, Check, AlertCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { Message } from "@/state/store";

export type MessageDeliveryState = "sending" | "sent" | "failed";

export function messageDeliveryState(
  message: Pick<Message, "role" | "id" | "failed">,
): MessageDeliveryState | null {
  if (message.role !== "user") return null;
  if (message.failed) return "failed";
  if (message.id.startsWith("optimistic-")) return "sending";
  return "sent";
}

export const MessageDeliveryStatus = memo(function MessageDeliveryStatus({
  message,
  onRetry,
  className,
}: {
  message: Message;
  onRetry?: () => void;
  className?: string;
}) {
  const state = messageDeliveryState(message);
  if (!state) return null;

  if (state === "sending") {
    return (
      <span
        data-testid="delivery-status-sending"
        className={cn("inline-flex items-center text-ink-tertiary", className)}
        title={t("chat.delivery.sending")}
        aria-label={t("chat.delivery.sending")}
      >
        <Clock size={11} strokeWidth={1.75} aria-hidden="true" />
      </span>
    );
  }

  if (state === "sent") {
    return (
      <span
        data-testid="delivery-status-sent"
        className={cn("inline-flex items-center text-ink-tertiary", className)}
        title={t("chat.delivery.sent")}
        aria-label={t("chat.delivery.sent")}
      >
        <span className="relative inline-flex items-center" aria-hidden="true">
          <Check size={12} strokeWidth={2} />
          <Check size={12} strokeWidth={2} className="-ml-1.5" />
        </span>
      </span>
    );
  }

  if (state === "failed") {
    return (
      <span
        data-testid="delivery-status-failed"
        className={cn("inline-flex items-center gap-1 text-danger text-[11px]", className)}
      >
        <span
          title={message.error || t("chat.delivery.failed")}
          aria-label={t("chat.delivery.failed")}
          className="inline-flex items-center"
        >
          <AlertCircle size={12} strokeWidth={2} aria-hidden="true" />
        </span>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            aria-label={t("chat.delivery.retryAria")}
            title={t("chat.retry")}
            className="relative inline-flex min-h-[44px] min-w-[44px] items-center justify-center p-1 font-medium underline hover:text-danger"
          >
            {t("chat.retry")}
          </button>
        )}
      </span>
    );
  }

  return null;
});
