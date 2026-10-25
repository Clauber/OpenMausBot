import { createRoot } from "react-dom/client";
import { ChatView } from "../../src/components/ChatView";
import { ComputerPanel } from "../../src/components/ComputerPanel";
import { SkillsSection } from "../../src/components/SkillsSection";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { StoreProvider, useStore } from "../../src/state/store";
import { setAnalyticsEnabled } from "../../src/lib/analytics";
import { applySkin } from "../../src/lib/skins";
import "../../src/styles.css";

function Fixture() {
  const { state } = useStore();
  const bot = state.bots.find(candidate => candidate.id === new URLSearchParams(location.search).get("bot"));
  return <main className="flex h-screen bg-app text-ink">
    {bot && <><div className="min-w-0 flex-1"><ChatView bot={bot} /></div>
      <div className="w-[480px] overflow-y-auto p-3"><SkillsSection /></div>
      <ComputerPanel bot={bot} /></>}
  </main>;
}
setAnalyticsEnabled(false);
applySkin("midnight");
createRoot(document.getElementById("root")!).render(<DesktopCapabilitiesProvider><StoreProvider><Fixture /></StoreProvider></DesktopCapabilitiesProvider>);
