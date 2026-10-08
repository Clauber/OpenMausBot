// The stealth launch surface: patchright's Chromium with the launch flags and
// the per-identity fingerprint suite the runtime builds contexts from.
//
// Patchright's Chromium carries built-in automation-leak fixes (Runtime.enable
// and Console.enable CDP leaks, sourceURL markers, utility-world naming, and
// hardened default flags), which replaces the puppeteer-extra-stealth pile of
// one-off patches. Fingerprint Suite generates one internally consistent
// navigator/screen/headers identity per browser session and injects it into
// the Playwright context; evasions.ts layers the pieces Chrome cannot be told
// at launch (WebGL, fonts, canvas/audio noise) on top of it.
//
// These libraries are esbuild externals shipped as real node_modules (they
// spawn browser processes and resolve their own package layout at runtime),
// so they load lazily: a server install without them starts normally, and
// only an enabled stealth browser reports them missing.
export const BROWSER_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--no-sandbox",
  "--disable-webrtc-hw-encoding",
  "--disable-webrtc-hw-decoding",
  "--enforce-webrtc-ip-permission-check",
  "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
];

type PatchrightModule = typeof import("patchright");
type FingerprintGeneratorModule = typeof import("fingerprint-generator");
type FingerprintInjectorModule = typeof import("fingerprint-injector");

let patchrightModule: PatchrightModule | undefined;
export async function loadPatchright(): Promise<PatchrightModule> {
  try {
    return patchrightModule ??= await import("patchright");
  } catch {
    throw new Error("the stealth browser runtime (patchright) is not installed on this server; reinstall OpenMausBot so its bundled dependencies come along, or turn off browserEngine.stealth");
  }
}

let generatorModule: FingerprintGeneratorModule | undefined;
let injectorModule: FingerprintInjectorModule | undefined;
let suite: {
  generator: InstanceType<FingerprintGeneratorModule["FingerprintGenerator"]>;
  injector: InstanceType<FingerprintInjectorModule["FingerprintInjector"]>;
} | undefined;
export async function loadFingerprintSuite(): Promise<NonNullable<typeof suite>> {
  if (suite) return suite;
  try {
    generatorModule ??= await import("fingerprint-generator");
    injectorModule ??= await import("fingerprint-injector");
  } catch {
    throw new Error("the stealth browser fingerprint suite is not installed on this server; reinstall OpenMausBot so its bundled dependencies come along, or turn off browserEngine.stealth");
  }
  suite = {
    generator: new generatorModule.FingerprintGenerator({
      browsers: [{ name: "chrome", minVersion: 130 }],
      devices: ["desktop"],
      operatingSystems: ["windows", "macos"],
      locales: ["en-US", "en"],
    }),
    injector: new injectorModule.FingerprintInjector(),
  };
  return suite;
}
