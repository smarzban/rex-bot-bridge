#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const USAGE = `usage:
  rex-bot say "message"   send a message to the coordinator bot (via agent-notify)
  rex-bot whoami          print this pane's REX_SESSION and REX_BLOCK`;

const home = process.env.HOME || homedir();

function notifyUrl(): string | null {
  if (process.env.AGENT_NOTIFY_URL) return process.env.AGENT_NOTIFY_URL;
  try {
    const u = readFileSync(join(home, ".config/agent-notify/url"), "utf8").trim();
    return u || null;
  } catch {
    return null;
  }
}

async function say(text: string): Promise<number> {
  const notify = process.env.AGENT_NOTIFY_BIN || join(home, ".local/bin/agent-notify");
  const url = notifyUrl();
  if (!existsSync(notify)) {
    console.error(`rex-bot: ${notify} not found; message not sent`);
    return 0;
  }
  if (!url) {
    console.error("rex-bot: no webhook URL (set AGENT_NOTIFY_URL or ~/.config/agent-notify/url); message not sent");
    return 0;
  }
  const payload = JSON.stringify({
    event: "agent_message",
    text,
    rex_session: process.env.REX_SESSION ?? null,
    rex_block: process.env.REX_BLOCK ?? null,
    cwd: process.cwd(),
  });
  return new Promise((resolve) => {
    const child = spawn(notify, ["--source", "rex"], {
      stdio: ["pipe", "inherit", "inherit"],
      env: { ...process.env, AGENT_NOTIFY_URL: url },
    });
    child.on("error", (e) => {
      console.error(`rex-bot: agent-notify failed: ${e.message}`);
      resolve(0);
    });
    child.on("close", (code) => {
      if (code) console.error(`rex-bot: agent-notify exited ${code}`);
      resolve(0);
    });
    child.stdin.end(payload);
  });
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "whoami") {
    console.log(`REX_SESSION=${process.env.REX_SESSION ?? ""}`);
    console.log(`REX_BLOCK=${process.env.REX_BLOCK ?? ""}`);
    if (!process.env.REX_SESSION) {
      console.error("rex-bot: not running inside a Rex pane");
      return 1;
    }
    return 0;
  }
  if (cmd === "say") {
    const text = rest.join(" ").trim();
    if (!text) {
      console.error('usage: rex-bot say "message"');
      return 2;
    }
    return say(text);
  }
  console.error(USAGE);
  return cmd === "-h" || cmd === "--help" ? 0 : 2;
}

main(process.argv.slice(2)).then((code) => process.exit(code));
