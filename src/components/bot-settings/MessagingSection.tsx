// Chat apps in Bot settings: bind this bot to a Telegram bot, a Slack app, or
// a Discord application's bot, pair conversations by code, mute or unpair
// them, and unbind. Platform tokens are write-only — they are sent once on
// bind and never displayed, prefilled, or returned by any read here.
import { useCallback, useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { api } from "@/state/store";
import { t } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { Bot } from "@/state/store";

interface MessagingChat { chatId: string; threadId: string; enabled: boolean; name?: string; pairedAt: number }
export interface MessagingBinding {
  id: string;
  botId: string;
  botMissing: boolean;
  username: string | null;
  markdown: boolean;
  createdAt: number;
  transport: "poll" | "webhook";
  poller: { status: string; error?: string; at: number } | null;
  pairing: { expiresAt: number } | null;
  chats: MessagingChat[];
}
interface SocketBindingApi {
  id: string;
  botId: string;
  botMissing: boolean;
  createdAt: number;
  socket: { status: string; error?: string; at: number } | null;
  pairing: { expiresAt: number } | null;
}
type SlackBindingApi = SocketBindingApi & { teamName: string | null; botName: string | null; chats: Array<MessagingChat & { channelId: string }> };
type DiscordBindingApi = SocketBindingApi & { username: string | null; chats: Array<MessagingChat & { channelId: string }> };

/** What the shared card renders, whatever the platform. */
export interface PlatformCard {
  platform: "telegram" | "slack" | "discord";
  id: string;
  botMissing: boolean;
  label: string;
  badge: { key: string; ok: boolean };
  error?: string;
  pairing: { expiresAt: number } | null;
  chats: MessagingChat[];
}

const POLL_REFRESH_MS = 8_000;
const PLATFORM_NAME = { telegram: "Telegram", slack: "Slack", discord: "Discord" } as const;

export function messagingStatusBadge(transport: "poll" | "webhook", pollerStatus: string | undefined): { key: string; ok: boolean } {
  if (transport === "webhook") return { key: "botMessaging.transportWebhook", ok: true };
  const status = pollerStatus ?? "stopped";
  return { key: `botMessaging.poller.${status}`, ok: status === "polling" };
}

/** Slack and Discord both keep a live socket; badge by its state. */
export function socketStatusBadge(socketStatus: string | undefined): { key: string; ok: boolean } {
  const status = socketStatus ?? "stopped";
  return { key: `botMessaging.socket.${status}`, ok: status === "connected" };
}

function telegramCard(binding: MessagingBinding): PlatformCard {
  return {
    platform: "telegram",
    id: binding.id,
    botMissing: binding.botMissing,
    label: `Telegram${binding.username ? ` · @${binding.username}` : ""}`,
    badge: messagingStatusBadge(binding.transport, binding.poller?.status),
    error: binding.poller?.error,
    pairing: binding.pairing,
    chats: binding.chats,
  };
}

function slackCard(binding: SlackBindingApi): PlatformCard {
  return {
    platform: "slack",
    id: binding.id,
    botMissing: binding.botMissing,
    label: `Slack${binding.teamName ? ` · ${binding.teamName}` : ""}`,
    badge: socketStatusBadge(binding.socket?.status),
    error: binding.socket?.error,
    pairing: binding.pairing,
    chats: binding.chats.map(({ channelId, ...chat }) => ({ ...chat, chatId: channelId })),
  };
}

function discordCard(binding: DiscordBindingApi): PlatformCard {
  return {
    platform: "discord",
    id: binding.id,
    botMissing: binding.botMissing,
    label: `Discord${binding.username ? ` · @${binding.username}` : ""}`,
    badge: socketStatusBadge(binding.socket?.status),
    error: binding.socket?.error,
    pairing: binding.pairing,
    chats: binding.chats.map(({ channelId, ...chat }) => ({ ...chat, chatId: channelId })),
  };
}

/** One bound platform: status, pairing, paired chats, unbind. */
export function MessagingBindingCard({ card, onCommand }: {
  card: PlatformCard;
  onCommand(work: () => Promise<unknown>): void;
}) {
  const [pairing, setPairing] = useState<{ code: string; expiresAt: number } | null>(null);
  const path = `/api/messaging/${card.platform}/${card.id}`;
  return (
    <div className="flex flex-col gap-3 rounded-xl bg-control/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-ink">{card.label}</span>
        <span className={cn("rounded-full px-2 py-0.5 text-[11px]", card.badge.ok ? "bg-green-500/15 text-green-600" : "bg-amber-500/15 text-amber-600")}>
          {t(card.badge.key as Parameters<typeof t>[0])}
        </span>
        {card.botMissing && <span className="text-red-500">{t("botMessaging.botMissing")}</span>}
        {card.error && <span className="text-amber-600">{card.error}</span>}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onCommand(async () => setPairing(await api(`${path}/pairing`, { method: "POST", body: "{}" })))}
          className="rounded-lg bg-control px-3 py-1.5 font-medium text-ink hover:bg-control/70"
        >
          {t("botMessaging.newPairingCode")}
        </button>
        {pairing && (
          <span className="font-mono text-ink">
            {pairing.code} · {t("botMessaging.pairingExpires")} {new Date(pairing.expiresAt).toLocaleTimeString()}
          </span>
        )}
        {!pairing && card.pairing && (
          <span className="text-[12px]">{t("botMessaging.pairingActiveUntil")} {new Date(card.pairing.expiresAt).toLocaleTimeString()}</span>
        )}
      </div>

      {card.chats.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {card.chats.map((chat) => (
            <li key={chat.chatId} className="flex flex-wrap items-center gap-2">
              <span className="text-ink">{chat.name ?? chat.chatId}</span>
              <span className="text-[11.5px] opacity-70">{chat.threadId}</span>
              <button
                type="button"
                onClick={() => onCommand(() => api(`${path}/chats/${chat.chatId}`, { method: "PATCH", body: JSON.stringify({ enabled: !chat.enabled }) }))}
                className="rounded-md bg-control px-2 py-0.5 text-[11.5px] text-ink hover:bg-control/70"
              >
                {chat.enabled ? t("botMessaging.mute") : t("botMessaging.unmute")}
              </button>
              <button
                type="button"
                onClick={() => onCommand(() => api(`${path}/chats/${chat.chatId}`, { method: "DELETE" }))}
                className="rounded-md bg-control px-2 py-0.5 text-[11.5px] text-ink hover:bg-control/70"
              >
                {t("botMessaging.unpair")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => {
          if (!window.confirm(t("botMessaging.unbindConfirm"))) return;
          setPairing(null);
          onCommand(() => api(path, { method: "DELETE" }));
        }}
        className="w-fit rounded-lg bg-control px-3 py-1.5 font-medium text-red-500 hover:bg-control/70"
      >
        {t("botMessaging.unbind")} {PLATFORM_NAME[card.platform]}
      </button>
    </div>
  );
}

/** Write-only token form: password inputs, submit-only, cleared after bind. */
function BindForm({ platform, label, hint, placeholders, needsTwo, botId }: {
  platform: string;
  label: string;
  hint: string;
  placeholders: [string] | [string, string];
  needsTwo: boolean;
  botId: string;
}) {
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [busy, setBusy] = useState(false);
  const disabled = busy || first.trim().length < 10 || (needsTwo && second.trim().length < 10);
  const submit = async () => {
    if (platform === "telegram") {
      await api("/api/messaging/telegram", { method: "POST", body: JSON.stringify({ botId, token: first.trim() }) });
    } else if (platform === "slack") {
      await api("/api/messaging/slack", { method: "POST", body: JSON.stringify({ botId, appToken: first.trim(), botToken: second.trim() }) });
    } else {
      await api("/api/messaging/discord", { method: "POST", body: JSON.stringify({ botId, token: first.trim() }) });
    }
    setFirst("");
    setSecond("");
  };
  const inputClass = "w-full rounded-lg bg-control px-3 py-2 font-mono text-[12.5px] text-ink outline-none placeholder:text-ink-tertiary";
  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1">
        <span className="font-medium text-ink">{label}</span>
        <input
          type="password"
          autoComplete="off"
          value={first}
          onChange={(event) => setFirst(event.target.value)}
          placeholder={placeholders[0]}
          className={inputClass}
        />
        {needsTwo && (
          <input
            type="password"
            autoComplete="off"
            value={second}
            onChange={(event) => setSecond(event.target.value)}
            placeholder={placeholders[1]}
            className={inputClass}
          />
        )}
      </label>
      <button
        type="button"
        disabled={disabled}
        onClick={() => {
          setBusy(true);
          void submit().finally(() => setBusy(false));
        }}
        className="flex w-fit items-center gap-2 rounded-lg bg-control px-3 py-2 font-medium text-ink hover:bg-control/70 disabled:opacity-50"
      >
        {busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
        {t("botMessaging.bind")} {PLATFORM_NAME[platform as keyof typeof PLATFORM_NAME]}
      </button>
      <p className="text-[12px]">{hint}</p>
    </div>
  );
}

export function MessagingSection({ bot }: { bot: Pick<Bot, "id"> }) {
  const [cards, setCards] = useState<PlatformCard[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [telegramList, slackList, discordList] = await Promise.all([
        api<{ bindings: MessagingBinding[] }>("/api/messaging/telegram"),
        api<{ bindings: SlackBindingApi[] }>("/api/messaging/slack"),
        api<{ bindings: DiscordBindingApi[] }>("/api/messaging/discord"),
      ]);
      const mine: PlatformCard[] = [];
      for (const entry of telegramList.bindings) if (entry.botId === bot.id) mine.push(telegramCard(entry));
      for (const entry of slackList.bindings) if (entry.botId === bot.id) mine.push(slackCard(entry));
      for (const entry of discordList.bindings) if (entry.botId === bot.id) mine.push(discordCard(entry));
      setCards(mine);
      setLoadError(null);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    }
  }, [bot.id]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_REFRESH_MS);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = useCallback(async (work: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await work();
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    }
  }, [refresh]);

  const bound = (platform: PlatformCard["platform"]) => cards?.find((card) => card.platform === platform);

  return (
    <div className="flex flex-col gap-4 text-[13px] leading-relaxed text-ink-secondary">
      <p>{t("botMessaging.intro")}</p>
      {loadError && <p className="text-red-500">{t("botMessaging.loadError", { error: loadError })}</p>}
      {actionError && <p className="text-red-500">{actionError}</p>}

      <section className="flex flex-col gap-2" data-messaging-platform="telegram">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">{t("botMessaging.telegramHeading")}</h3>
        {bound("telegram")
          ? <MessagingBindingCard card={bound("telegram")!} onCommand={run} />
          : (
            <BindForm platform="telegram" botId={bot.id}
              label={t("botMessaging.tokenLabel")} hint={t("botMessaging.bindHint")} placeholders={["123456:ABC…"]} needsTwo={false} />
          )}
      </section>

      <section className="flex flex-col gap-2" data-messaging-platform="slack">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">{t("botMessaging.slackHeading")}</h3>
        {bound("slack")
          ? <MessagingBindingCard card={bound("slack")!} onCommand={run} />
          : (
            <BindForm platform="slack" botId={bot.id}
              label={t("botMessaging.slackTokensLabel")} hint={t("botMessaging.slackBindHint")} placeholders={["xapp-1-…", "xoxb-…"]} needsTwo />
          )}
      </section>

      <section className="flex flex-col gap-2" data-messaging-platform="discord">
        <h3 className="text-[12px] font-semibold uppercase tracking-wide text-ink-secondary">{t("botMessaging.discordHeading")}</h3>
        {bound("discord")
          ? <MessagingBindingCard card={bound("discord")!} onCommand={run} />
          : (
            <BindForm platform="discord" botId={bot.id}
              label={t("botMessaging.discordTokenLabel")} hint={t("botMessaging.discordBindHint")} placeholders={["MT…"]} needsTwo={false} />
          )}
      </section>
    </div>
  );
}
