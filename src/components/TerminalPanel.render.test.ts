import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

// SSR never runs effects, so the probe and the socket never start here; the
// xterm classes only need to exist at import time.
vi.mock("@xterm/xterm", () => ({ Terminal: class {} }));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class {} }));
vi.mock("@/state/store", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/state/store")>();
  return { ...original, useStore: () => ({ state: original.initialState, dispatch: vi.fn() }) };
});

import { TerminalPanel } from "./TerminalPanel";

describe("TerminalPanel", () => {
  it("renders the dock with its title and close control", () => {
    const html = renderToStaticMarkup(createElement(TerminalPanel));
    expect(html).toContain("Terminal");
    expect(html).toContain("aria-label=\"Close terminal\"");
    expect(html).toContain("border-t");
  });
});
