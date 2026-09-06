local MAX_BODY = 8388608

local function errorReply(code)
  return redis.error_reply(code)
end

local function keyTypeIs(key, expected)
  local actual = redis.call("TYPE", key)
  if type(actual) == "table" then actual = actual.ok end
  return actual == "none" or actual == expected
end

if #KEYS < 2 or type(ARGV[1]) ~= "string" or #ARGV[1] > MAX_BODY then
  return errorReply("MQ_BATCH_LIMIT")
end
local decodedOk, p = pcall(cjson.decode, ARGV[1])
if not decodedOk or type(p) ~= "table" or p.mode ~= "flow-mark-cascaded" or
   type(p.childKeys) ~= "table" then
  return errorReply("MQ_INVALID_ARGUMENT")
end
if not keyTypeIs(KEYS[1], "hash") or not keyTypeIs(KEYS[2], "zset") then
  return errorReply("MQ_CORRUPT_COUNTER")
end
local actual = redis.call("TYPE", KEYS[1])
if type(actual) == "table" then actual = actual.ok end
if actual ~= "hash" and actual ~= "none" then return errorReply("MQ_CORRUPT_COUNTER") end

local marked = 0
local children = {}
local allChildren = redis.call("HGETALL", KEYS[1])
for index = 1, #allChildren, 2 do
  local ok, entry = pcall(cjson.decode, allChildren[index + 1])
  if not ok or type(entry) ~= "table" or type(entry.record) ~= "table" or
     type(entry.reference) ~= "string" then
    return errorReply("MQ_CORRUPT_COUNTER")
  end
end

for _, childKey in ipairs(p.childKeys) do
  if type(childKey) ~= "string" or not redis.call("HGET", KEYS[1], childKey) then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
end

for _, childKey in ipairs(p.childKeys) do
  if type(childKey) ~= "string" then return errorReply("MQ_INVALID_ARGUMENT") end
  local raw = redis.call("HGET", KEYS[1], childKey)
  if not raw then return errorReply("MQ_INVALID_ARGUMENT") end
  local ok, entry = pcall(cjson.decode, raw)
  if not ok or type(entry) ~= "table" or type(entry.record) ~= "table" then
    return errorReply("MQ_CORRUPT_COUNTER")
  end
  if entry.record.status == "cancelled" and entry.record.cascaded ~= true then
    entry.record.cascaded = true
    redis.call("HSET", KEYS[1], childKey, cjson.encode(entry))
    redis.call("ZREM", KEYS[2], entry.reference)
    marked = marked + 1
  end
end
local all = redis.call("HGETALL", KEYS[1])
for index = 1, #all, 2 do
  local ok, entry = pcall(cjson.decode, all[index + 1])
  if not ok or type(entry) ~= "table" or type(entry.record) ~= "table" then
    return errorReply("MQ_CORRUPT_COUNTER")
  end
  children[#children + 1] = entry.record
end
return {"ok", "flow-mark-cascaded", tostring(marked), cjson.encode(children)}
