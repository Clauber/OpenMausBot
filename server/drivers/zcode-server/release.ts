// Pinned from ZCode's own source-server-release.json (same table as the T3 Code reference).
export interface ZcodeServerAsset {
  version: string;
  target: string;
  url: string;
  sha256: string;
  archiveBytes: number;
}

const RELEASES = new Map<string, ZcodeServerAsset>([
  [
    "linux-x64",
    {
      version: "3.16.2",
      target: "linux-x64",
      url: "https://cdn-zcode.z.ai/zcode/electron/releases/3.16.2/zcode-server-linux-x64.tar.gz",
      sha256: "947eb91d3dd7d8a539d9df8d0e46c52a796e076c46b14feb004558337ab3bf3d",
      archiveBytes: 91189880,
    },
  ],
  [
    "linux-arm64",
    {
      version: "3.16.2",
      target: "linux-arm64",
      url: "https://cdn-zcode.z.ai/zcode/electron/releases/3.16.2/zcode-server-linux-arm64.tar.gz",
      sha256: "3e5e4233ad3c2a9eb0dc7d94a7b34a2bdfe8fce620ad3492380a32298525b175",
      archiveBytes: 90137724,
    },
  ],
  [
    "darwin-x64",
    {
      version: "3.16.2",
      target: "darwin-x64",
      url: "https://cdn-zcode.z.ai/zcode/electron/releases/3.16.2/zcode-server-darwin-x64.tar.gz",
      sha256: "5303ee584edc16732c95588319048015533dd896bdf4dd15e8112e9af9259593",
      archiveBytes: 82012112,
    },
  ],
  [
    "darwin-arm64",
    {
      version: "3.16.2",
      target: "darwin-arm64",
      url: "https://cdn-zcode.z.ai/zcode/electron/releases/3.16.2/zcode-server-darwin-arm64.tar.gz",
      sha256: "ea85d8880103f10c99580cd1faa5064211f8a86e542dd8ee36a6dc84250c26e7",
      archiveBytes: 79935726,
    },
  ],
]);

/** Null where ZCode publishes no server bundle (Windows, other architectures). */
export function resolveZcodeServerAsset(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): ZcodeServerAsset | null {
  return RELEASES.get(`${platform}-${arch}`) ?? null;
}
