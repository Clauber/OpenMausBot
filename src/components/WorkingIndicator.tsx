// Duty-cycled activity indicators. A spinner repaints every vsync for its
// whole lifetime; these dots step through a few opacity holds per cycle,
// and the timer mutates its own text node once a second instead of
// committing through React. Long-lived indicators must stay this cheap.
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { CircleAlert } from "lucide-react";
import { t } from "@/lib/i18n";
import { formatElapsed } from "@/lib/working-time";

export function WorkingDots({ size = 4, className }: { size?: number; className?: string }) {
  return (
    <span className={cn("flex items-center gap-1", className)} aria-hidden="true">
      {[0, 200, 400].map((delay) => (
        <span
          key={delay}
          className="animate-status-pulse rounded-full bg-current"
          style={{ width: size, height: size, animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  );
}

/** The same typing dots and waiting marker at every sidebar avatar size. */
export function SidebarActivityIndicator({ working, waiting, className }: { working: boolean; waiting: boolean; className?: string }) {
  if (!working && !waiting) return null;
  const state = waiting ? "waiting" : "working";
  const label = t(waiting ? "sidebar.preview.waiting" : "sidebar.preview.working");
  return <span data-sidebar-activity={state} data-testid={waiting ? "waiting-dot" : "working-dot"} role="status" aria-label={label} title={label}
    className={cn("flex shrink-0 items-center justify-center", waiting ? "text-warning" : "text-success", className)}>
    {waiting ? <CircleAlert size={12} aria-hidden="true" /> : <WorkingDots size={3.5} />}
  </span>;
}

/** Self-ticking elapsed readout — counts up from `since` (epoch ms). */
export function WorkingTimer({ since, className }: { since: number; className?: string }) {
  const node = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const tick = () => {
      if (node.current) node.current.textContent = formatElapsed(Date.now() - since);
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [since]);
  return <span ref={node} className={cn("tabular-nums", className)} />;
}
