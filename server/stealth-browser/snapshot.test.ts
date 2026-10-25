import { describe, expect, it } from "vitest";

import { parseSnapshot } from "../decider/browser-click.ts";
import { toAgentSnapshot } from "./snapshot.ts";

// patchright 1.59 `page.ariaSnapshot({ mode: "ai" })` of a small contact form.
const ARIA = `- generic [active] [ref=e1]:
  - heading "Contact" [level=1] [ref=e2]
  - link "About us" [ref=e3] [cursor=pointer]:
    - /url: /about
  - generic [ref=e5]:
    - generic [ref=e6]:
      - text: Email
      - textbox "Email" [ref=e7]
    - generic [ref=e8]:
      - checkbox "Agree" [ref=e9]
      - text: Agree
    - generic [ref=e10]:
      - text: Size
      - combobox "Size" [ref=e11]:
        - option "Small" [selected]
        - option "Large"
    - button "Send message" [ref=e12]
  - paragraph [ref=e13]: idle
  - navigation "Site" [ref=e16]:
    - link "X" [ref=e17] [cursor=pointer]:
      - /url: /x
  - checkbox "On" [checked] [ref=e28]
  - 'button "Price: $5 # off" [ref=e30]'
  - paragraph [ref=e31]: "Text: with colon"
  - heading "Sub \\"quoted\\"" [level=2] [ref=e35]
  - iframe [ref=e36]:
    - button "Inner" [ref=f1e2]`;

describe("agent-browser snapshot format", () => {
  it("flattens to interactive elements, headings and named landmarks by default", () => {
    // The shape agent-browser 0.37.0 printed for the same page (refs differ).
    expect(toAgentSnapshot(ARIA, {})).toBe([
      "- heading \"Contact\" [level=1, ref=e2]",
      "- link \"About us\" [ref=e3]",
      "- textbox \"Email\" [ref=e7]",
      "- checkbox \"Agree\" [checked=false, ref=e9]",
      "- combobox \"Size\" [expanded=false, ref=e11]",
      "  - option \"Small\" [selected]",
      "  - option \"Large\"",
      "- button \"Send message\" [ref=e12]",
      "- navigation \"Site\" [ref=e16]",
      "  - link \"X\" [ref=e17]",
      "- checkbox \"On\" [checked=true, ref=e28]",
      "- button \"Price: $5 # off\" [ref=e30]",
      "- heading \"Sub \\\"quoted\\\"\" [level=2, ref=e35]",
      "- button \"Inner\" [ref=f1e2]",
    ].join("\n"));
  });

  it("parses in the decider exactly as agent-browser's own snapshot does", () => {
    const elements = parseSnapshot(toAgentSnapshot(ARIA, {}));
    expect(elements.map(({ ref, role, name, states }) => ({ ref, role, name, states }))).toEqual([
      { ref: "e3", role: "link", name: "About us", states: [] },
      { ref: "e7", role: "textbox", name: "Email", states: [] },
      { ref: "e9", role: "checkbox", name: "Agree", states: ["checked=false"] },
      { ref: "e11", role: "combobox", name: "Size", states: ["expanded=false"] },
      { ref: "e12", role: "button", name: "Send message", states: [] },
      { ref: "e17", role: "link", name: "X", states: [] },
      { ref: "e28", role: "checkbox", name: "On", states: ["checked=true"] },
      { ref: "e30", role: "button", name: "Price: $5 # off", states: [] },
    ]);
    expect(elements.find((element) => element.ref === "e17")?.context).toBe("Site");
    expect(elements.find((element) => element.ref === "e7")?.heading).toBe("Contact");
  });

  it("keeps the whole tree when interactive is off, and compact lifts unnamed wrappers", () => {
    const full = toAgentSnapshot(ARIA, { interactive: false });
    expect(full).toContain("- generic [ref=e1]\n  - heading \"Contact\" [level=1, ref=e2]");
    expect(full).toContain("    - generic [ref=e6]\n      - text: Email\n      - textbox \"Email\" [ref=e7]");
    expect(full).toContain("  - paragraph [ref=e13]: idle");
    expect(full).toContain("  - paragraph [ref=e31]: Text: with colon");
    expect(full).not.toContain("/url");

    const compact = toAgentSnapshot(ARIA, { interactive: false, compact: true });
    expect(compact).not.toContain("generic");
    expect(compact.split("\n").slice(0, 4)).toEqual([
      "- heading \"Contact\" [level=1, ref=e2]",
      "- link \"About us\" [ref=e3]",
      "- text: Email",
      "- textbox \"Email\" [ref=e7]",
    ]);
  });

  it("limits depth and adds absolute link URLs on request", () => {
    expect(toAgentSnapshot(ARIA, { depth: 0 })).not.toMatch(/^ /m);
    expect(toAgentSnapshot(ARIA, { depth: 0 })).toContain("- navigation \"Site\" [ref=e16]");
    expect(toAgentSnapshot(ARIA, { interactive: false, depth: 1 }).split("\n").every((line) => /^ {0,2}- /.test(line))).toBe(true);

    const withUrls = toAgentSnapshot(ARIA, { includeUrls: true, baseUrl: "https://shop.example.com/contact" });
    expect(withUrls).toContain("- link \"About us\" [ref=e3, url=https://shop.example.com/about]");
    expect(withUrls).toContain("  - link \"X\" [ref=e17, url=https://shop.example.com/x]");
  });

  it("returns nothing for an empty page", () => {
    expect(toAgentSnapshot("", {})).toBe("");
  });
});
