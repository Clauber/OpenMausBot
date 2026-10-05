import { startFakeHttpMcp } from "./fake-http-mcp-server.ts";
import { providerSafeInputSchema } from "../mcp-tool-schema.ts";

/** Computer boundary for teaching fixtures; never drives a desktop or network. */
export async function startFakeTaughtComputer() {
  let failClick = false;
  let differentScreenshot = false;
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3uoAAAAASUVORK5CYII=";
  const properties: Record<string, Record<string, unknown>> = {
    navigate: { url: { type: "string" } }, click: { selector: { type: "string" } }, type: { text: { type: "string" } },
  };
  const fake = await startFakeHttpMcp({
    tools: Object.entries(properties).map(([name, props]) => ({ name, inputSchema: providerSafeInputSchema({ type: "object", properties: props, required: Object.keys(props) }) })),
    onCall: params => {
      const { name } = params as { name: string };
      if (name === "click" && failClick) return { isError: true, content: [{ type: "text", text: "element-not-found: #name" }] };
      return { content: [{ type: "text", text: `Executed ${name}` }, { type: "image", mimeType: "image/png", data: differentScreenshot ? Buffer.from("different fixture image").toString("base64") : png }] };
    },
  });
  return { ...fake, failClick: (value: boolean) => { failClick = value; }, differentScreenshot: (value: boolean) => { differentScreenshot = value; } };
}
