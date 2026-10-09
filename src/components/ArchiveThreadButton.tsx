import { useState } from "react";
import { Archive } from "lucide-react";
import { useStore, type Bot } from "@/state/store";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";
import { isArchived, isWorking, orderedThreadList } from "./SidebarThreadRow";

/** Where the person lands once the current thread is put away: the most
 * recent other thread that is still on the list, or null when none is left. */
export function archiveThreadDestination(bot: Bot): string | null {
  const open = (bot.tasks ?? []).filter((task) => task.threadId !== bot.threadId && !isArchived(task));
  return orderedThreadList(open)[0]?.threadId ?? null;
}

/** Header shortcut for the sidebar's "Archive" thread action: the same
 * updateTask archivedAt patch, behind the same confirmation the bot archive
 * uses. A running thread cannot be archived from the sidebar menu, so the
 * button stays put but inert, with the reason as its tooltip. */
export function ArchiveThreadButton({ bot }: { bot: Bot }) {
  const { dispatch } = useStore();
  const [confirming, setConfirming] = useState(false);
  const task = bot.tasks?.find((candidate) => candidate.threadId === bot.threadId);
  if (task && isArchived(task)) return null;
  const title = task?.title || t("chat.archiveThreadUntitled");
  const running = Boolean(bot.busy) || (task ? isWorking(task) : false);
  const label = running ? t("chat.archiveThreadRunning") : t("chat.archiveThread");
  return (
    <>
      <button
        type="button"
        data-archive-thread=""
        title={label}
        aria-label={running ? label : t("chat.archiveThreadAria", { title })}
        aria-disabled={running || undefined}
        onClick={() => { if (!running) setConfirming(true); }}
        className={cn(
          "rounded-md p-1.5 outline-none focus-visible:ring-2 focus-visible:ring-accent",
          running ? "cursor-not-allowed text-ink-tertiary" : "text-ink-secondary hover:bg-raised hover:text-ink",
        )}
      >
        <Archive size={18} aria-hidden="true" />
      </button>
      <ConfirmDialog
        open={confirming}
        tone="neutral"
        icon={<Archive size={18} />}
        title={t("chat.archiveThreadTitle")}
        body={t("chat.archiveThreadBody", { title })}
        confirmLabel={t("task.archive")}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          // Same patch the sidebar menu sends. The open thread always stays
          // on the sidebar list, so move off it or "archived" would show nothing.
          dispatch({ type: "updateTask", botId: bot.id, threadId: bot.threadId, patch: { archivedAt: Date.now() } });
          const next = archiveThreadDestination(bot);
          if (next) dispatch({ type: "switchTask", botId: bot.id, threadId: next });
          else dispatch({ type: "newTask", botId: bot.id });
        }}
      />
    </>
  );
}
