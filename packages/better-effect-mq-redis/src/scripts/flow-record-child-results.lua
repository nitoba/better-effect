local MAX_BODY = 8388608

local function errorReply(code)
  return redis.error_reply(code)
end

local function keyTypeIs(key, expected)
  local actual = redis.call("TYPE", key)
  if type(actual) == "table" then actual = actual.ok end
  return actual == "none" or actual == expected
end

if #KEYS < 4 or type(ARGV[1]) ~= "string" or #ARGV[1] > MAX_BODY then
  return errorReply("MQ_BATCH_LIMIT")
end
local decodedOk, p = pcall(cjson.decode, ARGV[1])
if not decodedOk or type(p) ~= "table" or p.mode ~= "flow-record-child-results" or
   type(p.reports) ~= "table" or type(p.now) ~= "number" then
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

local allChildren = redis.call("HGETALL", childrenKey)
for index = 1, #allChildren, 2 do
  local ok, entry = pcall(cjson.decode, allChildren[index + 1])
  if not ok or type(entry) ~= "table" or type(entry.record) ~= "table" or
     type(entry.reference) ~= "string" then
    return errorReply("MQ_CORRUPT_COUNTER")
  end
end

local seen = {}
for _, report in ipairs(p.reports) do
  if type(report) ~= "table" or type(report.childKey) ~= "string" or
     type(report.outcome) ~= "string" or type(report.reference) ~= "string" then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
  if seen[report.childKey] then return errorReply("MQ_INVALID_ARGUMENT") end
  seen[report.childKey] = true
  local raw = redis.call("HGET", childrenKey, report.childKey)
  if not raw then return errorReply("MQ_INVALID_ARGUMENT") end
  local entryOk, entry = pcall(cjson.decode, raw)
  if not entryOk or type(entry) ~= "table" or type(entry.record) ~= "table" or
     type(entry.reference) ~= "string" or entry.reference ~= report.reference then
    return errorReply("MQ_CORRUPT_COUNTER")
  end
  if report.outcome ~= "completed" and report.outcome ~= "failed" and report.outcome ~= "cancelled" then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
end

local applied = 0
local firstFailure = nil
seen = {}
for _, report in ipairs(p.reports) do
  seen[report.childKey] = true
  local raw = redis.call("HGET", childrenKey, report.childKey)
  local entryOk, entry = pcall(cjson.decode, raw)
  if not entryOk or type(entry) ~= "table" or type(entry.record) ~= "table" then
    return errorReply("MQ_CORRUPT_COUNTER")
  end
  local child = entry.record
  if child.status == "pending" then
    child.status = report.outcome
    child.result = report.result
    child.failure = report.failure
    redis.call("HSET", childrenKey, report.childKey, cjson.encode(entry))
    redis.call("ZREM", pendingKey, report.reference)
    applied = applied + 1
    parent.flow.pending = parent.flow.pending - 1
    if report.outcome == "completed" then parent.flow.completed = parent.flow.completed + 1 end
    if report.outcome == "failed" then
      parent.flow.failed = parent.flow.failed + 1
      if firstFailure == nil then firstFailure = report.failure end
    end
    if report.outcome == "cancelled" then parent.flow.cancelled = parent.flow.cancelled + 1 end
  end
end

local parentSettled = false
if parent.state == "waiting-children" and parent.flow.failFast == true and firstFailure ~= nil then
  local all = redis.call("HGETALL", childrenKey)
  for index = 1, #all, 2 do
    local childKey = all[index]
    local raw = all[index + 1]
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
      parent.flow.pending = 0
      parent.flow.cancelled = parent.flow.cancelled + 1
    end
  end
  parent.state = "failed"
  parent.failure = firstFailure
  parentSettled = true
elseif parent.state == "waiting-children" and parent.flow.pending == 0 then
  parent.state = "waiting"
  parent.failure = nil
  parentSettled = true
end

redis.call("HSET", parentKey, "record", cjson.encode(parent))
local children = {}
local all = redis.call("HGETALL", childrenKey)
for index = 1, #all, 2 do
  local ok, entry = pcall(cjson.decode, all[index + 1])
  if not ok or type(entry) ~= "table" or type(entry.record) ~= "table" then
    return errorReply("MQ_CORRUPT_COUNTER")
  end
  children[#children + 1] = entry.record
end
return {"ok", "flow-record-child-results", tostring(applied), parentSettled and "1" or "0", cjson.encode(parent), cjson.encode(children)}
