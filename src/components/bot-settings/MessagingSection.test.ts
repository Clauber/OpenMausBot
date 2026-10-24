// The Messaging section's rendering contract: token entry is write-only
// (password fields, nothing echoed back), and a bound platform shows live
// transport state with pairing and unpair controls. Static renders of the
// states; no real server takes part.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MessagingBindingCard, messagingStatusBadge, socketStatusBadge, type PlatformCard } from "./MessagingSection";

const card = (overrides: Partial<PlatformCard> = {}): PlatformCard => ({
  platform: "telegram",
  id: "tg_fixture",
  botMissing: false,
  label: "Telegram · @pepper_bot",
  badge: messagingStatusBadge("poll", "polling"),
  pairing: null,
  chats: [{ chatId: "42", threadId: "thr42", enabled: true, name: "Ada", pairedAt: 3 }],
  ...overrides,
});
const noop = () => undefined;

describe("Messaging section", () => {
  it("badges poll and webhook delivery by live poller state", () => {
    expect(messagingStatusBadge("poll", "polling")).toMatchObject({ key: "botMessaging.poller.polling", ok: true });
    expect(messagingStatusBadge("poll", "backing-off").ok).toBe(false);
    expect(messagingStatusBadge("poll", undefined)).toMatchObject({ key: "botMessaging.poller.stopped", ok: false });
    expect(messagingStatusBadge("webhook", undefined)).toMatchObject({ key: "botMessaging.transportWebhook", ok: true });
  });

  it("badges socket-backed platforms by live state", () => {
    expect(socketStatusBadge("connected")).toMatchObject({ key: "botMessaging.socket.connected", ok: true });
    expect(socketStatusBadge("reconnecting").ok).toBe(false);
    expect(socketStatusBadge("polling" as string).ok).toBe(false);
    expect(socketStatusBadge(undefined)).toMatchObject({ key: "botMessaging.socket.stopped", ok: false });
  });

  it("shows the bound Telegram bot with status, the paired chat, and mute/unpair controls", () => {
    const markup = renderToStaticMarkup(createElement(MessagingBindingCard, { card: card(), onCommand: noop }));
    expect(markup).toContain("@pepper_bot");
    expect(markup).toContain("Listening");
    expect(markup).toContain("Ada");
    expect(markup).toContain("Unpair");
    expect(markup).toContain("Mute");
    expect(markup).toContain("Unbind Telegram");
    expect(markup).toContain("New pairing code");
    // a bound card never renders a token field
    expect(markup).not.toMatch(/type="password"/);
  });

  it("shows bound Slack and Discord apps with socket status and per-platform controls", () => {
    const slackMarkup = renderToStaticMarkup(createElement(MessagingBindingCard, {
      card: card({ platform: "slack", id: "sl_fixture", label: "Slack · Dunder Mifflin", badge: socketStatusBadge("connected"),
        chats: [{ chatId: "D01", threadId: "thr01", enabled: true, name: "@U061", pairedAt: 3 }] }),
      onCommand: noop,
    }));
    expect(slackMarkup).toContain("Slack · Dunder Mifflin");
    expect(slackMarkup).toContain("Connected");
    expect(slackMarkup).toContain("@U061");
    expect(slackMarkup).toContain("Unbind Slack");
    const discordMarkup = renderToStaticMarkup(createElement(MessagingBindingCard, {
      card: card({ platform: "discord", id: "dc_fixture", label: "Discord · @fake_omb_bot", badge: socketStatusBadge("reconnecting"),
        chats: [{ chatId: "888", threadId: "thr88", enabled: true, name: "@clauber", pairedAt: 3 }] }),
      onCommand: noop,
    }));
    expect(discordMarkup).toContain("Discord · @fake_omb_bot");
    expect(discordMarkup).toContain("Reconnecting…");
    expect(discordMarkup).toContain("@clauber");
    expect(discordMarkup).toContain("Unbind Discord");
    for (const markup of [slackMarkup, discordMarkup]) expect(markup).not.toMatch(/type="password"/);
  });

  it("surfaces transport errors and a missing bot on every platform", () => {
    const telegramMarkup = renderToStaticMarkup(createElement(MessagingBindingCard, {
      card: card({ botMissing: true, error: "Telegram getUpdates failed (409): Conflict" }),
      onCommand: noop,
    }));
    expect(telegramMarkup).toContain("Telegram getUpdates failed (409): Conflict");
    expect(telegramMarkup).toContain("This bot no longer exists");
    const discordMarkup = renderToStaticMarkup(createElement(MessagingBindingCard, {
      card: card({ platform: "discord", id: "dc_fixture", label: "Discord · @fake_omb_bot", botMissing: true,
        badge: socketStatusBadge("error"), error: "Discord gateway/bot failed (401): 401: Unauthorized" }),
      onCommand: noop,
    }));
    expect(discordMarkup).toContain("Error");
    expect(discordMarkup).toContain("401: Unauthorized");
    expect(discordMarkup).toContain("This bot no longer exists");
  });

  it("hides chat controls when nothing is paired", () => {
    const markup = renderToStaticMarkup(createElement(MessagingBindingCard, { card: card({ chats: [] }), onCommand: noop }));
    expect(markup).not.toContain("Unpair");
    expect(markup).toContain("Unbind Telegram");
    const discordMarkup = renderToStaticMarkup(createElement(MessagingBindingCard, {
      card: card({ platform: "discord", id: "dc_fixture", label: "Discord · @fake_omb_bot", chats: [] }),
      onCommand: noop,
    }));
    expect(discordMarkup).not.toContain("Unpair");
  });
});
