import { rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { isSandboxHome, type Ctx } from "./context.js";
import { uninstallServices } from "./launchd.js";
import type { Prompter } from "./prompt.js";
import { uninstallBlock } from "./rexconfig.js";
import { readSettings } from "./settings.js";
import { uninstallSkills } from "./skills.js";
import { serveOffArgs, servesDesired, serveTarget, shellCommand } from "./tailscale.js";

export interface UninstallFlags {
  yes: boolean;
  purge: boolean;
  /** Also remove the Tailscale Serve mapping (asked interactively; with --yes only when this flag is set). */
  serveOff: boolean;
}

export async function uninstall(ctx: Ctx, flags: UninstallFlags, p: Prompter): Promise<number> {
  const { paths } = ctx;
  const ok = (s: string) => ctx.out(`✅ ${s}`);
  let failed = false;

  if (p.interactive && !(await p.confirm("Remove the rex-bot-bridge services, Rex palette actions and agent skill?", true))) {
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
    ok(`Removed the rex-bot-bridge block from ${paths.rexInitLua}${"backup" in r && r.backup ? ` (backup: ${r.backup})` : ""}`);
    if (!isSandboxHome(ctx, userInfo().homedir)) await ctx.rex(["config", "reload"]);
  } else if (r.status === "check-failed") {
    failed = true;
    ctx.err(`❌ rex config check failed after removing our block; restored ${paths.rexInitLua}.\n${r.detail}`);
  } else ok(`No rex-bot-bridge block in ${paths.rexInitLua}`);

  const skills = await uninstallSkills(paths.skillRoots);
  ok(skills.length ? `Removed agent skill: ${skills.join(", ")}` : "No agent skill installed");

  const desired = `http://127.0.0.1:${s.port}`;
  const target = ctx.tailscaleBin ? await serveTarget(ctx.tailscale, s.servePath) : null;
  // Only our own mapping is ever offered for removal; a foreign or unreadable one is left alone.
  if (target && servesDesired(target, desired)) {
    const cmd = shellCommand("tailscale", serveOffArgs(s.servePath));
    const off = flags.serveOff || (p.interactive && (await p.confirm(`Remove the Tailscale Serve mapping ${s.servePath}?`, false)));
    if (off) {
      const t = await ctx.tailscale(serveOffArgs(s.servePath));
      if (t.code === 0) ok(`Tailscale Serve ${s.servePath} removed`);
      else {
        failed = true;
        ctx.err(`❌ ${cmd} failed: ${(t.stderr || t.stdout).trim()}`);
      }
    } else ctx.out(`   Tailscale Serve ${s.servePath} left in place. Remove it with: ${cmd}`);
  }

  if (flags.purge) {
    await rm(paths.stateDir, { recursive: true, force: true });
    ok(`Deleted ${paths.stateDir} (token, config, watched list). init.lua backups kept in ${paths.backupsDir}`);
  } else {
    ctx.out(`   Kept ${paths.stateDir} (token, config, watched list). Delete it with: rex-bot uninstall --purge`);
  }
  ctx.out("   To remove the package itself: npm uninstall -g rex-bot-bridge");
  return failed ? 1 : 0;
}
