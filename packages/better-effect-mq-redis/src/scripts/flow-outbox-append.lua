local MAX_BODY = 8388608

local function errorReply(code)
  return redis.error_reply(code)
end

local function keyTypeIs(key, expected)
  local actual = redis.call("TYPE", key)
  if type(actual) == "table" then actual = actual.ok end
  return actual == "none" or actual == expected
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
return {"ok", "flow-outbox-append", "applied", tostring(sequence), p.entry}
