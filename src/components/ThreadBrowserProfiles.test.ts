import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ThreadBrowserProfiles } from "./ThreadBrowserProfiles";
import type { ThreadBrowserProfile } from "../../shared/thread-browser-profile";

const profile: ThreadBrowserProfile = {
  active: { profileId: "work" }, activeProfileId: "work", viewerProfileId: "work",
  requestedProfileId: "other", status: "pending",
  profiles: [{ id: null, name: "Own browser" }, { id: "work", name: "Work" }, { id: "other", name: "Other" }],
};

describe("conversation browser profiles", () => {
  it("shows the requested choice separately from the current turn and allows selection while the bot runs", () => {
    const select = vi.fn();
    const html = renderToStaticMarkup(createElement(ThreadBrowserProfiles, { profile, select, saving: false, canSelect: true, error: "", botId: "fixture", threadId: "thread-fixture" }));
    expect(html).toContain('value="other" selected=""');
    expect(html).toContain("Current turn: Work.");
    expect(html).toContain("Requested: Other. Start the next turn to use it.");
    expect(html).not.toContain('disabled=""');
    expect(select).not.toHaveBeenCalled();
  });

  it("keeps idle viewing distinct from an active mount and preserves the owner gate", () => {
    const html = renderToStaticMarkup(createElement(ThreadBrowserProfiles, {
      profile: { ...profile, active: null, activeProfileId: null, status: "reconnect" },
      select: vi.fn(), saving: false, canSelect: false, error: "", botId: "fixture", threadId: "thread-fixture",
    }));
    expect(html).toContain("Viewing: Work. No browser is mounted for an active turn.");
    expect(html).toContain("Only an owner or admin");
    expect(html).toContain('disabled=""');
    expect(html).not.toContain("Current turn:");
  });
});
