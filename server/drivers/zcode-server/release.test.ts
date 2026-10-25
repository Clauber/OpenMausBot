import { describe, expect, it } from "vitest";

import { resolveZcodeServerAsset } from "./release.ts";

describe("resolveZcodeServerAsset", () => {
  it("pins a release for each published platform", () => {
    for (const platform of ["linux", "darwin"] as const) {
      for (const arch of ["x64", "arm64"]) {
        const asset = resolveZcodeServerAsset(platform, arch);
        expect(asset?.url).toContain(`zcode-server-${platform}-${arch}.tar.gz`);
        expect(asset?.target).toBe(`${platform}-${arch}`);
        expect(asset?.sha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(asset?.archiveBytes).toBeGreaterThan(0);
      }
    }
  });

  it("matches the values published in the T3 reference", () => {
    expect(resolveZcodeServerAsset("linux", "arm64")).toEqual({
      version: "3.16.2",
      target: "linux-arm64",
      url: "https://cdn-zcode.z.ai/zcode/electron/releases/3.16.2/zcode-server-linux-arm64.tar.gz",
      sha256: "3e5e4233ad3c2a9eb0dc7d94a7b34a2bdfe8fce620ad3492380a32298525b175",
      archiveBytes: 90137724,
    });
  });

  it("has no asset for Windows or an unknown architecture", () => {
    expect(resolveZcodeServerAsset("win32", "x64")).toBeNull();
    expect(resolveZcodeServerAsset("linux", "riscv64")).toBeNull();
  });
});
