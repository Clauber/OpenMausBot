// Parallel threads: how many threads this bot may run at once. Unset follows
// the workspace default (App Settings), so the first option names that
// default's live value.
import { t } from "@/lib/i18n";
import { useStore, type Bot } from "@/state/store";

const LIMITS = Array.from({ length: 10 }, (_, i) => i + 1);

/** The select's value as a bot patch: "" returns the bot to the default. */
export function parallelThreadsPatch(value: string): { maxConcurrentThreads: number | null } {
  return { maxConcurrentThreads: value === "" ? null : Number(value) };
}

export function ParallelThreadsCard({ bot }: { bot: Bot }) {
  const { state, dispatch } = useStore();
  const defaultLimit = state.config?.threads?.maxConcurrentPerBot ?? 3;
  return (
    <div className="rounded-xl bg-card p-4">
      <div className="text-[15px] font-medium text-ink">{t("botSettings.threads.title")}</div>
      <label htmlFor="bot-thread-limit" className="mt-3 block text-[13px] text-ink">{t("botSettings.threads.label")}</label>
      <select
        id="bot-thread-limit"
        value={bot.maxConcurrentThreads === undefined ? "" : String(bot.maxConcurrentThreads)}
        aria-describedby="bot-thread-limit-help"
        onChange={(event) => dispatch({ type: "updateBot", botId: bot.id, patch: parallelThreadsPatch(event.target.value) })}
        className="mt-2 rounded-lg border border-hairline/40 bg-inset px-3 py-2 text-[13px] text-ink"
      >
        <option value="">{t("botSettings.threads.useDefault", { limit: defaultLimit })}</option>
        {LIMITS.map((limit) => <option key={limit} value={limit}>{limit}</option>)}
      </select>
      <p id="bot-thread-limit-help" className="mt-2 text-[12.5px] text-ink-secondary">{t("botSettings.threads.help")}</p>
    </div>
  );
}
