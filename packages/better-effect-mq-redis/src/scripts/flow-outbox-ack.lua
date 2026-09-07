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
if not decodedOk or type(p) ~= "table" or p.mode ~= "flow-outbox-ack" or
   type(p.id) ~= "string" or type(p.entry) ~= "string" then
  return errorReply("MQ_INVALID_ARGUMENT")
end

if not keyTypeIs(KEYS[1], "zset") or not keyTypeIs(KEYS[2], "string") then
  return errorReply("MQ_CORRUPT_COUNTER")
end

local existing = redis.call("GET", KEYS[2])
if not existing or existing ~= p.entry then
  return {"ok", "flow-outbox-ack", "skipped"}
end

redis.call("DEL", KEYS[2])
redis.call("ZREM", KEYS[1], p.id)
return {"ok", "flow-outbox-ack", "acknowledged"}
