import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  phoneMenuItems,
  profileInitials,
  profileLabel,
  updateBusy,
  updateNoteworthy,
  updateLabel,
  updatePhase,
} from "./SidebarProfileMenu";
import { ANDROID_APK_URL, DOCS_URL, FEEDBACK_URL, HELP_CENTER_URL, IOS_APP_STORE_URL, platformLabel } from "@/lib/app-links";
import { connectPhoneEntry, type PhonePairingAccess } from "@/lib/phone-pairing";
import { PHONE_APPS, PhoneAppDialog } from "./PhoneAppDialog";
import type { UpdaterState } from "@/lib/updater";

const state = (patch: Partial<UpdaterState>): UpdaterState => ({ status: "idle", ...patch }) as UpdaterState;

describe("profileInitials", () => {
  it("takes the first letter of the first two words", () => {
    expect(profileInitials({ name: "Milind Soni" })).toBe("MS");
    expect(profileInitials({ name: "Ada Byron Lovelace" })).toBe("AB");
  });

  it("falls back to the email, then to a placeholder", () => {
    expect(profileInitials({ email: "you@x.dev" })).toBe("Y");
    expect(profileInitials({})).toBe("?");
    expect(profileInitials(undefined)).toBe("?");
  });

  it("ignores whitespace-only names", () => {
    expect(profileInitials({ name: "   ", email: "you@x.dev" })).toBe("Y");
  });
});

describe("profileLabel", () => {
  it("prefers the name, then the email, then You", () => {
    expect(profileLabel({ name: "Omkar", email: "o@x.dev" })).toBe("Omkar");
    expect(profileLabel({ email: "o@x.dev" })).toBe("o@x.dev");
    expect(profileLabel(undefined)).toBe("You");
  });
});

describe("updatePhase", () => {
  it("reports the bridge's own in-flight states", () => {
    expect(updatePhase(state({ status: "checking" }), false)).toBe("checking");
    expect(updatePhase(state({ status: "downloading" }), false)).toBe("downloading");
    expect(updatePhase(state({ status: "preparing" }), false)).toBe("preparing");
    expect(updatePhase(state({ status: "installing" }), false)).toBe("installing");
  });

  it("acknowledges a check that found nothing", () => {
    expect(updatePhase(null, true)).toBe("up-to-date");
    expect(updatePhase(null, false)).toBe("idle");
  });

  // the acknowledgement is only for a genuinely quiet result — a found
  // update must not be papered over by a stale "up to date"
  it("lets a real status outrank the acknowledgement", () => {
    expect(updatePhase(state({ status: "available" }), true)).toBe("available");
  });
});

describe("updateLabel", () => {
  it("names the version it found and the one it is ready to install", () => {
    expect(updateLabel("available", state({ status: "available", version: "0.2.0" }))).toBe(
      "Version 0.2.0 available — download",
    );
    expect(updateLabel("downloaded", state({ status: "downloaded", version: "0.2.0" }))).toBe(
      "Version 0.2.0 ready — restart",
    );
  });

  it("shows progress only once there is a percentage", () => {
    expect(updateLabel("downloading", state({ status: "downloading" }))).toBe("Starting download…");
    expect(updateLabel("downloading", state({ status: "downloading", percent: 41.6 }))).toBe("Downloading… 42%");
  });

  it("distinguishes native preparation from restart readiness", () => {
    expect(updateLabel("preparing", state({ status: "preparing", percent: 100 }))).toBe("Preparing update…");
    expect(updateLabel("installing", state({ status: "installing", message: "Restart is taking longer than expected." })))
      .toBe("Restart is taking longer than expected.");
    expect(updateLabel("downloaded", state({ status: "downloaded", version: "0.2.0", installMode: "handoff" })))
      .toBe("Version 0.2.0 ready — install");
    expect(updateLabel("installing", state({ status: "installing", installMode: "handoff" })))
      .toBe("Opening a terminal…");
  });

  it("carries the updater's own message when something failed", () => {
    expect(updateLabel("error", state({ status: "error", message: "Network unreachable" }))).toBe(
      "Network unreachable",
    );
    expect(updateLabel("error", state({ status: "error" }))).toBe("Update failed — try again");
  });

  it("points a hand-off at the terminal that finishes it", () => {
    expect(updateLabel("handed-off", state({ status: "handed-off" }))).toBe(
      "Finish the update in your terminal",
    );
  });

  it("defaults to the invitation to check", () => {
    expect(updateLabel("idle", null)).toBe("Check for updates");
    expect(updateLabel("up-to-date", null)).toBe("You're up to date");
  });
});

describe("updateBusy", () => {
  it("blocks clicks while something is in flight", () => {
    expect(updateBusy("checking")).toBe(true);
    expect(updateBusy("downloading")).toBe(true);
    expect(updateBusy("preparing")).toBe(true);
    expect(updateBusy("installing")).toBe(true);
    expect(updateBusy("available")).toBe(false);
    expect(updateBusy("downloaded")).toBe(false);
    expect(updateBusy("idle")).toBe(false);
  });

  // the click starts a round-trip through main; until it lands, the status
  // still reads "available" and the row would otherwise invite a second click
  it("blocks the gap between the click and the bridge catching up", () => {
    expect(updateBusy("available", true)).toBe(true);
    expect(updateBusy("downloaded", true)).toBe(true);
  });
});

describe("platformLabel", () => {
  it("names the platforms we ship, and stays quiet otherwise", () => {
    expect(platformLabel("darwin")).toBe("macOS");
    expect(platformLabel("win32")).toBe("Windows");
    expect(platformLabel("linux")).toBe("Linux");
    expect(platformLabel("freebsd")).toBeNull();
    expect(platformLabel(undefined)).toBeNull();
  });
});

describe("updateNoteworthy", () => {
  it("puts a real update on the profile row", () => {
    expect(updateNoteworthy("available")).toBe(true);
    expect(updateNoteworthy("downloading")).toBe(true);
    expect(updateNoteworthy("preparing")).toBe(true);
    expect(updateNoteworthy("downloaded")).toBe(true);
    expect(updateNoteworthy("installing")).toBe(true);
    expect(updateNoteworthy("error")).toBe(true);
    expect(updateNoteworthy("handed-off")).toBe(true);
  });

  // a check the user started from inside the open menu is answered there;
  // badging the row for it would flash at someone already looking elsewhere
  it("leaves a quiet updater quiet", () => {
    expect(updateNoteworthy("idle")).toBe(false);
    expect(updateNoteworthy("checking")).toBe(false);
    expect(updateNoteworthy("up-to-date")).toBe(false);
  });

  it("shows the click that has not landed yet", () => {
    expect(updateNoteworthy("idle", true)).toBe(true);
  });
});

describe("outward links", () => {
  // both were pointed somewhere else once; pin them so a future tidy-up of
  // app-links does not quietly send Help back to the README
  it("sends Help Center to the docs the website also links to", () => {
    expect(HELP_CENTER_URL).toBe(DOCS_URL);
    expect(DOCS_URL).toBe("https://github.com/milind-soni/OpenMausBot/tree/main/docs");
  });

  it("sends Send Feedback to the Discord community", () => {
    expect(FEEDBACK_URL).toBe("https://discord.gg/9Wb8MEpXRs");
  });
});

describe("the phone entries", () => {
  const admin: PhonePairingAccess = { session: { kind: "session", id: "s", label: "Mac", scopes: ["admin", "client"], expiresAt: 1 }, pairingCodes: true };
  const chatOnly: PhonePairingAccess = { session: { kind: "session", id: "s", label: "Phone", scopes: ["client"], expiresAt: 1 }, pairingCodes: true };
  const items = (entry: ReturnType<typeof connectPhoneEntry>, connected = false) => {
    const onConnect = vi.fn(), onGetApp = vi.fn();
    return { list: phoneMenuItems({ entry, connected, onConnect, onGetApp }), onConnect, onGetApp };
  };
  const shown = (entry: ReturnType<typeof connectPhoneEntry>) => items(entry).list.map((item) => [item.label, item.subtitle ?? null]);

  it("on this computer: Connect your phone, to this computer, then Get the phone app", () => {
    expect(shown(connectPhoneEntry("computer", null))).toEqual([["Connect your phone", "to this computer"], ["Get the phone app", null]]);
  });

  it("on the person's own Cloud: Connect your phone, to your Cloud", () => {
    expect(shown(connectPhoneEntry("cloud", admin))).toEqual([["Connect your phone", "to your Cloud"], ["Get the phone app", null]]);
  });

  it("on another server: to this server, and gone for a session that cannot make a pairing code", () => {
    expect(shown(connectPhoneEntry("server", admin))).toEqual([["Connect your phone", "to this server"], ["Get the phone app", null]]);
    expect(shown(connectPhoneEntry("server", chatOnly))).toEqual([["Get the phone app", null]]);
    expect(shown(connectPhoneEntry("server", { ...admin, pairingCodes: false }))).toEqual([["Get the phone app", null]]);
    expect(shown(connectPhoneEntry("cloud", chatOnly))).toEqual([["Get the phone app", null]]);
  });

  it("never offers the iOS-only entry it replaced", () => {
    for (const entry of [connectPhoneEntry("computer", null), null]) {
      expect(items(entry).list.map((item) => item.label)).not.toContain("Get OpenMausBot for iOS");
    }
  });

  it("each opens its own thing", () => {
    const { list, onConnect, onGetApp } = items(connectPhoneEntry("computer", null));
    list[0]!.onSelect();
    expect(onConnect).toHaveBeenCalledOnce();
    expect(onGetApp).not.toHaveBeenCalled();
    list[1]!.onSelect();
    expect(onGetApp).toHaveBeenCalledOnce();
  });

  it("shows this computer's live phone, and only for this computer", () => {
    expect(items(connectPhoneEntry("computer", null), true).list[0]!.trailing).toBeTruthy();
    expect(items(connectPhoneEntry("computer", null), false).list[0]!.trailing).toBeUndefined();
    expect(items(connectPhoneEntry("cloud", admin), true).list[0]!.trailing).toBeUndefined();
  });
});

describe("Get the phone app", () => {
  it("offers iPhone and Android with the links the website and Cloud page use", () => {
    expect(PHONE_APPS.map((app) => [app.id, app.url])).toEqual([["ios", IOS_APP_STORE_URL], ["android", ANDROID_APK_URL]]);
    expect(IOS_APP_STORE_URL).toBe("https://apps.apple.com/in/app/mausbot/id6803387923");
    expect(ANDROID_APK_URL).toBe("https://github.com/milind-soni/OpenMausBot/releases/download/android-v1.5.0/OpenMausBot.apk");
  });

  const render = (onConnect?: () => void) => {
    vi.stubGlobal("window", { addEventListener: () => {}, removeEventListener: () => {} });
    try {
      return renderToStaticMarkup(createElement(PhoneAppDialog, { open: true, onClose: () => {}, onConnect }));
    } finally {
      vi.unstubAllGlobals();
    }
  };

  it("draws a code to scan for each, and points on to Connect your phone where this window can pair", () => {
    const html = render(() => {});
    expect(html).toContain('data-phone-app="ios"');
    expect(html).toContain('data-phone-app="android"');
    expect(html.match(/<svg/g)?.length).toBe(2);
    expect(html).toContain("Open in the App Store");
    expect(html).toContain("Download the APK");
    expect(html).toContain("Connect your phone");
    // nothing to pair with here: the dialog only says where the app is
    expect(render()).not.toContain("Connect your phone");
  });

  it("is not drawn while closed", () => {
    expect(renderToStaticMarkup(createElement(PhoneAppDialog, { open: false, onClose: () => {} }))).toBe("");
  });
});
