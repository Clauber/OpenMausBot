import { requestNotificationPermission } from "@/lib/notify";
import { t } from "@/lib/i18n";
import type { Bot } from "@/state/store";
import { Switch } from "../SettingsPrimitives";
import { VoiceSettings } from "../VoiceSettings";
import type { useBotSettingsDerived } from "./useBotSettingsDerived";
import { useBotEditor } from "./BotEditorContext";
import { Select } from "../Select";

/** The per-agent call engine, as the select offers it. "default" follows the
 * global Live setting; "none" refuses Live calls so the call button always
 * starts a spoken-replies call with this bot. */
const CALL_ENGINE_CHOICES: ReadonlyArray<{ id: "default" | "openai" | "codex" | "none"; label: string }> = [
  { id: "default", label: "Default (follows call settings)" },
  { id: "openai", label: "OpenAI key" },
  { id: "codex", label: "ChatGPT (Codex sign-in)" },
  { id: "none", label: "Off — spoken replies only" },
];

export function VoiceSection({
  bot,
  derived,
}: {
  bot: Bot;
  derived: ReturnType<typeof useBotSettingsDerived>;
}) {
  const { patch } = derived;
  const { draft } = useBotEditor();

  return (
    <div className="flex flex-col gap-4">
      <VoiceSettings bot={bot} onPatch={patch} />

      <label className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
        <span className="min-w-0">
          <span className="block text-[15px] font-medium text-ink">Live call engine</span>
          <span className="mt-0.5 block text-[13px] text-ink-secondary">
            Which voice engine a live call with this agent uses
          </span>
        </span>
        <Select
          value={bot.callEngine ?? "default"}
          aria-label="Live call engine"
          onChange={(event) => patch({ callEngine: event.target.value as Bot["callEngine"] })}
          className="min-w-0 shrink-0"
        >
          {CALL_ENGINE_CHOICES.map((choice) => (
            <option key={choice.id} value={choice.id}>{choice.label}</option>
          ))}
        </Select>
      </label>

      <div className="flex items-center justify-between gap-4 rounded-xl bg-card p-4">
        <div>
          <div className="text-[15px] font-medium text-ink">{t("voice.notifications.title")}</div>
          <div className="mt-0.5 text-[13px] text-ink-secondary">
            {t("voice.notifications.help")}
          </div>
        </div>
        <Switch
          checked={bot.notifications}
          aria-label={t("voice.notifications.label")}
          onClick={() => {
            const enabled = !bot.notifications;
            if (enabled && !draft) void requestNotificationPermission();
            patch({ notifications: enabled });
          }}
        />
      </div>
    </div>
  );
}
