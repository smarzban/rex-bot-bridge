-- rex-bot-actions.lua: command palette actions for rex-bot-bridge.
-- Loaded from init.lua by the block `rex-bot setup` adds (between the `rex-bot-bridge` markers).
-- Edits the same opt-in list the watcher and the bridge read: ~/.config/rex-bot-bridge/watched.

local BOT_DIR = (os.getenv("HOME") or "") .. "/.config/rex-bot-bridge"
local BOT_WATCHED = BOT_DIR .. "/watched"

local function bot_read_lines()
  local lines, f = {}, io.open(BOT_WATCHED, "r")
  if f then
    for line in f:lines() do lines[#lines + 1] = line end
    f:close()
  end
  return lines
end

local function bot_line_id(line)
  return line:match("^%s*([^%s#]+)")
end

local function bot_read_ids()
  local ids = {}
  for _, line in ipairs(bot_read_lines()) do
    local id = bot_line_id(line)
    if id then ids[#ids + 1] = id end
  end
  return ids
end

-- Keeps comments and other lines; writes via a temp file + rename. The temp file is made 0600 before
-- anything is written to it, so the list is never readable by other users.
local function bot_write_lines(lines)
  local tmp = BOT_WATCHED .. ".tmp"
  local f = io.open(tmp, "w")
  if not f then error("cannot write " .. BOT_WATCHED .. " (run `rex-bot setup` first)", 0) end
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

-- session_id -> label (nil if unlabelled) for the sessions that exist now.
local function bot_session_labels()
  local labels = {}
  local ok, r = pcall(rex.call, "session.list", {})
  for _, s in ipairs(ok and r and r.sessions or {}) do
    labels[s.session_id] = s.label or false
  end
  return labels
end

local function bot_session_name(labels, id)
  local l = labels[id]
  if l == nil then return id .. " (closed)" end
  if l == false or l == "" then return id end
  return l
end

rex.action{
  name = "bot_watch_toggle",
  title = "Bot: Watch / Unwatch This Session",
  description = "Let the coordinator bot see and drive this session (status pushes + watched-mode access), or stop.",
  category = "Bot",
  keywords = "grok bot coordinator webhook watch notify rex-bot",
  run = function(ctx, args)
    local sid = ctx.session_id
    if not sid then error("no session", 0) end
    local kept, found = {}, false
    for _, line in ipairs(bot_read_lines()) do
      if bot_line_id(line) == sid then found = true else kept[#kept + 1] = line end
    end
    if not found then kept[#kept + 1] = sid end
    local ok, err = pcall(bot_write_lines, kept)
    if not ok then
      bot_alert("Rex Bot", "Could not update the watch list: " .. tostring(err))
      error(err, 0)
    end
    local name = bot_session_name(bot_session_labels(), sid)
    bot_alert("Rex Bot", (found and "Stopped watching " or "Now watching ") .. name)
    return { session_id = sid, watching = not found }
  end,
}

rex.action{
  name = "bot_watch_list",
  title = "Bot: List Watched Sessions",
  category = "Bot",
  keywords = "grok bot coordinator webhook watch rex-bot",
  run = function(ctx, args)
    local ids = bot_read_ids()
    local labels = bot_session_labels()
    local names = {}
    for _, id in ipairs(ids) do names[#names + 1] = bot_session_name(labels, id) end
    bot_alert("Rex Bot: watching " .. #ids, #names > 0 and table.concat(names, ", ") or "No sessions watched")
    return { sessions = ids }
  end,
}
