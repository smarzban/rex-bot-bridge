-- watchlist.lua: the bot-watch opt-in list, shared by bot-watch.lua (the watcher) and
-- rex-grokbot-actions.lua (the palette). Must agree with src/watch.ts.
--
-- One entry per line, `#` comments allowed. The entry is the first token before whitespace or `#`:
--   session:<uuid>  every pane in that session
--   block:<uuid>    only that pane
-- Any other token is ignored.

local M = {}

function M.line_id(line)
  return line:match("^%s*([^%s#]+)")
end

-- "session", "pane", or nil for a line that isn't an entry.
function M.kind(id)
  if not id then return nil end
  if id:match("^session:%S+$") then return "session" end
  if id:match("^block:%S+$") then return "pane" end
  return nil
end

-- Entry ids in file order, without duplicates or junk.
function M.parse(content)
  local ids, seen = {}, {}
  for line in (content or ""):gmatch("[^\n]+") do
    local id = M.line_id(line)
    if M.kind(id) and not seen[id] then
      seen[id] = true
      ids[#ids + 1] = id
    end
  end
  return ids
end

-- True when the pane itself or its session is on the list.
function M.covers(ids, session_id, block_id)
  for _, id in ipairs(ids) do
    if (session_id and id == session_id) or (block_id and id == block_id) then return true end
  end
  return false
end

function M.read(path)
  local f = io.open(path, "r")
  if not f then return {} end
  local s = f:read("*a"); f:close()
  return M.parse(s)
end

return M
