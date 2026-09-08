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

if #KEYS < 3 or type(ARGV[1]) ~= "string" or #ARGV[1] > MAX_BODY then
  return errorReply("MQ_BATCH_LIMIT")
end

local decodedOk, p = pcall(cjson.decode, ARGV[1])
if not decodedOk or type(p) ~= "table" or p.mode ~= "flow-outbox-append" or
   type(p.id) ~= "string" or type(p.entry) ~= "string" then
  return errorReply("MQ_INVALID_ARGUMENT")
end

if not keyTypeIs(KEYS[1], "string") or not keyTypeIs(KEYS[2], "zset") or
   not keyTypeIs(KEYS[3], "string") then
  return errorReply("MQ_CORRUPT_COUNTER")
end

local existing = redis.call("GET", KEYS[3])
if existing then
  if existing == p.entry then
    return {"ok", "flow-outbox-append", "already-applied", existing}
  end
  return errorReply("MQ_SETTLEMENT_CONFLICT")
end

local sequence = redis.call("INCR", KEYS[1])
redis.call("SET", KEYS[3], p.entry)
redis.call("ZADD", KEYS[2], sequence, p.id)
if not appendEvent(p) then return errorReply("MQ_INVALID_ARGUMENT") end
return {"ok", "flow-outbox-append", "applied", tostring(sequence), p.entry}
