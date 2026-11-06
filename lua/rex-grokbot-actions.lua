-- rex-grokbot-actions.lua: command palette actions for rex-grokbot-bridge.
-- Loaded from init.lua by the block `rex-grokbot setup` adds (between the `rex-grokbot-bridge` markers).
-- Edits the same opt-in list the watcher and the bridge read: ~/.config/rex-grokbot-bridge/watched.
-- An entry is a session (session:<uuid>, every pane in it) or a single pane (block:<uuid>).

local BOT_DIR = (os.getenv("HOME") or "") .. "/.config/rex-grokbot-bridge"
local BOT_WATCHED = BOT_DIR .. "/watched"
-- watchlist.lua (the list's parser, shared with the watcher) sits next to this file.
local BOT_WL = dofile(((debug.getinfo(1, "S").source:gsub("^@", "")):match("^(.*)/[^/]*$") or ".") .. "/watchlist.lua")

local function bot_read_lines()
  local lines, f = {}, io.open(BOT_WATCHED, "r")
  if f then
    for line in f:lines() do lines[#lines + 1] = line end
    f:close()
  end
  return lines
end

-- Keeps comments and other lines; writes via a temp file + rename. The temp file is made 0600 before
-- anything is written to it, so the list is never readable by other users.
local function bot_write_lines(lines)
  local tmp = BOT_WATCHED .. ".tmp"
  local f = io.open(tmp, "w")
  if not f then error("cannot write " .. BOT_WATCHED .. " (run `rex-grokbot setup` first)", 0) end
  local ok, r = pcall(rex.exec, { "/bin/chmod", "600", tmp })
  if not ok or not r or r.code ~= 0 then
    f:close(); os.remove(tmp)
    error("cannot chmod " .. tmp, 0)
  end
  for _, line in ipairs(lines) do f:write(line, "\n") end
  f:close()
  assert(os.rename(tmp, BOT_WATCHED))
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

-- Adds id to the list, or removes it if it is there. Returns true when it is now watched.
local function bot_toggle(id)
  local kept, found = {}, false
  for _, line in ipairs(bot_read_lines()) do
    if BOT_WL.line_id(line) == id then found = true else kept[#kept + 1] = line end
  end
  if not found then kept[#kept + 1] = id end
  local ok, err = pcall(bot_write_lines, kept)
  if not ok then
    bot_alert("Rex Bot", "Could not update the watch list: " .. tostring(err))
    error(err, 0)
  end
  return not found
end

rex.action{
  name = "bot_watch_toggle",
  title = "Bot: Watch / Unwatch This Session",
  description = "Let the coordinator bot see and drive every pane in this session (status pushes + watched-mode access), or stop.",
  category = "Bot",
  keywords = "grok bot coordinator webhook watch notify rex-grokbot session",
  run = function(ctx, args)
    local sid = ctx.session_id
    if not sid then error("no session", 0) end
    local watching = bot_toggle(sid)
    local name = bot_name(bot_names(false), sid)
    bot_alert("Rex Bot", (watching and "Now watching session " or "Stopped watching session ") .. name ..
      (watching and " (every pane in it)" or ""))
    return { session_id = sid, watching = watching }
  end,
}

rex.action{
  name = "bot_watch_pane_toggle",
  title = "Bot: Watch / Unwatch This Pane",
  description = "Let the coordinator bot see and drive only the focused pane (status pushes + watched-mode access), or stop.",
  category = "Bot",
  keywords = "grok bot coordinator webhook watch notify rex-grokbot pane block",
  run = function(ctx, args)
    local bid = ctx.block_id
    if not bid then error("no focused pane", 0) end
    local watching = bot_toggle(bid)
    local names = bot_names(true)
    local msg = (watching and "Now watching pane " or "Stopped watching pane ") .. bot_name(names, bid)
    if ctx.session_id then
      msg = msg .. " in " .. bot_name(names, ctx.session_id)
      if BOT_WL.covers(BOT_WL.parse(table.concat(bot_read_lines(), "\n")), ctx.session_id, nil) then
        msg = msg .. ". Its session is watched too, so the bot still covers this pane"
      end
    end
    bot_alert("Rex Bot", msg)
    return { block_id = bid, watching = watching }
  end,
}

rex.action{
  name = "bot_watch_list",
  title = "Bot: List Watched",
  description = "Show the sessions and panes the coordinator bot watches.",
  category = "Bot",
  keywords = "grok bot coordinator webhook watch rex-grokbot sessions panes",
  run = function(ctx, args)
    local ids = BOT_WL.parse(table.concat(bot_read_lines(), "\n"))
    local sessions, panes = {}, {}
    for _, id in ipairs(ids) do
      if BOT_WL.kind(id) == "session" then sessions[#sessions + 1] = id else panes[#panes + 1] = id end
    end
    local names, block_session = bot_names(#panes > 0)
    local lines = {}
    for _, id in ipairs(sessions) do lines[#lines + 1] = "Session: " .. bot_name(names, id) end
    for _, id in ipairs(panes) do
      local where = block_session[id] and (" in " .. bot_name(names, block_session[id])) or ""
      lines[#lines + 1] = "Pane: " .. bot_name(names, id) .. where
    end
    bot_alert("Rex Bot: watching " .. #sessions .. " session(s), " .. #panes .. " pane(s)",
      #lines > 0 and table.concat(lines, "\n") or "Nothing watched")
    return { sessions = sessions, panes = panes }
  end,
}
