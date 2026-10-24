import type { Bot } from "@/state/store";
import { useDesktopCapabilities } from "./DesktopCapabilities";
import { BotFolderBrowser } from "./BotFolderBrowser";

export function ComputerFilesPane({ bot }: { bot: Bot }) {
  const { capabilities } = useDesktopCapabilities();
  return <BotFolderBrowser bot={bot} home={capabilities.host.homeDir} />;
}
