import { useStore } from "@/state/store";
import { t } from "@/lib/i18n";
import { useCloudOwner } from "./CloudOwner";
import { DesktopWorkspaceSwitcher } from "./DesktopWorkspaceSwitcher";
import { ConnectedWorkspacesSettings } from "./ConnectedWorkspacesSettings";
import { Card } from "./SettingsPrimitives";

export function ServersSettings() {
  const { state } = useStore();
  const cloudHome = state.config?.cloudHome === true;
  const owner = useCloudOwner(cloudHome);
  return <>
    {(window.ogb?.workspaces || cloudHome) && <Card title={t("settings.servers.current")}>
      <DesktopWorkspaceSwitcher cloudHome={cloudHome} owner={owner} />
    </Card>}
    <ConnectedWorkspacesSettings />
  </>;
}
