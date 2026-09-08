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
  if retention.ageMs then
    local cutoff = event.recordedAtMs - retention.ageMs
    if cutoff < 0 then cutoff = 0 end
    redis.call("XTRIM", keys.events, "MINID", "=", tostring(cutoff) .. "-0")
  end
  return true
end

if #KEYS < 4 or type(ARGV[1]) ~= "string" or #ARGV[1] > MAX_BODY then
  return errorReply("MQ_BATCH_LIMIT")
end

local decodedOk, p = pcall(cjson.decode, ARGV[1])
if not decodedOk or type(p) ~= "table" or p.mode ~= "flow-fanout" or
   type(p.parent) ~= "table" or type(p.children) ~= "table" or
   type(p.parent.flow) ~= "table" or
   type(p.digest) ~= "string" or type(p.now) ~= "number" then
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

local parentKey, childrenKey, indexKey, pendingKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
local existing = redis.call("HGET", parentKey, "record")
if existing then
  local storedDigest = redis.call("HGET", parentKey, "fanOutDigest")
  if storedDigest == p.digest then
    local children = {}
    for _, child in ipairs(p.children) do
      local value = redis.call("HGET", childrenKey, child.childKey)
      if not value then return errorReply("MQ_CORRUPT_COUNTER") end
      local ok, entry = pcall(cjson.decode, value)
      if not ok or type(entry) ~= "table" or type(entry.record) ~= "table" then
        return errorReply("MQ_CORRUPT_COUNTER")
      end
      children[#children + 1] = entry.record
    end
    local ok, parent = pcall(cjson.decode, existing)
    if not ok or type(parent) ~= "table" then return errorReply("MQ_CORRUPT_COUNTER") end
    return {"ok", "flow-fanout", "already-applied", cjson.encode(parent), cjson.encode(children)}
  end
  return errorReply("MQ_SETTLEMENT_CONFLICT")
end

local seen = {}
for _, child in ipairs(p.children) do
  if type(child) ~= "table" or type(child.childKey) ~= "string" or
     type(child.member) ~= "string" or type(child.reference) ~= "string" or
     type(child.entry) ~= "string" then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
  if seen[child.childKey] then return errorReply("MQ_INVALID_ARGUMENT") end
  seen[child.childKey] = true
  local ok, entry = pcall(cjson.decode, child.entry)
  if not ok or type(entry) ~= "table" or type(entry.spec) ~= "table" or
     type(entry.record) ~= "table" or type(entry.reference) ~= "string" or
     entry.reference ~= child.reference then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
end

local children = {}
for _, child in ipairs(p.children) do
  local ok, entry = pcall(cjson.decode, child.entry)
  if not ok or type(entry) ~= "table" or type(entry.spec) ~= "table" or type(entry.record) ~= "table" then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
  redis.call("HSET", childrenKey, child.childKey, child.entry)
  redis.call("ZADD", indexKey, 0, child.member)
  redis.call("ZADD", pendingKey, p.now, child.reference)
  children[#children + 1] = entry.record
end

redis.call("HSET", parentKey, "record", cjson.encode(p.parent), "fanOutDigest", p.digest)
if not appendEvent(p) then return errorReply("MQ_INVALID_ARGUMENT") end
return {"ok", "flow-fanout", "applied", cjson.encode(p.parent), cjson.encode(children)}
