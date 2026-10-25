import { describe, expect, it } from "vitest";

import { buildEvasionScript } from "./evasions.ts";

describe("evasion script", () => {
  it("parses and claims a Windows desktop identity", () => {
    const script = buildEvasionScript(null, "bot");
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('"platform","Win32"');
    expect(script).toContain("Direct3D11");
  });
});
