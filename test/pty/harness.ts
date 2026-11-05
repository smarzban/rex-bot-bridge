// Runs the real setup() or setupWebhook() with the real makePrompter on this process's terminal (a pty
// from drive.py), against fake rex/launchctl/tailscale and the temp HOME in the environment. Test-only.
// argv[2]: "setup" (default) or "webhook". The webhook run posts its test with the real fetch, so a
// local sink (http://127.0.0.1) works.
import { makePrompter } from "../../src/prompt.js";
import { setup } from "../../src/setup.js";
import { setupWebhook } from "../../src/webhook.js";
import { fakeCtx } from "../helpers.js";

const home = process.env.HOME;
if (!home || !home.includes("rex-bridge-test-")) throw new Error("harness needs a temp HOME from tempDir()");
const f = await fakeCtx({ stdout: "{}", stderr: "", code: 0 }, home);
f.ctx.out = (s) => process.stdout.write(s + "\n");
f.ctx.err = (s) => process.stderr.write(s + "\n");
f.ctx.fetch = fetch;
const code =
  process.argv[2] === "webhook"
    ? await setupWebhook(f.ctx, { test: true }, makePrompter(false), { timeoutMs: 2000 })
    : await setup(f.ctx, { yes: false, services: false, serve: false, skills: false, rexConfig: false }, makePrompter(false));
process.exit(code);
