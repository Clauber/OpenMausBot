import { useMemo, useRef, useState } from "react";
import { MessagesSquare } from "lucide-react";
import { useStore } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { usePopoverDismiss } from "@/hooks/use-popover-dismiss";
import { AttentionThreadRows, attentionJumpAction, crossBotAllThreads } from "./SidebarBotActivity";

/** Header button listing every thread across bots and rooms, pinned first then most recent. */
export function AllThreadsButton() {
  const { state, dispatch } = useStore();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  usePopoverDismiss(open, rootRef, () => setOpen(false));
  const entries = useMemo(
    () => crossBotAllThreads(state.bots.filter((bot) => bot.id === state.selectedId), [], state.pendingQueued),
    [state.bots, state.selectedId, state.pendingQueued],
  );
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        data-tour="all-threads"
        onClick={() => setOpen((value) => !value)}
        aria-label={t("task.switch")}
        aria-expanded={open}
        title={t("task.switch")}
        className={cn(
          "relative rounded-md p-1.5 hover:bg-raised",
          open ? "text-accent" : "text-ink-secondary hover:text-ink",
        )}
      >
        <MessagesSquare size={18} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={t("task.switch")}
          data-chat-all-threads=""
          className="absolute top-full right-0 z-40 mt-1 max-h-[min(60vh,480px)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border border-hairline/50 bg-menu py-1.5 shadow-2xl shadow-black/50"
        >
          <AttentionThreadRows
            entries={entries}
            onJump={(entry) => {
              setOpen(false);
              dispatch(attentionJumpAction(entry));
            }}
          />
        </div>
      )}
    </div>
  );
}
