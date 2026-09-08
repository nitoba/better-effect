local MAX_BODY = 8388608
local declared = {}
for _, key in ipairs(KEYS) do declared[key] = true end

local function errorReply(code)
  return redis.error_reply(code)
end

local function keyTypeIs(key, expected)
  local actual = redis.call("TYPE", key)
  if type(actual) == "table" then actual = actual.ok end
  return actual == "none" or actual == expected
end
local function appendEvent(p)
  local event = p.event
  if event == nil then return true end
  local keys = p.eventKeys
  if type(keys) ~= "table" or type(keys.events) ~= "string" or type(keys.eventsMeta) ~= "string" or
    not declared[keys.events] or not declared[keys.eventsMeta] or not keyTypeIs(keys.events, "stream") or
    not keyTypeIs(keys.eventsMeta, "hash") or type(event.type) ~= "string" or event.type == "" or
    type(event.recordedAtMs) ~= "number" or event.recordedAtMs < 0 or math.floor(event.recordedAtMs) ~= event.recordedAtMs or
    type(event.attributes) ~= "table" then return false end
  redis.call("XADD", keys.events, "*", "data", cjson.encode(event))
  redis.call("HSET", keys.eventsMeta, "initialized", "1")
  local retention = p.eventRetention or {}
  if retention.count then redis.call("XTRIM", keys.events, "MAXLEN", "=", tostring(retention.count)) end
  if retention.ageMs then local cutoff = event.recordedAtMs - retention.ageMs; if cutoff < 0 then cutoff = 0 end; redis.call("XTRIM", keys.events, "MINID", "=", tostring(cutoff) .. "-0") end
  return true
end

if #KEYS < 4 or type(ARGV[1]) ~= "string" or #ARGV[1] > MAX_BODY then
  return errorReply("MQ_BATCH_LIMIT")
end
local decodedOk, p = pcall(cjson.decode, ARGV[1])
if not decodedOk or type(p) ~= "table" or p.mode ~= "flow-cancel" then
  return errorReply("MQ_INVALID_ARGUMENT")
end
for _, pair in ipairs({
  {KEYS[1], "hash"},
  {KEYS[2], "hash"},
  {KEYS[3], "zset"},
  {KEYS[4], "zset"}
}) do
  if not keyTypeIs(pair[1], pair[2]) then return errorReply("MQ_CORRUPT_COUNTER") end
end

local parentKey, childrenKey, pendingKey, cascadeKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local parentRaw = redis.call("HGET", parentKey, "record")
if not parentRaw then return errorReply("MQ_NOT_FOUND") end
local parentOk, parent = pcall(cjson.decode, parentRaw)
if not parentOk or type(parent) ~= "table" or type(parent.flow) ~= "table" then
  return errorReply("MQ_CORRUPT_COUNTER")
end

local cancelled = 0
local parentSettled = false
local allChildren = redis.call("HGETALL", childrenKey)
for index = 1, #allChildren, 2 do
  local ok, entry = pcall(cjson.decode, allChildren[index + 1])
  if not ok or type(entry) ~= "table" or type(entry.record) ~= "table" or
     type(entry.reference) ~= "string" then
    return errorReply("MQ_CORRUPT_COUNTER")
  end
end

if parent.state == "waiting-children" then
  for index = 1, #allChildren, 2 do
    local childKey = allChildren[index]
    local raw = allChildren[index + 1]
    local ok, entry = pcall(cjson.decode, raw)
    if not ok or type(entry) ~= "table" or type(entry.record) ~= "table" then
      return errorReply("MQ_CORRUPT_COUNTER")
    end
    local child = entry.record
    if child.status == "pending" then
      child.status = "cancelled"
      child.result = nil
      child.failure = nil
      child.cascaded = false
      redis.call("HSET", childrenKey, childKey, cjson.encode(entry))
      redis.call("ZREM", pendingKey, entry.reference)
      redis.call("ZADD", cascadeKey, p.now, entry.reference)
      cancelled = cancelled + 1
    end
  end
  parent.flow.cancelled = parent.flow.cancelled + cancelled
  parent.flow.pending = 0
  parent.state = "cancelled"
  parentSettled = true
  redis.call("HSET", parentKey, "record", cjson.encode(parent))
end

if cancelled > 0 and p.event ~= nil then
  p.event.attributes.cancelled = tostring(cancelled)
  if not appendEvent(p) then return errorReply("MQ_INVALID_ARGUMENT") end
end
local children = {}
local all = redis.call("HGETALL", childrenKey)
for index = 1, #all, 2 do
  local ok, entry = pcall(cjson.decode, all[index + 1])
  if not ok or type(entry) ~= "table" or type(entry.record) ~= "table" then
    return errorReply("MQ_CORRUPT_COUNTER")
  end
  children[#children + 1] = entry.record
end
return {"ok", "flow-cancel", tostring(cancelled), parentSettled and "1" or "0", cjson.encode(parent), cjson.encode(children)}
