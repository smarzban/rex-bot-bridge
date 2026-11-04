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

-- Keeps comments and other lines; writes via a temp file + rename.
local function bot_write_lines(lines)
  local tmp = BOT_WATCHED .. ".tmp"
  local f = io.open(tmp, "w")
  if not f then error("cannot write " .. BOT_WATCHED .. " (run `rex-bot setup` first)", 0) end
  for _, line in ipairs(lines) do f:write(line, "\n") end
  f:close()
  assert(os.rename(tmp, BOT_WATCHED))
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
    bot_write_lines(kept)
    return { session_id = sid, watching = not found }
  end,
}

rex.action{
  name = "bot_watch_list",
  title = "Bot: List Watched Sessions",
  category = "Bot",
  keywords = "grok bot coordinator webhook watch rex-bot",
  run = function(ctx, args)
    return { sessions = bot_read_ids() }
  end,
}
