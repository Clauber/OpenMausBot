// Real attachment lightbox over synthetic images, with the fake-engine server
// only so the preview inherits the app's Vite config. No user attachments are
// read. Run: node --experimental-strip-types scripts/verify-attachment-lightbox.ts
import { launchVerificationServer } from "./control-omb.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  ui = await mountPreview(fixture, {
    entry: "/scripts/testing/attachment-lightbox-preview.tsx",
    route: "/__attachment-lightbox.html",
    title: "Isolated attachment lightbox",
  });
  console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }, null, 2));
  await parkUntilSignal();
} finally {
  await ui?.close();
  await fixture.close();
}
