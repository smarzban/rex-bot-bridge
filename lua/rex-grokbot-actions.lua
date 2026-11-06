-- rex-grokbot-actions.lua: command palette actions for rex-grokbot-bridge.
-- Loaded from init.lua by the block `rex-grokbot setup` adds (between the `rex-grokbot-bridge` markers).
-- Edits the same share list the watcher and the bridge read: ~/.config/rex-grokbot-bridge/shared.
-- An entry is a session (session:<uuid>, every pane in it) or a single pane (block:<uuid>).

local BOT_DIR = (os.getenv("HOME") or "") .. "/.config/rex-grokbot-bridge"
local BOT_SHARED = BOT_DIR .. "/shared"
-- sharelist.lua (the list's parser, shared with the watcher) sits next to this file.
local BOT_SL = dofile(((debug.getinfo(1, "S").source:gsub("^@", "")):match("^(.*)/[^/]*$") or ".") .. "/sharelist.lua")

local function bot_read_lines()
  local lines, f = {}, io.open(BOT_SHARED, "r")
  if f then
    for line in f:lines() do lines[#lines + 1] = line end
    f:close()
  end
  return lines
end

-- Keeps comments and other lines; writes via a temp file + rename. The temp file is made 0600 before
-- anything is written to it, so the list is never readable by other users. Its name is unique, so two
-- writers never share it.
local function bot_write_lines(lines)
  local tmp = string.format("%s/.shared.%d.%d.%d.tmp", BOT_DIR, os.time(), math.random(0, 999999), math.random(0, 999999))
  local f = io.open(tmp, "w")
  if not f then error("cannot write " .. BOT_SHARED .. " (run `rex-grokbot setup` first)", 0) end
  local ok, r = pcall(rex.exec, { "/bin/chmod", "600", tmp })
  if not ok or not r or r.code ~= 0 then
    f:close(); os.remove(tmp)
    error("cannot chmod " .. tmp, 0)
  end
  for _, line in ipairs(lines) do f:write(line, "\n") end
  f:close()
  local renamed, err = os.rename(tmp, BOT_SHARED)
  if not renamed then os.remove(tmp); error("cannot replace " .. BOT_SHARED .. ": " .. tostring(err), 0) end
end

-- The cross-process lock the bridge and the CLI take too (src/share.ts withShareLock): the directory
-- <list>.lock, made with mkdir (atomic). Waits up to ~3s (60 x 50ms); a lock older than 10s is a crashed
-- writer's and is removed, but only under the break-lock (bot_break). Same thresholds as the Node side.
local BOT_LOCK = BOT_SHARED .. ".lock"
local BOT_BREAK = BOT_LOCK .. ".break"
local BOT_LOCK_TRIES, BOT_LOCK_STALE = 60, 10

local function bot_exists(path)
  local ok, r = pcall(rex.exec, { "/bin/test", "-e", path })
  return ok and r and r.code == 0
end

-- mtime in seconds, or nil when the path is gone.
local function bot_mtime(path)
  local ok, r = pcall(rex.exec, { "/usr/bin/stat", "-f", "%m", path })
  return ok and r and r.code == 0 and tonumber((r.stdout or ""):match("%d+")) or nil
end

local function bot_stale(path)
  local m = bot_mtime(path)
  return m ~= nil and os.time() - m > BOT_LOCK_STALE
end

-- Removes the lock only if it is still stale once we hold <lock>.break (mkdir, like the lock), so two
-- writers that both saw the same stale lock can't both remove it: the second re-checks and finds the first
-- one's fresh lock. A break-lock older than 10s (a breaker that crashed while holding it) is removed.
-- Same protocol as breakStaleLock in src/share.ts. Returns true when this call removed the lock.
local function bot_break()
  local ok, r = pcall(rex.exec, { "/bin/mkdir", BOT_BREAK })
  if not (ok and r and r.code == 0) then
    if bot_stale(BOT_BREAK) then os.remove(BOT_BREAK) end
    return false
  end
  local removed = false
  if bot_stale(BOT_LOCK) then removed = os.remove(BOT_LOCK) and true or false end
  os.remove(BOT_BREAK)
  return removed
end

local function bot_lock()
  for _ = 1, BOT_LOCK_TRIES do
    local ok, r = pcall(rex.exec, { "/bin/mkdir", BOT_LOCK })
    if ok and r and r.code == 0 then return end
    local mtime = bot_mtime(BOT_LOCK)
    if mtime then
      if not (os.time() - mtime > BOT_LOCK_STALE and bot_break()) then
        pcall(rex.exec, { "/bin/sleep", "0.05" })
      end
    elseif not bot_exists(BOT_LOCK) and not bot_exists(BOT_DIR) then
      error("cannot write " .. BOT_SHARED .. " (run `rex-grokbot setup` first)", 0)
    end
  end
  error("share list is locked by another writer; try again (lock: " .. BOT_LOCK .. ")", 0)
end

-- Runs fn() holding the lock; the lock is removed afterwards, also when fn fails.
local function bot_locked(fn)
  bot_lock()
  local ok, res = pcall(fn)
  os.remove(BOT_LOCK)
  if not ok then error(res, 0) end
  return res
end

-- The palette discards an action's return value, so show the result in an alert that closes itself.
-- Title and body go in as argv, never interpolated into the AppleScript.
local function bot_alert(title, body)
  pcall(rex.exec.start, {
    "osascript",
    "-e", "on run argv",
    "-e", "display alert (item 1 of argv) message (item 2 of argv) giving up after 15",
    "-e", "end run",
    title, body,
  }, { detach = true, stdout = false, stderr = false })
end

-- Names for the sessions and panes that exist now: id -> label, false when unlabelled.
-- Pane names say which session they are in. Best effort: a failed lookup just shows ids.
local function bot_names(want_panes)
  local names, block_session = {}, {}
  local ok, r = pcall(rex.call, "session.list", {})
  for _, s in ipairs(ok and r and r.sessions or {}) do
    names[s.session_id] = s.label or false
    if want_panes then
      local okb, list = pcall(rex.session.list_blocks, { session_id = s.session_id })
      for _, b in ipairs(okb and list and list.blocks or {}) do
        names[b.block_id] = b.label or false
        block_session[b.block_id] = s.session_id
      end
    end
  end
  return names, block_session
end

local function bot_name(names, id)
  local l = names[id]
  if l == nil then return id .. " (closed)" end
  if l == false or l == "" then return id end
  return l
end

-- Adds id to the list, or removes it if it is there. Returns true when it is now shared.
-- The whole read/modify/write happens under the lock.
local function bot_toggle(id)
  local ok, res = pcall(bot_locked, function()
    local kept, found = {}, false
    for _, line in ipairs(bot_read_lines()) do
      if BOT_SL.line_id(line) == id then found = true else kept[#kept + 1] = line end
    end
    if not found then kept[#kept + 1] = id end
    bot_write_lines(kept)
    return not found
  end)
  if not ok then
    bot_alert("Rex Bot", "Could not update the share list: " .. tostring(res))
    error(res, 0)
  end
  return res
end

rex.action{
  name = "bot_share_toggle",
  title = "Bot: Share / Unshare This Session",
  description = "Let the coordinator bot see and drive every pane in this session (status pushes + shared-mode access), or stop.",
  category = "Bot",
  keywords = "grok bot coordinator webhook share watch notify rex-grokbot session",
  run = function(ctx, args)
    local sid = ctx.session_id
    if not sid then error("no session", 0) end
    local sharing = bot_toggle(sid)
    local name = bot_name(bot_names(false), sid)
    bot_alert("Rex Bot", (sharing and "Now sharing with the bot: session " or "Stopped sharing with the bot: session ") .. name ..
      (sharing and " (every pane in it)" or ""))
    return { session_id = sid, sharing = sharing }
  end,
}

rex.action{
  name = "bot_share_pane_toggle",
  title = "Bot: Share / Unshare This Pane",
  description = "Let the coordinator bot see and drive only the focused pane (status pushes + shared-mode access), or stop.",
  category = "Bot",
  keywords = "grok bot coordinator webhook share watch notify rex-grokbot pane block",
  run = function(ctx, args)
    local bid = ctx.block_id
    if not bid then error("no focused pane", 0) end
    local sharing = bot_toggle(bid)
    local names = bot_names(true)
    local msg = (sharing and "Now sharing with the bot: pane " or "Stopped sharing with the bot: pane ") .. bot_name(names, bid)
    if ctx.session_id then
      msg = msg .. " in " .. bot_name(names, ctx.session_id)
      if BOT_SL.covers(BOT_SL.parse(table.concat(bot_read_lines(), "\n")), ctx.session_id, nil) then
        msg = msg .. ". Its session is shared too, so the bot still covers this pane"
      end
    end
    bot_alert("Rex Bot", msg)
    return { block_id = bid, sharing = sharing }
  end,
}

rex.action{
  name = "bot_share_list",
  title = "Bot: List Shared",
  description = "Show the sessions and panes the coordinator bot can see and drive.",
  category = "Bot",
  keywords = "grok bot coordinator webhook share rex-grokbot sessions panes",
  run = function(ctx, args)
    local ids = BOT_SL.parse(table.concat(bot_read_lines(), "\n"))
    local sessions, panes = {}, {}
    for _, id in ipairs(ids) do
      if BOT_SL.kind(id) == "session" then sessions[#sessions + 1] = id else panes[#panes + 1] = id end
    end
    local names, block_session = bot_names(#panes > 0)
    local lines = {}
    for _, id in ipairs(sessions) do lines[#lines + 1] = "Session: " .. bot_name(names, id) end
    for _, id in ipairs(panes) do
      local where = block_session[id] and (" in " .. bot_name(names, block_session[id])) or ""
      lines[#lines + 1] = "Pane: " .. bot_name(names, id) .. where
    end
    bot_alert("Rex Bot: sharing " .. #sessions .. " session(s), " .. #panes .. " pane(s)",
      #lines > 0 and table.concat(lines, "\n") or "Nothing shared")
    return { sessions = sessions, panes = panes }
  end,
}
