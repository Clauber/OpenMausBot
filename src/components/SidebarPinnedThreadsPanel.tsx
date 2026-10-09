import type { DragEvent } from "react";
import { ChevronDown, ChevronRight, Pin } from "lucide-react";
import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import type { SidebarDensity } from "@/lib/sidebar-preferences";
import { PinnedThreadRows, type AttentionThread } from "./SidebarBotActivity";

/** A cross-bot, cross-room list of every pinned thread, living between
 * search and the bots list — pinned bots already get this top-level view
 * (the built-in Pinned section); pinned threads did not. Renders nothing
 * when there is no pin, so it never costs space it isn't using. */
export function SidebarPinnedThreadsPanel({ entries, density, now, onJump, onUnpin, collapsed, onToggle, acceptBotDrop = false, draggingBot = false, onDragOver, onDrop, onThreadDragStart, onDragEnd }: {
  entries: AttentionThread[];
  acceptBotDrop?: boolean;
  draggingBot?: boolean;
  onDragOver?: (event: DragEvent<HTMLElement>) => void;
  onDrop?: (event: DragEvent<HTMLElement>) => void;
  onThreadDragStart?: (event: DragEvent<HTMLElement>, entry: AttentionThread) => void;
  onDragEnd?: () => void;
  density: SidebarDensity;
  now: number;
  onJump: (entry: AttentionThread) => void;
  onUnpin: (entry: AttentionThread) => void;
  collapsed: boolean;
  onToggle?: () => void;
}) {
  if (entries.length === 0 && !acceptBotDrop) return null;
  const compact = density === "compact";
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <section
      data-testid="sidebar-pinned-threads-panel"
      onDragOver={onDragOver}
      onDrop={onDrop}
      aria-label={t("sidebar.pinnedThreads.title")}
      className={cn("mx-2 overflow-hidden rounded-lg border border-hairline/40 bg-inset/30", compact ? "mb-1.5" : "mb-2", draggingBot && "border-accent bg-accent/10")}
    >
      <div className="flex items-center gap-1.5 px-2.5 pb-1 pt-1.5 text-[11.5px] font-medium text-ink-secondary">
        <button
          type="button"
          onClick={onToggle}
          disabled={!onToggle}
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? "sidebar.section.expand" : "sidebar.section.collapse", { name: t("sidebar.pinnedThreads.title") })}
          className="flex size-5 shrink-0 items-center justify-center rounded text-ink-secondary hover:bg-raised hover:text-ink"
        >
          <Chevron size={compact ? 11 : 12} aria-hidden="true" />
        </button>
        <Pin size={compact ? 11 : 12} aria-hidden="true" className="shrink-0" />
        <span className="min-w-0 flex-1 truncate">{t("sidebar.pinnedThreads.title")}</span>
        <span className="text-[10.5px] font-normal tabular-nums">{entries.length}</span>
      </div>
      {entries.length === 0 && <p className="px-3 pb-2 text-[11px] text-ink-secondary">{t("sidebar.bots.dropToPin")}</p>}
      {!collapsed && (
        <div className="max-h-56 overflow-y-auto">
          <PinnedThreadRows entries={entries} now={now} onJump={onJump} onUnpin={onUnpin} onDragStart={onThreadDragStart} onDragEnd={onDragEnd} />
        </div>
      )}
    </section>
  );
}
