// T429 FR1-B/F: install.sh against stub uname/sw_vers/node/npm/curl/sudo on PATH and a temp prefix.
// The stubs log every call (one line per call) to $STUB_LOG; nothing real is downloaded or installed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tempDir } from "./helpers.js";

const ROOT = join(import.meta.dirname, "..");
const SCRIPT = join(ROOT, "install.sh");

const STUBS: Record<string, string> = {
  uname: `echo "uname $*" >> "$STUB_LOG"; echo "\${STUB_OS:-Darwin}"`,
  sw_vers: `echo 27.2`,
  sudo: `echo "sudo $*" >> "$STUB_LOG"; exit 1`,
  node: `case "$1" in
  -p) echo "\${STUB_NODE_MAJOR:-22}" ;;
  --version) echo "v\${STUB_NODE_MAJOR:-22}.0.0" ;;
esac`,
  curl: `echo "curl $*" >> "$STUB_LOG"
case "$*" in
  *api.github.com*)
    case "\${STUB_RELEASE:-ok}" in
      ok) printf '{\n  "url": "https://api.github.com/x",\n  "tag_name": "v9.8.7",\n  "name": "v9.8.7"\n}\n' ;;
      compact) printf '{"url":"https://api.github.com/x","tag_name":"v9.8.6","draft":false}' ;;
      notag) printf '{"message": "Not Found"}\n' ;;
      evil) printf '{"tag_name": "v1;rm -rf"}\n' ;;
      *) exit 22 ;;
    esac
    exit 0 ;;
esac
d=$(mktemp -d); mkdir -p "$d/rex-grokbot-bridge-src"; echo '{"name":"rex-grokbot-bridge"}' > "$d/rex-grokbot-bridge-src/package.json"
tar -czf - -C "$d" rex-grokbot-bridge-src`,
  npm: `echo "npm $*" >> "$STUB_LOG"
case "$1" in
  --version) echo 11.0.0 ;;
  prefix) echo "\${STUB_PREFIX_SHOWN:-$STUB_PREFIX}" ;;
  view) [ -n "\${STUB_PUBLISHED:-}" ] && echo "$STUB_PUBLISHED" || exit 1 ;;
  pack) shift; while [ "$1" != "--pack-destination" ]; do shift; done; : > "$2/rex-grokbot-bridge-0.3.0.tgz" ;;
  install)
    case " $* " in
      *" -g "*)
        mkdir -p "$STUB_PREFIX/bin"
        printf '#!/bin/sh\\necho 0.3.0\\n' > "$STUB_PREFIX/bin/rex-grokbot"; chmod +x "$STUB_PREFIX/bin/rex-grokbot" ;;
    esac ;;
esac`,
};

async function sandbox(opts: { npmInPrefix?: boolean } = {}) {
  const dir = await tempDir();
  const stubs = join(dir, "stubs");
  await mkdir(stubs);
  for (const [name, body] of Object.entries(STUBS)) {
    await writeFile(join(stubs, name), `#!/bin/sh\n${body}\n`);
    await chmod(join(stubs, name), 0o755);
  }
  const prefix = join(dir, "prefix");
  if (opts.npmInPrefix) {
    await mkdir(join(prefix, "bin"), { recursive: true });
    await writeFile(join(prefix, "bin/npm"), `#!/bin/sh\n${STUBS.npm}\n`);
    await chmod(join(prefix, "bin/npm"), 0o755);
  }
  const log = join(dir, "calls.log");
  const run = (env: Record<string, string> = {}, script = SCRIPT) => {
    const path = [opts.npmInPrefix ? join(prefix, "bin") : "", stubs, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].filter(Boolean).join(":");
    const r = spawnSync("/bin/sh", [script], {
      env: { PATH: path, HOME: dir, TMPDIR: dir, STUB_LOG: log, STUB_PREFIX: prefix, ...env },
      encoding: "utf8",
      input: "",
    });
    return { ...r, out: r.stdout + r.stderr };
  };
  const calls = async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n").filter(Boolean);
  return { dir, prefix, run, calls };
}

const globalInstall = (calls: string[]) => calls.filter((c) => /^npm install .*-g /.test(c));

test("FR1-B install.sh: no sudo anywhere in the script", async () => {
  const src = await readFile(SCRIPT, "utf8");
  const code = src.split("\n").filter((l) => !/^\s*#/.test(l));
  assert.ok(!code.some((l) => /(^|[;&|(`]|\$\()\s*sudo\b/.test(l)), "no sudo command");
});

test("FR1-B install.sh: a truncated download (no final `main` line) runs nothing", async () => {
  const sb = await sandbox();
  const src = await readFile(SCRIPT, "utf8");
  const lines = src.trimEnd().split("\n");
  assert.equal(lines.at(-1), 'main "$@"', "main is called on the last line");
  const cut = join(sb.dir, "truncated.sh");
  await writeFile(cut, lines.slice(0, -1).join("\n") + "\n");
  const r = sb.run({}, cut);
  assert.equal(r.status, 0, r.out);
  assert.equal(r.out, "");
  assert.deepEqual(await sb.calls(), []);
});

test("FR1-B install.sh: not macOS → clear exit, nothing installed", async () => {
  const sb = await sandbox();
  const r = sb.run({ STUB_OS: "Linux" });
  assert.equal(r.status, 1);
  assert.match(r.out, /rex-grokbot-bridge is for macOS/);
  assert.deepEqual(globalInstall(await sb.calls()), []);
});

test("FR1-B install.sh: Node too old → clear exit with the fix, nothing installed", async () => {
  const sb = await sandbox();
  const r = sb.run({ STUB_NODE_MAJOR: "20" });
  assert.equal(r.status, 1);
  assert.match(r.out, /Node v20\.0\.0 is too old; rex-grokbot-bridge needs Node 22 or newer/);
  assert.match(r.out, /brew upgrade node/);
  assert.deepEqual(globalInstall(await sb.calls()), []);
});

test("FR1-B install.sh: an unwritable prefix is refused with the fix, never sudo", async () => {
  const sb = await sandbox();
  await mkdir(join(sb.prefix, "lib/node_modules"), { recursive: true });
  await chmod(join(sb.prefix, "lib/node_modules"), 0o555);
  try {
    const r = sb.run();
    assert.equal(r.status, 1);
    assert.match(r.out, /is not writable by you, and this installer never uses sudo/);
    assert.match(r.out, /npm config set prefix "\$HOME\/\.npm-global"/);
    const calls = await sb.calls();
    assert.deepEqual(globalInstall(calls), []);
    assert.ok(!calls.some((c) => c.startsWith("sudo")));
  } finally {
    await chmod(join(sb.prefix, "lib/node_modules"), 0o755);
  }
});

test("FR1-B install.sh: REX_GROKBOT_SOURCE=npm + REX_GROKBOT_VERSION → npm i -g rex-grokbot-bridge@<version>; non-TTY prints Next", async () => {
  const sb = await sandbox();
  const r = sb.run({ REX_GROKBOT_SOURCE: "npm", REX_GROKBOT_VERSION: "0.3.0" });
  assert.equal(r.status, 0, r.out);
  const calls = await sb.calls();
  assert.ok(globalInstall(calls).some((c) => c.endsWith(" rex-grokbot-bridge@0.3.0")), calls.join("\n"));
  assert.ok(!calls.some((c) => c.startsWith("curl")));
  assert.match(r.out, /✅ Installed rex-grokbot 0\.3\.0/);
  assert.match(r.stdout, /\nNext: rex-grokbot setup\n$/);
  assert.ok(!r.out.includes("Run rex-grokbot setup now?"), "no question without a terminal");
});

test("FR1-B install.sh: REX_GROKBOT_SOURCE=github + ref → codeload URL for that ref, then npm i -g of the built tarball", async () => {
  const sb = await sandbox();
  const r = sb.run({ REX_GROKBOT_SOURCE: "github", REX_GROKBOT_VERSION: "feat/some-ref" });
  assert.equal(r.status, 0, r.out);
  const calls = await sb.calls();
  assert.ok(calls.includes("curl -fsSL https://codeload.github.com/smarzban/rex-grokbot-bridge/tar.gz/feat/some-ref"), calls.join("\n"));
  assert.ok(calls.some((c) => c.startsWith("npm install --include=dev")), "local build install");
  assert.ok(calls.some((c) => c.startsWith("npm pack --pack-destination")));
  assert.ok(globalInstall(calls).some((c) => /\/rex-grokbot-bridge-0\.3\.0\.tgz$/.test(c)), calls.join("\n"));
});

test("FR1-B install.sh: no source given → npm when a release is published (latest)", async () => {
  const pub = await sandbox();
  const r = pub.run({ STUB_PUBLISHED: "0.3.0" });
  assert.equal(r.status, 0, r.out);
  const calls = await pub.calls();
  assert.ok(globalInstall(calls).some((c) => c.endsWith(" rex-grokbot-bridge@latest")), calls.join("\n"));
  assert.ok(!calls.some((c) => c.startsWith("curl")), "npm path never calls GitHub");
  assert.match(r.out, /Installing rex-grokbot-bridge@latest from npm/);
  const bad = await sandbox();
  const b = bad.run({ REX_GROKBOT_SOURCE: "pypi" });
  assert.equal(b.status, 1);
  assert.match(b.out, /REX_GROKBOT_SOURCE must be npm or github/);
});

test("T457 install.sh: not on npm → the latest GitHub release tag, never main", async () => {
  const sb = await sandbox();
  const r = sb.run();
  assert.equal(r.status, 0, r.out);
  const calls = await sb.calls();
  assert.ok(calls.some((c) => c.startsWith("curl ") && c.endsWith("https://api.github.com/repos/smarzban/rex-grokbot-bridge/releases/latest")), calls.join("\n"));
  assert.ok(calls.includes("curl -fsSL https://codeload.github.com/smarzban/rex-grokbot-bridge/tar.gz/v9.8.7"), calls.join("\n"));
  assert.ok(!calls.some((c) => c.includes("tar.gz/main")));
  assert.match(r.out, /Installing smarzban\/rex-grokbot-bridge v9\.8\.7 \(GitHub release\)/);
  assert.ok(globalInstall(calls).some((c) => /\/rex-grokbot-bridge-0\.3\.0\.tgz$/.test(c)));
  assert.ok(!r.out.includes("unreleased"));
});

test("T457 install.sh: compact API JSON parses too", async () => {
  const sb = await sandbox();
  const r = sb.run({ REX_GROKBOT_SOURCE: "github", STUB_RELEASE: "compact" });
  assert.equal(r.status, 0, r.out);
  assert.ok((await sb.calls()).includes("curl -fsSL https://codeload.github.com/smarzban/rex-grokbot-bridge/tar.gz/v9.8.6"));
});

test("T457 install.sh: an npm placeholder or prerelease as latest doesn't count as published → GitHub release", async () => {
  for (const v of ["0.0.0-stage", "1.0.0-rc.1"]) {
    const sb = await sandbox();
    const r = sb.run({ STUB_PUBLISHED: v });
    assert.equal(r.status, 0, r.out);
    const calls = await sb.calls();
    assert.ok(calls.includes("curl -fsSL https://codeload.github.com/smarzban/rex-grokbot-bridge/tar.gz/v9.8.7"), `${v}\n${calls.join("\n")}`);
    assert.ok(!globalInstall(calls).some((c) => c.includes("rex-grokbot-bridge@")));
  }
});

test("T457 install.sh: API failure / no release / a bad tag → clear error, nothing downloaded or installed", async () => {
  for (const [mode, why] of [
    ["fail", /could not read https:\/\/api\.github\.com\/repos\/smarzban\/rex-grokbot-bridge\/releases\/latest/],
    ["notag", /no usable release tag/],
    ["evil", /no usable release tag/],
  ] as const) {
    const sb = await sandbox();
    const r = sb.run({ REX_GROKBOT_SOURCE: "github", STUB_RELEASE: mode });
    assert.equal(r.status, 1, `${mode}: ${r.out}`);
    assert.match(r.out, /Could not find the latest release of smarzban\/rex-grokbot-bridge on GitHub/);
    assert.match(r.out, why);
    assert.match(r.out, /Nothing was installed\./);
    assert.match(r.out, /REX_GROKBOT_VERSION=vX\.Y\.Z sh/);
    const calls = await sb.calls();
    assert.ok(!calls.some((c) => c.includes("codeload")), `${mode}: no download`);
    assert.deepEqual(globalInstall(calls), []);
    assert.ok(!calls.some((c) => c.startsWith("npm install") || c.startsWith("npm pack")));
  }
});

test("T457 install.sh: an explicit REX_GROKBOT_VERSION wins, with no API call", async () => {
  const tag = await sandbox();
  const t = tag.run({ REX_GROKBOT_VERSION: "v0.7.2" });
  assert.equal(t.status, 0, t.out);
  const calls = await tag.calls();
  assert.ok(!calls.some((c) => c.includes("api.github.com")), calls.join("\n"));
  assert.ok(calls.includes("curl -fsSL https://codeload.github.com/smarzban/rex-grokbot-bridge/tar.gz/v0.7.2"));
  assert.ok(!t.out.includes("unreleased"));

  const main = await sandbox();
  const m = main.run({ REX_GROKBOT_SOURCE: "github", REX_GROKBOT_VERSION: "main" });
  assert.equal(m.status, 0, m.out);
  const mcalls = await main.calls();
  assert.ok(!mcalls.some((c) => c.includes("api.github.com")));
  assert.ok(mcalls.includes("curl -fsSL https://codeload.github.com/smarzban/rex-grokbot-bridge/tar.gz/main"));
  assert.match(m.out, /REX_GROKBOT_VERSION=main is not a release tag: installing unreleased code \(unsupported\)/);
});

const UUID = "0f8e2c1a-1b2c-4d3e-8f90-123456789abc";

test("FR1-F install.sh: npm's redacted prefix (***) resolves from NPM_CONFIG_PREFIX", async () => {
  const sb = await sandbox();
  const real = join(sb.dir, UUID, "pfx");
  const r = sb.run({ STUB_PREFIX: real, STUB_PREFIX_SHOWN: join(sb.dir, "***", "pfx"), NPM_CONFIG_PREFIX: real, REX_GROKBOT_SOURCE: "npm" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, new RegExp(`✅ Installed rex-grokbot 0\\.3\\.0 \\(${real.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/bin/rex-grokbot\\)`));
  assert.ok(!r.out.includes("doesn't run"));
});

test("FR1-F install.sh: redacted prefix resolves from where npm lives when no env is set", async () => {
  const sb = await sandbox({ npmInPrefix: true });
  // The stub npm lives in <prefix>/bin, and the prefix path has a UUID segment npm hides.
  const shown = sb.prefix.replace(/prefix$/, "***");
  const r = sb.run({ STUB_PREFIX_SHOWN: shown, REX_GROKBOT_SOURCE: "npm" });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /✅ Installed rex-grokbot 0\.3\.0/);
});

test("FR1-F install.sh: an unresolvable redacted prefix says so and installs nothing", async () => {
  const sb = await sandbox();
  const r = sb.run({ STUB_PREFIX_SHOWN: `/nowhere/***/pfx`, REX_GROKBOT_SOURCE: "npm" });
  assert.equal(r.status, 1);
  assert.match(r.out, /npm hid part of its global folder path \(it printed \/nowhere\/\*\*\*\/pfx\)/);
  assert.match(r.out, /Nothing was installed\. Set NPM_CONFIG_PREFIX/);
  assert.deepEqual(globalInstall(await sb.calls()), []);
});

