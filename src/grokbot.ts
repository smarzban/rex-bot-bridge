import { bridgeUrl } from "./tailscale.js";

/** The Grok Bot setup guide (connector + routine instructions), for people. */
export const DOC_URL = "https://github.com/smarzban/rex-bot-bridge/blob/main/docs/grok-bot.md";
/** The same guide as plain Markdown, for giving to the Grok Bot agent itself. */
export const DOC_RAW_URL = "https://raw.githubusercontent.com/smarzban/rex-bot-bridge/main/docs/grok-bot.md";

export interface ConnectorTextOptions {
  dnsName?: string;
  servePath: string;
  /** The bearer token, or null to print a placeholder. */
  token: string | null;
}

/** The message to paste into a Grok Bot chat so it adds the "rex" connector. Nothing else. */
export function connectorText(o: ConnectorTextOptions): string {
  const url = `${bridgeUrl(o.dnsName, o.servePath)}/mcp`;
  const hint = o.token
    ? "# Contains your bearer token: paste it only into Grok Bot."
    : "# The token is hidden. Print it filled in with: rex-bot grokbot --show-token";
  return `${hint}
# Paste this into a Grok Bot chat:

Please add a custom MCP connector named "rex":
- URL: ${url}
- Transport: Streamable HTTP
- Header: Authorization: Bearer ${o.token ?? "<TOKEN>"}
Use the static header, not OAuth. Then call its bridge_status tool to check it works.

# Full Grok Bot guide (Tailscale plugin, connector, routine): ${DOC_URL}`;
}
