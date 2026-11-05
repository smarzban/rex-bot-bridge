// Runs the real setup() with the real makePrompter on this process's terminal (a pty from drive.py),
// against fake rex/launchctl/tailscale and the temp HOME in the environment. Test-only.
import { makePrompter } from "../../src/prompt.js";
import { setup } from "../../src/setup.js";
import { fakeCtx } from "../helpers.js";

const home = process.env.HOME;
if (!home || !home.includes("rex-bridge-test-")) throw new Error("harness needs a temp HOME from tempDir()");
const f = await fakeCtx({ stdout: "{}", stderr: "", code: 0 }, home);
f.ctx.out = (s) => process.stdout.write(s + "\n");
f.ctx.err = (s) => process.stderr.write(s + "\n");
const code = await setup(
  f.ctx,
  { yes: false, services: false, serve: false, skills: false, rexConfig: false, showToken: false },
  makePrompter(false),
);
process.exit(code);
