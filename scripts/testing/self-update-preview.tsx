import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { SettingsModal } from "../../src/components/SettingsModal";
import { DesktopCapabilitiesProvider } from "../../src/components/DesktopCapabilities";
import { StoreProvider, useStore } from "../../src/state/store";
import { applySkin } from "../../src/lib/skins";
import "../../src/styles.css";

function Preview() {
  const { dispatch } = useStore();
  useEffect(() => { dispatch({ type: "toggleAppSettings", open: true, section: "general" }); }, [dispatch]);
  return <><main className="p-8 text-ink-secondary">Isolated software update fixture</main><SettingsModal /></>;
}
applySkin("midnight");
const root = createRoot(document.getElementById("root")!);
root.render(<StoreProvider><DesktopCapabilitiesProvider><Preview /></DesktopCapabilitiesProvider></StoreProvider>);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
