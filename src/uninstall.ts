import { readdir, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { isSandboxHome, type Ctx } from "./context.js";
import { uninstallServices } from "./launchd.js";
import type { Prompter } from "./prompt.js";
import { uninstallBlock } from "./rexconfig.js";
import { readSettings } from "./settings.js";
import { uninstallSkills } from "./skills.js";
import { portTarget, serveOffArgs, servesDesired, shellCommand } from "./tailscale.js";

export interface UninstallFlags {
  yes: boolean;
  purge: boolean;
  /** Also remove our Tailscale Serve mappings (asked interactively; with --yes only when this flag is set). */
  serveOff: boolean;
}

export async function uninstall(ctx: Ctx, flags: UninstallFlags, p: Prompter): Promise<number> {
  const { paths } = ctx;
  const ok = (s: string) => ctx.out(`✅ ${s}`);
  let failed = false;

  if (p.interactive && !(await p.confirm("Remove the rex-grokbot-bridge services, Rex palette actions and agent skill?", true))) {
    ctx.out("Nothing changed.");
    return 0;
  }
  const s = await readSettings(paths.configFile);
  const removed = await uninstallServices(paths, ctx.launchctl);
  ok(removed.length ? `Services stopped and removed: ${removed.join(", ")}` : "No services installed");

  const r = await uninstallBlock({ initPath: paths.rexInitLua, backupsDir: paths.backupsDir, rex: ctx.rex }).catch(
    (e: Error) => ({ status: "error" as const, detail: e.message }),
  );
  if (r.status === "error") {
    failed = true;
    ctx.err(`❌ ${r.detail}`);
  } else if (r.status === "removed") {
    ok(`Removed the rex-grokbot-bridge block from ${paths.rexInitLua}${"backup" in r && r.backup ? ` (backup: ${r.backup})` : ""}`);
    if (!isSandboxHome(ctx, userInfo().homedir)) await ctx.rex(["config", "reload"]);
  } else if (r.status === "check-failed") {
    failed = true;
    ctx.err(`❌ rex config check failed after removing our block; restored ${paths.rexInitLua}.\n${r.detail}`);
  } else ok(`No rex-grokbot-bridge block in ${paths.rexInitLua}`);

  const skills = await uninstallSkills(paths.skillRoots);
  ok(skills.length ? `Removed agent skill: ${skills.join(", ")}` : "No agent skill installed");

  // Our port mapping. Only our own mapping is ever offered for removal; a foreign or unreadable one is left alone.
  const desired = `http://127.0.0.1:${s.port}`;
  const mappings = ctx.tailscaleBin
    ? [
        { what: `port ${s.servePort}`, ours: servesDesired(await portTarget(ctx.tailscale, s.servePort), desired), args: serveOffArgs(s.servePort) },
      ].filter((m) => m.ours)
    : [];
  for (const m of mappings) {
    const cmd = shellCommand("tailscale", m.args);
    const off = flags.serveOff || (p.interactive && (await p.confirm(`Remove the Tailscale Serve mapping ${m.what}?`, false)));
    if (off) {
      const t = await ctx.tailscale(m.args);
      if (t.code === 0) ok(`Tailscale Serve ${m.what} removed`);
      else {
        failed = true;
        ctx.err(`❌ ${cmd} failed: ${(t.stderr || t.stdout).trim()}`);
      }
    } else ctx.out(`   Tailscale Serve ${m.what} left in place. Remove it with: ${cmd}`);
  }

  if (flags.purge) {
    await rm(paths.stateDir, { recursive: true, force: true });
    const kept = (await readdir(paths.backupsDir).catch(() => [])).length;
    ok(`Deleted ${paths.stateDir} (token, config, watched list).${kept ? ` init.lua backups kept in ${paths.backupsDir}` : ""}`);
  } else {
    ctx.out(`   Kept ${paths.stateDir} (token, config, watched list). Delete it with: rex-grokbot uninstall --purge`);
  }
  ctx.out("   To remove the package itself: npm uninstall -g rex-grokbot-bridge");
  return failed ? 1 : 0;
}
