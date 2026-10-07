import { chromium } from "patchright";
import { FingerprintGenerator } from "fingerprint-generator";
import { FingerprintInjector } from "fingerprint-injector";
import type { RefMap } from "./types";

// Patchright's chromium has built-in stealth patches:
//   - Runtime.enable CDP leak fixed
//   - Console.enable CDP leak fixed
//   - sourceURL pptr: leak fixed
//   - Utility world name randomized
//   - Command flag defaults hardened
// No need for playwright-extra or puppeteer-extra-plugin-stealth.

// --- Fingerprint Suite (consistent per-agent fingerprints) ---
const fingerprintGenerator = new FingerprintGenerator({
  browsers: [{ name: "chrome", minVersion: 130 }],
  devices: ["desktop"],
  operatingSystems: ["windows", "macos"],
  locales: ["en-US", "en"],
});
const fingerprintInjector = new FingerprintInjector();

// Interactive ARIA roles that get refs
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "textbox",
  "combobox",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "tab",
  "treeitem",
  "searchbox",
  "slider",
  "spinbutton",
]);

// Browser launch args
// NOTE: --disable-gpu removed to allow WebGL fingerprinting to work.
// We spoof the WebGL vendor/renderer in evasions.ts instead of disabling GPU.
// SwiftShader-only fallback is fine on headless servers (Luna); on Mac we get real GPU.
const BROWSER_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-features=IsolateOrigins,site-per-process",
  "--disable-webrtc-hw-encoding",
  "--disable-webrtc-hw-decoding",
  "--enforce-webrtc-ip-permission-check",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  "--lang=en-US,en",
];

// Parse ariaSnapshot() YAML, assign refs to interactive elements
function buildRefSnapshot(ariaYaml: string): {
  snapshot: string;
  refs: RefMap;
} {
  const refs: RefMap = {};
  const seen = new Map<string, number>();
  let counter = 0;
  const lineRegex = /^(\s*-\s+)(\w+)(?:\s+"([^"]*)")?(.*)$/;

  const enhanced = ariaYaml
    .split("\n")
    .map((line) => {
      const m = line.match(lineRegex);
      if (!m) return line;
      const [, prefix, role, name, rest] = m;
      if (!INTERACTIVE_ROLES.has(role)) return line;
      counter++;
      const ref = `e${counter}`;
      const key = `${role}::${name ?? ""}`;
      const count = seen.get(key) ?? 0;
      seen.set(key, count + 1);
      refs[ref] = {
        role,
        ...(name && { name }),
        ...(count > 0 && { nth: count }),
      };
      if (count === 1) {
        const firstRef = Object.entries(refs).find(
          ([, info]) =>
            info.role === role &&
            info.name === (name ?? undefined) &&
            info.nth === undefined,
        );
        if (firstRef) firstRef[1].nth = 0;
      }
      return `${prefix}${role}${name ? ` "${name}"` : ""}${rest} [ref=${ref}]`;
    })
    .join("\n");

  return { snapshot: enhanced, refs };
}

export {
  chromium,
  fingerprintGenerator,
  fingerprintInjector,
  INTERACTIVE_ROLES,
  BROWSER_ARGS,
  buildRefSnapshot,
};
