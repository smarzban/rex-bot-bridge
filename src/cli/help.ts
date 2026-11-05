// `rex-grokbot --help`, `rex-grokbot help <command>` and `rex-grokbot <command> --help`. One table, one renderer.
import { DOC_URL } from "../grokbot.js";
import { KEYS } from "../settings.js";

type Rows = [string, string][];

export interface CommandHelp {
  /** usage lines, without the leading "usage: " */
  usage: string[];
  /** One line for the top-level list. */
  summary: string;
  description: string;
  /** Named sections in order, e.g. Arguments, Parts, Options, Output. */
  sections: [string, Rows][];
  examples: string[];
  exit: string;
}

const EXIT_STD = "0 done · 1 failed (see the ❌ line and its fix) · 2 usage, nothing changed";

export const HELP: Record<string, CommandHelp> = {
  setup: {
    usage: [
      "rex-grokbot setup [--yes] [--mode watched|full] [--no-rex-config] [--no-services]",
      "    [--no-serve] [--no-skills]",
      "rex-grokbot setup rex | services | serve | skill [--yes]",
      "rex-grokbot setup webhook [--url URL] [--key-file FILE|-] [--header NAME] [--yes] [--no-test]",
    ],
    summary: "install or repair everything (or one part); setup webhook adds the routine's webhook",
    description:
      "Install or repair rex-grokbot-bridge on this Mac. Bare setup runs Checks, Settings (token, mode), then\n" +
      "every part below, and ends with what to do next. Safe to re-run: it keeps your token, mode and\n" +
      "webhook. Each part also runs on its own. The webhook is separate: you get it from the Grok Bot\n" +
      "routine, which you create after setup (see Next).",
    sections: [
      [
        "Parts",
        [
          ["rex", "add the palette actions to Rex's init.lua (backed up, checked, rolled back on failure)"],
          ["services", "install and (re)start the launchd services com.rexgrokbotbridge.bridge and .watch"],
          ["serve", "give the bridge its own origin, https://<mac>.<tailnet>.ts.net:8443 (tailscale serve, asks)"],
          ["skill", "install the rex-grokbot agent skill into ~/.claude/skills and ~/.agents/skills"],
          ["webhook", "ask for the routine's webhook URL, key and header, save, send a test (see help setup webhook)"],
        ],
      ],
      [
        "Options",
        [
          ["--yes, -y", "don't ask: use defaults (never replaces another Tailscale Serve mapping)"],
          ["--mode MODE", "watched (default: the bot drives only sessions you opt in) or full"],
          ["--no-rex-config", "skip the Rex palette part"],
          ["--no-services", "skip the launchd services (run rex-grokbot serve / rex-grokbot watch yourself)"],
          ["--no-serve", "skip Tailscale Serve"],
          ["--no-skills", "skip the agent skill"],
        ],
      ],
      [
        "Output",
        [
          ["sections", "1. Checks, 2. Settings, 3. Rex palette, 4. Services, 5. Tailscale Serve, 6. Agent skill"],
          ["lines", "✅ done · ⚠️ needs you (with a fix: line) · ❌ failed (with a fix: line)"],
          ["Next", "the Grok Bot guide, rex-grokbot setup webhook, rex-grokbot doctor --test-webhook"],
        ],
      ],
    ],
    examples: ["rex-grokbot setup", "rex-grokbot setup --yes --mode watched", "rex-grokbot setup services", "rex-grokbot setup webhook"],
    exit: "0 done · 1 a part failed (see its ❌ line) or a check failed · 2 usage, nothing changed",
  },
  "setup webhook": {
    usage: ["rex-grokbot setup webhook [--url URL] [--key-file FILE|-] [--header NAME] [--yes] [--no-test]"],
    summary: "save the Grok Bot routine's webhook (URL, key, header) and send a test",
    description:
      "Save where the watcher and `rex-grokbot say` POST to: your Grok Bot routine's webhook. Asks for the\n" +
      "URL, the key (hidden) and the header name, saves them to config.json, then offers a test post.\n" +
      "Re-run to change them: Enter keeps a saved value (shown only as \"set\"). The URL and key are\n" +
      "never printed. The key prompt accepts a pasted header line (\"X-Webhook-Key: abc\",\n" +
      "\"Authorization: Bearer abc\") and drops a leading \"Bearer \".",
    sections: [
      [
        "Options",
        [
          ["--url URL", "the routine's webhook URL (https://)"],
          ["--key-file FILE", "read the key from FILE; - reads stdin (keeps it out of shell history)"],
          ["--header NAME", "header for the key; default Authorization, sent as Authorization: Bearer <key>"],
          ["--yes, -y", "don't ask: use the flags and saved values, then send the test"],
          ["--no-test", "save without sending a test"],
        ],
      ],
      [
        "Output",
        [
          ["saved", "✅ Webhook saved …: URL (set), key sent as <header>: <key>"],
          ["test", "✅ Test sent: HTTP 200, or ❌ Test failed: HTTP 401 / HTTP 404 / timeout with a fix line"],
        ],
      ],
    ],
    examples: [
      "rex-grokbot setup webhook",
      "rex-grokbot setup webhook --url https://example.com/hooks/abc --key-file - --yes < key.txt",
      "rex-grokbot setup webhook --header X-Webhook-Key",
    ],
    exit: "0 saved (test passed or skipped) · 1 test failed or no valid answer · 2 usage, nothing saved",
  },
  doctor: {
    usage: ["rex-grokbot doctor [--json] [--test-webhook]"],
    summary: "check the whole chain; every problem comes with a fix line",
    description:
      "Check Node, Rex, the token and file modes, the init.lua block, both launchd services, the bridge\n" +
      "on 127.0.0.1 and over the tailnet, the watcher heartbeat, Tailscale Serve, the webhook and the\n" +
      "agent skill. Parts you skipped in setup show as ⚠️, not ❌.",
    sections: [
      [
        "Options",
        [
          ["--test-webhook", "also POST a doctor_test event to the webhook"],
          ["--json", "print {ok, checks: [{id, level, detail, fix}]} instead of lines"],
        ],
      ],
    ],
    examples: ["rex-grokbot doctor", "rex-grokbot doctor --test-webhook", "rex-grokbot doctor --json"],
    exit: "0 no ❌ (⚠️ allowed) · 1 at least one ❌ · 2 usage",
  },
  uninstall: {
    usage: ["rex-grokbot uninstall [--yes] [--purge] [--serve-off]"],
    summary: "remove the services, palette actions and skill",
    description:
      "Stop and remove the launchd services, the init.lua block and the agent skill. Keeps\n" +
      "~/.config/rex-grokbot-bridge (token, config, watched list) unless --purge. Asks before removing the\n" +
      "Tailscale Serve mapping on our port, and only ever removes our own.",
    sections: [
      [
        "Options",
        [
          ["--yes, -y", "don't ask (the Serve mappings stay unless --serve-off)"],
          ["--purge", "also delete ~/.config/rex-grokbot-bridge"],
          ["--serve-off", "also remove our Tailscale Serve mappings"],
        ],
      ],
    ],
    examples: ["rex-grokbot uninstall", "rex-grokbot uninstall --yes --purge --serve-off"],
    exit: EXIT_STD,
  },
  config: {
    usage: ["rex-grokbot config get <key> [--show]", "rex-grokbot config set <key> <value>"],
    summary: "read or change one setting in config.json",
    description: "Read or change one setting in ~/.config/rex-grokbot-bridge/config.json. Mode changes apply on the\nbot's next call; port and host need the services restarted (rex-grokbot setup services);\nservePort (the tailnet HTTPS port, default 8443, not 443) needs rex-grokbot setup serve.",
    sections: [
      [
        "Arguments",
        [
          ["<key>", KEYS.join(", ")],
          ["<value>", '- reads it from stdin; "" clears a webhook field'],
        ],
      ],
      ["Options", [["--show", "with get: print webhook.url / webhook.key instead of (set)"]]],
    ],
    examples: ["rex-grokbot config get mode", "rex-grokbot config set mode full", "rex-grokbot config set webhook.key - < key.txt"],
    exit: "0 done · 1 invalid value · 2 usage",
  },
  url: {
    usage: ["rex-grokbot url"],
    summary: "print the Grok Bot connector URL (https://<mac>.<tailnet>.ts.net:8443/mcp)",
    description:
      "Print this Mac's connector URL and nothing else, for the rex connector in Grok Bot. It is not a\n" +
      "secret; the token is (see rex-grokbot token). Warns on stderr if Tailscale Serve doesn't map it yet.",
    sections: [["Output", [["stdout", "https://<mac>.<tailnet>.ts.net:8443/mcp (port: servePort)"]]]],
    examples: ["rex-grokbot url"],
    exit: "0 printed · 1 Tailscale isn't running (fix line on stderr) · 2 usage",
  },
  token: {
    usage: ["rex-grokbot token [--rotate]"],
    summary: "print the bearer token for the connector's Authorization header (--rotate: new one)",
    description:
      "Print the bearer token the Grok Bot connector sends, and nothing else (one line, so it pipes:\n" +
      "rex-grokbot token | pbcopy keeps it off the screen). It is a credential that drives your\n" +
      "terminals: put it only in the connector's Authorization header. --rotate replaces it, restarts\n" +
      "the bridge service if it is loaded, and prints the new one; then update the connector.",
    sections: [
      ["Options", [["--rotate", "replace the token (the old one stops working), restart the bridge, print the new one"]]],
      ["Output", [["stdout", "the token, one line"], ["stderr", "after --rotate: what was restarted and the reminder to update Grok Bot"]]],
    ],
    examples: ["rex-grokbot token | pbcopy", "rex-grokbot token --rotate | pbcopy"],
    exit: "0 printed · 1 no token yet (run rex-grokbot setup) · 2 usage",
  },
  watch: {
    usage: ["rex-grokbot watch add <session>", "rex-grokbot watch remove <session>", "rex-grokbot watch list", "rex-grokbot watch"],
    summary: "opt a Rex session in or out of the bot (watched mode); bare: run the watcher",
    description:
      "In watched mode the bot can read and drive only sessions on this list. You can also toggle a\n" +
      "session from Rex's palette: Bot: Watch / Unwatch This Session. Bare `rex-grokbot watch` runs the\n" +
      "status watcher (the com.rexgrokbotbridge.watch service runs it for you).",
    sections: [
      [
        "Arguments",
        [["<session>", "a full session id, session:<uuid> (see rex ls --json or rex-grokbot whoami)"]],
      ],
    ],
    examples: ["rex-grokbot watch add \"$REX_SESSION\"", "rex-grokbot watch list"],
    exit: "0 done (also when already on / off the list) · 2 usage",
  },
  say: {
    usage: ['rex-grokbot say "message"'],
    summary: "from an agent: send a message to the coordinator bot",
    description:
      "POST an agent_message event (text, REX_SESSION, REX_BLOCK, cwd) to the webhook. Everything after\n" +
      "`say` is the message. Never fails the caller: exits 0 even when it isn't delivered.",
    sections: [["Output", [["stderr", "rex-grokbot: sent, or why it wasn't"]]]],
    examples: ['rex-grokbot say "Tests pass; PR is up for review"'],
    exit: "0 sent or not (see stderr) · 2 no message",
  },
  whoami: {
    usage: ["rex-grokbot whoami"],
    summary: "print this pane's REX_SESSION and REX_BLOCK",
    description: "Print the Rex session and pane ids of the terminal this runs in.",
    sections: [["Output", [["stdout", "REX_SESSION=session:… and REX_BLOCK=block:…"]]]],
    examples: ["rex-grokbot whoami"],
    exit: "0 inside a Rex pane · 1 not inside a Rex pane",
  },
  serve: {
    usage: ["rex-grokbot serve"],
    summary: "run the MCP bridge (127.0.0.1:7400 by default)",
    description:
      "Run the MCP server the bot connects to, on host:port from config.json. The\n" +
      "com.rexgrokbotbridge.bridge service runs it for you; run it by hand after setup --no-services.",
    sections: [],
    examples: ["rex-grokbot serve"],
    exit: "runs until stopped · 1 no token (run rex-grokbot setup)",
  },
  notify: {
    usage: ["rex-grokbot notify < event.json"],
    summary: "internal: POST the JSON on stdin to the webhook",
    description: "Used by the watcher. POSTs the JSON object on stdin (or plain text as a message) to the webhook.",
    sections: [],
    examples: ["rex-grokbot notify < event.json"],
    exit: "0 HTTP 2xx · 1 not delivered",
  },
};

const GROUPS: [string, [string, string][]][] = [
  [
    "Setup",
    [
      ["setup", "install or repair everything (setup rex|services|serve|skill: one part)"],
      ["setup webhook", HELP["setup webhook"]!.summary],
      ["uninstall", HELP.uninstall!.summary],
    ],
  ],
  [
    "Grok Bot connector",
    [
      ["url", HELP.url!.summary],
      ["token", HELP.token!.summary],
    ],
  ],
  ["Check", [["doctor", HELP.doctor!.summary]]],
  ["Settings", [["config", HELP.config!.summary]]],
  ["Watch list", [["watch", "add|remove <session>, list: which sessions the bot may drive"]]],
  [
    "For agents",
    [
      ["say", HELP.say!.summary],
      ["whoami", HELP.whoami!.summary],
    ],
  ],
  [
    "Services",
    [
      ["serve", HELP.serve!.summary],
      ["watch", "run the status watcher (no arguments)"],
      ["notify", HELP.notify!.summary],
    ],
  ],
];

function rows(r: Rows, indent = "  "): string {
  const w = Math.max(...r.map(([k]) => k.length));
  return r.map(([k, v]) => `${indent}${k.padEnd(w)}  ${v.replace(/\n/g, "\n" + indent + " ".repeat(w + 2))}`).join("\n");
}

export const TOP_HELP = `usage: rex-grokbot <command> [args] | help [<command>] | --help | --version

Let a coordinator bot (Grok Bot over Tailscale) see and drive the coding agents in your Rex terminals.

${GROUPS.map(([g, r]) => `${g}\n${rows(r)}`).join("\n\n")}

Run \`rex-grokbot help <command>\` or \`rex-grokbot <command> --help\` for one command.
Grok Bot guide: ${DOC_URL}`;

export function commandHelp(name: string): string | undefined {
  const h = HELP[name];
  if (!h) return undefined;
  // A usage line that starts with spaces continues the one before it.
  const usage = h.usage.map((u, i) => (i ? "       " : "usage: ") + u).join("\n");
  const sections = h.sections.filter(([, r]) => r.length).map(([t, r]) => `${t}\n${rows(r)}`);
  return [
    usage,
    h.description,
    ...sections,
    `Examples:\n${h.examples.map((e) => "  " + e).join("\n")}`,
    `Exit:\n  ${h.exit}`,
  ].join("\n\n");
}

/** The README's command table, generated from the same help text (test/help.test.ts keeps them in sync). */
export function readmeCommands(): string {
  const lines = ["| Command | Does |", "|---|---|"];
  for (const [name, h] of Object.entries(HELP)) {
    const joined = h.usage.reduce<string[]>((acc, u) => (u.startsWith(" ") ? [...acc.slice(0, -1), `${acc.at(-1)} ${u.trim()}`] : [...acc, u]), []);
    const usage = joined.map((u) => `\`${u.replace(/\s+/g, " ").replace(/\|/g, "\\|")}\``).join("<br>");
    lines.push(`| ${usage} | ${h.summary.replace(/\|/g, "\\|")} (\`rex-grokbot help ${name}\`) |`);
  }
  return lines.join("\n");
}
