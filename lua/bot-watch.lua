-- bot-watch.lua: forward agent status changes in opted-in Rex sessions to the coordinator's webhook.
--
-- Started by `rex-grokbot watch` (the com.rexgrokbotbridge.watch launchd service), which runs
--   rex do --all <package>/lua/bot-watch.lua
-- with these environment variables set:
--   REX_GROKBOT_DIR   state dir holding `watched` (opt-in list) and `heartbeat`
--   REX_GROKBOT_NODE  absolute path of node
--   REX_GROKBOT_CLI   absolute path of dist/cli/rex-grokbot.js (its `notify` command POSTs stdin to the webhook)
--
-- Fires when a pane's program status *enters* done / blocked / error and stays there for DEBOUNCE
-- seconds. Works for any program that speaks OSC 7501 (Claude Code and Pi do natively).

local HOME = os.getenv("HOME") or ""
local DIR = os.getenv("REX_GROKBOT_DIR") or (HOME .. "/.config/rex-grokbot-bridge")
local NODE = os.getenv("REX_GROKBOT_NODE") or "node"
local CLI = os.getenv("REX_GROKBOT_CLI")
local WATCHED_FILE = DIR .. "/watched"
local HEARTBEAT_FILE = DIR .. "/heartbeat"
local TERMINAL = "com.superlogical.terminal"
local DEBOUNCE = tonumber(os.getenv("BOT_WATCH_DEBOUNCE") or "") or 3
local NOTIFY_STATES = { done = true, blocked = true, error = true }

if not CLI or CLI == "" then
  error("REX_GROKBOT_CLI is not set; start the watcher with `rex-grokbot watch`", 0)
end

local function read_file(path)
  local f = io.open(path, "r")
  if not f then return nil end
  local s = f:read("*a"); f:close()
  return s
end

-- Session IDs opted in, re-read on every check so toggling needs no restart.
local function watched(session_id)
  local s = read_file(WATCHED_FILE)
  if not s then return false end
  for line in s:gmatch("[^\n]+") do
    local id = line:match("^%s*([^%s#]+)")
    if id == session_id then return true end
  end
  return false
end

local function session_label(session_id)
  local r = rex.call("session.list", {})
  for _, s in ipairs(r and r.sessions or {}) do
    if s.session_id == session_id then return s.label end
  end
end

local function block_info(session_id, block_id)
  local label, cwd
  local list = rex.session.list_blocks{ session_id = session_id }
  for _, b in ipairs(list and list.blocks or {}) do
    if b.block_id == block_id then label = b.label end
  end
  local p = rex.block.call(TERMINAL, "process", { session_id = session_id, block_id = block_id })
  if p and p.foreground then cwd = p.foreground.cwd end
  if not cwd then
    local d = rex.block.call(TERMINAL, "pwd", { session_id = session_id, block_id = block_id })
    if d and d.pwd then
      cwd = d.pwd:gsub("^file://[^/]*", ""):gsub("%%(%x%x)", function(h) return string.char(tonumber(h, 16)) end)
    end
  end
  return label, cwd
end

local function send(payload)
  local body = rex.json.encode(payload)
  local r, err = rex.exec({ NODE, CLI, "notify" },
    { env = { REX_GROKBOT_DIR = DIR }, stdin = body, timeout = 10 })
  local out = r and (r.stdout or ""):gsub("%s+$", "") or ""
  print(os.date("!%Y-%m-%dT%H:%M:%SZ") .. " " .. payload.state .. " " .. (payload.app or "?") .. " " ..
    payload.rex_block .. " -> " .. (r and out or ("ERR " .. tostring(err))))
end

local last = {}    -- "block|id" -> last state seen
local timers = {}  -- "block|id" -> pending debounce timer

rex.on("terminal.program_status_changed", function(ctx, ev)
  local rec = ev.record or {}
  local state = rec.state
  local key = ctx.block_id .. "|" .. (ev.id or "")
  if last[key] == state then return end  -- msg/progress update, same state
  last[key] = state
  if timers[key] then timers[key]:cancel(); timers[key] = nil end
  if not NOTIFY_STATES[state] or not watched(ctx.session_id) then return end

  local blabel, cwd = block_info(ctx.session_id, ctx.block_id)
  local payload = {
    event = "agent_status",
    state = state,
    kind = rec.kind,
    app = rec.effective_app or rec.app,
    msg = rec.msg,
    title = rec.title,
    status_id = ev.id ~= "" and ev.id or nil,
    rex_session = ctx.session_id,
    rex_session_label = session_label(ctx.session_id),
    rex_block = ctx.block_id,
    rex_block_label = blabel,
    cwd = cwd,
    updated_at = rec.updated_at,
  }
  local sid = ctx.session_id
  timers[key] = rex.after(DEBOUNCE, function()
    timers[key] = nil
    if last[key] ~= state then return end
    -- The human may have unwatched the session during the debounce.
    if not watched(sid) then
      print(os.date("!%Y-%m-%dT%H:%M:%SZ") .. " " .. state .. " " .. payload.rex_block .. " skipped: session no longer watched")
      return
    end
    send(payload)
  end)
end)

rex.on("terminal.program_status_removed", function(ctx, ev)
  for _, id in ipairs(ev.ids or {}) do
    local key = ctx.block_id .. "|" .. id
    last[key] = nil
    if timers[key] then timers[key]:cancel(); timers[key] = nil end
  end
end)

rex.on("block_closed", function(ctx, ev)
  local prefix = (ev.block_id or "") .. "|"
  for key, t in pairs(timers) do
    if key:sub(1, #prefix) == prefix then t:cancel(); timers[key] = nil end
  end
  for key in pairs(last) do
    if key:sub(1, #prefix) == prefix then last[key] = nil end
  end
end)

-- Heartbeat so `rex-grokbot doctor` and the bridge's /healthz can tell the watcher is alive.
-- Written to a 0600 temp file (chmod before any content), then renamed over the old one.
local function beat()
  local tmp = HEARTBEAT_FILE .. ".tmp"
  local f = io.open(tmp, "w")
  if not f then return end
  -- pcall: beat() runs at load, so a throw here would kill the watcher (and launchd would loop it).
  local ok, r = pcall(rex.exec, { "/bin/chmod", "600", tmp })
  if not ok or not r or r.code ~= 0 then
    f:close(); os.remove(tmp)
    print("bot-watch: heartbeat skipped: cannot chmod " .. tmp .. ": " .. tostring(ok and (r and r.stderr) or r))
    return
  end
  f:write(os.date("!%Y-%m-%dT%H:%M:%SZ"), "\n"); f:close()
  os.rename(tmp, HEARTBEAT_FILE)
end
beat()
rex.every(60, beat)
print("bot-watch: running, debounce " .. DEBOUNCE .. "s, state dir " .. DIR)
