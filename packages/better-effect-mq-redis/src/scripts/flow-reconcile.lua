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
if not decodedOk or type(p) ~= "table" or p.mode ~= "flow-reconcile" or
   type(p.observations) ~= "table" or type(p.now) ~= "number" then
  return errorReply("MQ_INVALID_ARGUMENT")
end
if not keyTypeIs(KEYS[1], "hash") or not keyTypeIs(KEYS[2], "hash") or not keyTypeIs(KEYS[3], "zset") then
  return errorReply("MQ_CORRUPT_COUNTER")
end
local parentRaw = redis.call("HGET", KEYS[1], "record")
if not parentRaw then return errorReply("MQ_NOT_FOUND") end
local parentOk, parent = pcall(cjson.decode, parentRaw)
if not parentOk or type(parent) ~= "table" then return errorReply("MQ_CORRUPT_COUNTER") end

local enqueue, reports, cascade = {}, {}, {}
local seen = {}
local allChildren = redis.call("HGETALL", KEYS[2])
for index = 1, #allChildren, 2 do
  local ok, entry = pcall(cjson.decode, allChildren[index + 1])
  if not ok or type(entry) ~= "table" or type(entry.spec) ~= "table" or
     type(entry.record) ~= "table" or type(entry.reference) ~= "string" then
    return errorReply("MQ_CORRUPT_COUNTER")
  end
end

for _, observation in ipairs(p.observations) do
  if type(observation) ~= "table" or type(observation.childKey) ~= "string" or
     type(observation.reference) ~= "string" then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
  if seen[observation.childKey] then return errorReply("MQ_INVALID_ARGUMENT") end
  seen[observation.childKey] = true
  local raw = redis.call("HGET", KEYS[2], observation.childKey)
  if not raw then return errorReply("MQ_INVALID_ARGUMENT") end
  local ok, entry = pcall(cjson.decode, raw)
  if not ok or type(entry) ~= "table" or type(entry.spec) ~= "table" or
     type(entry.record) ~= "table" or type(entry.reference) ~= "string" or
     entry.reference ~= observation.reference then
    return errorReply("MQ_CORRUPT_COUNTER")
  end
  if observation.state ~= "missing" and observation.state ~= "waiting" and
     observation.state ~= "delayed" and observation.state ~= "active" and
     observation.state ~= "waiting-children" and observation.state ~= "completed" and
     observation.state ~= "failed" and observation.state ~= "cancelled" then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
end

seen = {}
for _, observation in ipairs(p.observations) do
  seen[observation.childKey] = true
  local raw = redis.call("HGET", KEYS[2], observation.childKey)
  local ok, entry = pcall(cjson.decode, raw)
  if not ok or type(entry) ~= "table" or type(entry.spec) ~= "table" or type(entry.record) ~= "table" then
    return errorReply("MQ_CORRUPT_COUNTER")
  end
  local child = entry.record
  if child.status == "pending" then
    child.pendingSinceMs = p.now
    redis.call("HSET", KEYS[2], observation.childKey, cjson.encode(entry))
    redis.call("ZADD", KEYS[3], p.now, observation.reference)
    if observation.state == "missing" then
      enqueue[#enqueue + 1] = entry.spec
    elseif observation.state == "completed" or observation.state == "failed" or observation.state == "cancelled" then
      reports[#reports + 1] = {
        flowId = child.flowId,
        childKey = child.childKey,
        outcome = observation.state,
        result = observation.result,
        failure = observation.failure
      }
    end
  end
  if child.status == "cancelled" and child.cascaded ~= true then
    cascade[#cascade + 1] = entry.spec
  end
end

local all = redis.call("HGETALL", KEYS[2])
for index = 1, #all, 2 do
  local ok, entry = pcall(cjson.decode, all[index + 1])
  if not ok or type(entry) ~= "table" or type(entry.spec) ~= "table" or type(entry.record) ~= "table" then
    return errorReply("MQ_CORRUPT_COUNTER")
  end
  if entry.record.status == "cancelled" and entry.record.cascaded ~= true and not seen[entry.record.childKey] then
    cascade[#cascade + 1] = entry.spec
  end
end
return {"ok", "flow-reconcile", cjson.encode(enqueue), cjson.encode(reports), cjson.encode(cascade)}
