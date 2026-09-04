-- MQ_FOUNDATION_READY
-- Generic bounded Redis JobStore mutation protocol v1.
-- The TypeScript boundary supplies all dynamic keys in KEYS and an encoded request in ARGV[1].
local MAX = 9007199254740991
local declaredInputKeys = {}
for _, key in ipairs(KEYS) do declaredInputKeys[key] = true end
local raw, decoded = ARGV[1], nil
local ok, value = pcall(cjson.decode, raw or "")
if ok and type(value) == "table" then decoded = value end
local p = decoded
local replyName = p and p.reply or "redis"
local function errorReply(code)
  return {"error", tostring(code)}
end
local function okReply(status, ...)
  local result = {"ok", replyName, status}
  local values = {...}
  for index, value in ipairs(values) do
    if value ~= nil then result[#result + 1] = value end
  end
  return result
end
local function safeNumber(value, positive)
  local n
  if type(value) == "string" then
    if not string.match(value, "^0$") and not string.match(value, "^[1-9][0-9]*$") then return nil end
    n = tonumber(value)
  elseif type(value) == "number" then
    n = value
  else
    return nil
  end
  if not n or n < 0 or n > MAX or math.floor(n) ~= n or (positive and n == 0) then return nil end
  return n
end
local function validJson(value)
  if type(value) ~= "string" then return false end
  local ok = pcall(cjson.decode, value)
  return ok
end
local function safePriority(value)
  local n
  if type(value) == "string" then
    if not string.match(value, "^0$") and not string.match(value, "^-[1-9][0-9]*$") and not string.match(value, "^[1-9][0-9]*$") then return nil end
    n = tonumber(value)
  elseif type(value) == "number" then
    n = value
  else
    return nil
  end
  if not n or n < -MAX or n > MAX or math.floor(n) ~= n then return nil end
  return n
end
local function validRecord(record)
  if type(record) ~= "table" then return false end
  local knownFields = {
    id=true, name=true, version=true, queue=true, state=true, payload=true, metadata=true,
    priority=true, runAt=true, orderingSequence=true, attemptsMax=true, attemptsMade=true,
    attemptSequence=true, deliveryCount=true, stalledCount=true, backoff=true, timeoutMs=true,
    idempotencyKey=true, createdAt=true, updatedAt=true, processedAt=true, finishedAt=true,
    leaseOwner=true, leaseToken=true, leaseExpiresAt=true, cancellationRequestedAt=true,
    result=true, failure=true
  }
  for key in pairs(record) do
    if type(key) ~= "string" or not knownFields[key] then return false end
  end
  local states = {waiting=true, delayed=true, active=true, completed=true, failed=true, cancelled=true}
  if not states[record.state] then return false end
  for _, name in ipairs({"version", "runAt", "orderingSequence", "attemptsMax", "attemptsMade", "deliveryCount", "stalledCount", "createdAt", "updatedAt"}) do
    if safeNumber(record[name]) == nil then return false end
  end
  if safePriority(record.priority) == nil then return false end
  if safeNumber(record.updatedAt) < safeNumber(record.createdAt) then return false end
  for _, name in ipairs({"id", "name", "queue", "payload", "metadata"}) do
    if type(record[name]) ~= "string" then return false end
  end
  if not validJson(record.payload) or not validJson(record.metadata) then return false end
  for _, name in ipairs({"attemptSequence", "timeoutMs", "processedAt", "finishedAt", "leaseExpiresAt", "cancellationRequestedAt"}) do
    if record[name] ~= nil and safeNumber(record[name]) == nil then return false end
  end
  for _, name in ipairs({"backoff", "result", "failure"}) do
    if record[name] ~= nil and not validJson(record[name]) then return false end
  end
  for _, name in ipairs({"idempotencyKey", "leaseOwner", "leaseToken"}) do
    if record[name] ~= nil and type(record[name]) ~= "string" then return false end
  end
  if record.state == "active" then
    if type(record.leaseOwner) ~= "string" or type(record.leaseToken) ~= "string" or record.leaseExpiresAt == nil then return false end
  elseif record.leaseOwner ~= nil or record.leaseToken ~= nil or record.leaseExpiresAt ~= nil then
    return false
  end
  return true
end
local function keyTypeIs(key, expected)
  if type(key) ~= "string" or key == "" or not declaredInputKeys[key] then return false end
  local actual = redis.call("TYPE", key)
  if type(actual) == "table" then actual = actual.ok end
  return actual == "none" or actual == expected
end
local function keyTypesValid(item)
  local keys = item.keys
  if type(keys) ~= "table" then return false end
  if type(keys.wakeChannel) ~= "string" or keys.wakeChannel == "" or not declaredInputKeys[keys.wakeChannel] then return false end
  if keys.identities and (type(keys.identityMember) ~= "string" or keys.identityMember == "") then return false end
  local seen = {}
  local function check(name, expected)
    local key = keys[name]
    if key == nil then return true end
    if type(key) ~= "string" or key == "" then return false end
    if seen[key] ~= nil then return seen[key] == expected end
    if not keyTypeIs(key, expected) then return false end
    seen[key] = expected
    return true
  end
  for _, name in ipairs({"job", "settlement", "counts", "wake", "idempotency", "queueControls"}) do
    if not check(name, "hash") then return false end
  end
  if not check("attempts", "list") then return false end
  for _, name in ipairs({"all", "byQueue", "byIdentity", "identities", "byState", "oldByState"}) do
    if not check(name, "set") then return false end
  end
  for _, name in ipairs({"oldWaiting", "oldDelayed", "newWaiting", "newDelayed", "active", "created", "runAt", "finishedAt"}) do
    if not check(name, "zset") then return false end
  end
  for _, name in ipairs({"sequenceJobs", "revision"}) do
    if not check(name, "string") then return false end
  end
  return true
end

local function field(key, name)
  return redis.call("HGET", key, name)
end
local function fixed(value)
  return string.format("%016d", value)
end
local function replaceSequence(template, sequence)
  if type(template) ~= "string" or #template < 34 then return nil end
  return string.sub(template, 1, 17) .. fixed(sequence) .. string.sub(template, 34)
end
local function replaceDelayedSequence(template, sequence)
  if type(template) ~= "string" or #template < 17 then return nil end
  return fixed(sequence) .. string.sub(template, 17)
end
local function bump(item)
  local keys = item.keys
  if not keys or not keys.wake or not item.queue then return nil end
  local old = safeNumber(redis.call("HGET", keys.wake, item.queue) or "0")
  if old == nil or old >= MAX then return nil end
  local version = old + 1
  redis.call("HSET", keys.wake, item.queue, tostring(version))
  if keys.wakeChannel then
    redis.pcall("PUBLISH", keys.wakeChannel, cjson.encode({queue=item.queue, version=version}))
  end
  return version
end
local function expectedMatches(item, job)
  if item.expected then
    for key, expected in pairs(item.expected) do
      if redis.call("HGET", job, key) ~= tostring(expected) then return false end
    end
  end
  if item.expectedRevision and item.keys and item.keys.revision then
    if (redis.call("GET", item.keys.revision) or "0") ~= tostring(item.expectedRevision) then return false end
  end
  return true
end
local function wakeAvailable(item)
  if not item.keys or not item.keys.wake or not item.queue then return false end
  local old = safeNumber(redis.call("HGET", item.keys.wake, item.queue) or "0")
  return old ~= nil and old < MAX
end
local function revisionAvailable(item)
  if not item.keys or not item.keys.revision then return false end
  local old = safeNumber(redis.call("GET", item.keys.revision) or "0")
  return old ~= nil and old < MAX
end
local function countersAvailable(item, mode)
  local counts = item.keys and item.keys.counts
  if not counts or not item.record or not item.record.state then return false end
  local states = {"waiting", "delayed", "active", "completed", "failed", "cancelled"}
  local values, total, sum = {}, safeNumber(redis.call("HGET", counts, "total") or "0"), 0
  if total == nil then return false end
  for _, name in ipairs(states) do
    local value = safeNumber(redis.call("HGET", counts, name) or "0")
    if value == nil or sum > MAX - value then return false end
    values[name] = value
    sum = sum + value
  end
  if sum ~= total then return false end
  local state = values[item.record.state]
  if state == nil then return false end
  if mode == "enqueue" then return total < MAX and state < MAX end
  if mode == "remove" then return total > 0 and state > 0 end
  if item.previousState and item.previousState ~= item.record.state then
    local previous = values[item.previousState]
    return previous ~= nil and previous > 0 and state < MAX
  end
  return true
end
local function removeSchedule(item, id)
  local keys = item.keys
  if keys.oldWaiting and item.oldWaitingMember then redis.call("ZREM", keys.oldWaiting, item.oldWaitingMember) end
  if keys.oldDelayed and item.oldDelayedMember then redis.call("ZREM", keys.oldDelayed, item.oldDelayedMember) end
  if keys.active then redis.call("ZREM", keys.active, id) end
  if keys.created and keys.oldCreatedMember then redis.call("ZREM", keys.created, keys.oldCreatedMember) end
  if keys.runAt and keys.oldRunAtMember then redis.call("ZREM", keys.runAt, keys.oldRunAtMember) end
  if keys.finishedAt and keys.oldFinishedMember then redis.call("ZREM", keys.finishedAt, keys.oldFinishedMember) end
end
local function addSchedule(item, record)
  local keys = item.keys
  if keys.created and keys.newCreatedMember then redis.call("ZADD", keys.created, 0, keys.newCreatedMember) end
  if keys.runAt and keys.newRunAtMember then redis.call("ZADD", keys.runAt, 0, keys.newRunAtMember) end
  if keys.finishedAt and keys.newFinishedMember then redis.call("ZADD", keys.finishedAt, 0, keys.newFinishedMember) end
  local state = record.state
  if state == "waiting" and keys.newWaiting and item.newWaitingMember then
    redis.call("ZADD", keys.newWaiting, -safePriority(record.priority), item.newWaitingMember)
  elseif state == "delayed" and keys.newDelayed and item.newDelayedMember then
    redis.call("ZADD", keys.newDelayed, safeNumber(record.runAt), item.newDelayedMember)
  elseif state == "active" and keys.active and record.leaseExpiresAt then
    redis.call("ZADD", keys.active, safeNumber(record.leaseExpiresAt), record.id)
  end
end
local function setRecord(item, mode)
  local keys, record = item.keys, item.record
  if type(keys) ~= "table" or type(item.queue) ~= "string" or item.queue == "" or
    (keys.wakeChannel ~= nil and type(keys.wakeChannel) ~= "string") then
    return "invalid"
  end
  local job = keys.job
  if not validRecord(record) or not keyTypesValid(item) then return "invalid" end
  if mode ~= "enqueue" and item.settlementToken and keys.settlement then
    local existingToken = redis.call("HGET", keys.settlement, "token")
    if existingToken == item.settlementToken then
      if redis.call("HGET", keys.settlement, "digest") ~= (item.settlementDigest or "") then return "settlement-conflict" end
      return "already"
    end
  end
  if mode ~= "enqueue" and redis.call("EXISTS", job) == 0 then return "conflict" end
  if mode ~= "enqueue" and not expectedMatches(item, job) then return "conflict" end
  if mode == "enqueue" then
    if item.idempotencyKey and item.idempotencyKey ~= "" and keys.idempotency then
      local existing = redis.call("HGET", keys.idempotency, item.idempotencyKey)
      if existing then return "duplicate:" .. existing end
    end
    if redis.call("EXISTS", job) == 1 then return "duplicate:" .. (redis.call("HGET", job, "id") or record.id) end
  end
  if not wakeAvailable(item) or not revisionAvailable(item) then return "unsafe" end
  if not countersAvailable(item, mode) then return "corrupt" end
  local previousState = item.previousState
  local allocatedSequence = nil
  if mode ~= "enqueue" and previousState ~= record.state and (record.state == "waiting" or record.state == "delayed") then
    local currentSequence = safeNumber(redis.call("GET", keys.sequenceJobs) or "0")
    if currentSequence == nil or currentSequence >= MAX then return "unsafe" end
    allocatedSequence = currentSequence + 1
    record.orderingSequence = tostring(allocatedSequence)
    keys.newCreatedMember = replaceSequence(keys.newCreatedMember, allocatedSequence)
    keys.newRunAtMember = replaceSequence(keys.newRunAtMember, allocatedSequence)
    if not keys.newCreatedMember or not keys.newRunAtMember then return "invalid" end
    if record.state == "waiting" then
      item.newWaitingMember = replaceSequence(item.newWaitingMember, allocatedSequence)
      if not item.newWaitingMember then return "invalid" end
    else
      item.newDelayedMember = replaceDelayedSequence(item.newDelayedMember, allocatedSequence)
      if not item.newDelayedMember then return "invalid" end
    end
    keys.newFinishedMember = replaceSequence(keys.newFinishedMember, allocatedSequence)
    if not keys.newFinishedMember then return "invalid" end
  end
  if mode ~= "enqueue" then
    removeSchedule(item, record.id)
    if previousState and previousState ~= record.state and keys.oldByState then
      redis.call("SREM", keys.oldByState, record.id)
    end
  end
  local oldFields = redis.call("HKEYS", job)
  for _, key in ipairs(oldFields) do
    if record[key] == nil then redis.call("HDEL", job, key) end
  end
  local arguments = {}
  for key, value in pairs(record) do
    arguments[#arguments + 1] = key
    arguments[#arguments + 1] = tostring(value)
  end
  if #arguments > 0 then redis.call("HSET", job, unpack(arguments)) end
  if keys.queueControls then redis.call("HSETNX", keys.queueControls, record.queue, "0") end
  if keys.all then redis.call("SADD", keys.all, record.id) end
  if keys.byQueue then redis.call("SADD", keys.byQueue, record.id) end
  if keys.byIdentity then redis.call("SADD", keys.byIdentity, record.id) end
  if keys.identities and keys.identityMember then redis.call("SADD", keys.identities, keys.identityMember) end
  if keys.byState then redis.call("SADD", keys.byState, record.id) end
  if mode == "enqueue" and item.idempotencyKey and item.idempotencyKey ~= "" and keys.idempotency then
    redis.call("HSET", keys.idempotency, item.idempotencyKey, record.id)
  end
  if item.attempt and item.attempt ~= "" and keys.attempts then redis.call("RPUSH", keys.attempts, item.attempt) end
  if item.settlementToken and item.settlementToken ~= "" and keys.settlement then
    redis.call("HSET", keys.settlement, "token", item.settlementToken, "digest", item.settlementDigest or "", "attempt", item.settlementAttempt or "")
  elseif mode ~= "enqueue" and (record.state == "waiting" or record.state == "delayed") and keys.settlement then
    -- A new delivery must never inherit the acknowledgement of an old lease.
    redis.call("DEL", keys.settlement)
  end
  addSchedule(item, record)
  if allocatedSequence ~= nil then redis.call("SET", keys.sequenceJobs, tostring(allocatedSequence)) end
  redis.call("SET", keys.revision, tostring((safeNumber(redis.call("GET", keys.revision) or "0") or 0) + 1))
  if previousState and previousState ~= record.state and keys.counts then
    redis.call("HINCRBY", keys.counts, previousState, -1)
    redis.call("HINCRBY", keys.counts, record.state, 1)
  elseif mode == "enqueue" and keys.counts then
    redis.call("HINCRBY", keys.counts, record.state, 1)
    redis.call("HINCRBY", keys.counts, "total", 1)
  end
  local version = bump(item)
  if version == nil then return "unsafe" end
  if allocatedSequence ~= nil then
    return "applied:" .. record.id .. ":" .. tostring(version) .. ":" .. tostring(allocatedSequence)
  end
  return "applied:" .. record.id .. ":" .. tostring(version)
end
local function removeRecord(item)
  local keys, record = item.keys, item.record
  if type(keys) ~= "table" or type(item.queue) ~= "string" or item.queue == "" or
    (keys.wakeChannel ~= nil and type(keys.wakeChannel) ~= "string") then
    return "invalid"
  end
  local job = keys.job
  if not validRecord(record) or not keyTypesValid(item) then return "invalid" end
  if redis.call("EXISTS", job) == 0 then return "missing" end
  if not expectedMatches(item, job) then return "conflict" end
  if not wakeAvailable(item) or not revisionAvailable(item) then return "unsafe" end
  if not countersAvailable(item, "remove") then return "corrupt" end
  removeSchedule(item, record.id)
  for _, key in ipairs({keys.all, keys.byQueue, keys.byIdentity, keys.byState}) do
    if key then redis.call("SREM", key, record.id) end
  end
  if keys.idempotency and item.idempotencyKey and item.idempotencyKey ~= "" then
    local mapped = redis.call("HGET", keys.idempotency, item.idempotencyKey)
    if mapped == record.id or mapped == keys.job then redis.call("HDEL", keys.idempotency, item.idempotencyKey) end
  end
  if keys.counts and record.state then
    redis.call("HINCRBY", keys.counts, record.state, -1)
    redis.call("HINCRBY", keys.counts, "total", -1)
  end
  redis.call("DEL", job)
  if keys.attempts then redis.call("DEL", keys.attempts) end
  if keys.settlement then redis.call("DEL", keys.settlement) end
  redis.call("SET", keys.revision, tostring((safeNumber(redis.call("GET", keys.revision) or "0") or 0) + 1))
  local version = bump(item)
  if version == nil then return "unsafe" end
  return "removed:" .. record.id .. ":" .. tostring(version)
end
local function enqueueItem(item)
  local result = setRecord(item, "enqueue")
  if result == "unsafe" then return errorReply("MQ_UNSAFE_INTEGER") end
  if result == "corrupt" then return errorReply("MQ_CORRUPT_COUNTER") end
  if result == "invalid" then return errorReply("MQ_INVALID_ARGUMENT") end
  if result == "conflict" then return errorReply("MQ_CONFLICT") end
  if result == "missing" then return okReply("missing") end
  if result:sub(1, 10) == "duplicate:" then return okReply("duplicate", result:sub(11)) end
  local id, version = result:match("^applied:(.*):(%d+)$")
  return okReply("applied", id, version)
end
if not p then return errorReply("MQ_INVALID_ARGUMENT") end
if not p.mode or p.mode ~= "write" then return errorReply("MQ_INVALID_ARGUMENT") end
if p.mode == "enqueue" then return enqueueItem(p) end
if p.mode == "enqueue-many" then
  if type(p.items) ~= "table" or #p.items > 128 then return errorReply("MQ_BATCH_LIMIT") end
  local output = {"ok", replyName, "batch"}
  for index, item in ipairs(p.items) do
    local result = enqueueItem(item)
    output[#output + 1] = result
  end
  return output
end
if p.mode == "remove" then
  local result = removeRecord(p)
  if result == "unsafe" then return errorReply("MQ_UNSAFE_INTEGER") end
  if result == "corrupt" then return errorReply("MQ_CORRUPT_COUNTER") end
  if result == "invalid" then return errorReply("MQ_INVALID_ARGUMENT") end
  if result == "conflict" then return errorReply("MQ_CONFLICT") end
  if result == "missing" then return okReply("missing") end
  local id, version = result:match("^removed:(.*):(%d+)$")
  return okReply("removed", id, version)
end
if p.mode == "write" then
  local result = setRecord(p, "write")
  if result == "settlement-conflict" then return errorReply("MQ_SETTLEMENT_CONFLICT") end
  if result == "already" then
    local latest = redis.call("LRANGE", p.keys.attempts, "-1", "-1")
    return okReply("already", redis.call("HGETALL", p.keys.job), latest[1] or "", redis.call("HGET", p.keys.settlement, "attempt") or "")
  end
  if result == "unsafe" then return errorReply("MQ_UNSAFE_INTEGER") end
  if result == "corrupt" then return errorReply("MQ_CORRUPT_COUNTER") end
  if result == "invalid" then return errorReply("MQ_INVALID_ARGUMENT") end
  if result == "conflict" then return errorReply("MQ_CONFLICT") end
  local id, version, sequence = result:match("^applied:(.*):(%d+):(%d+)$")
  if id then return okReply("applied", id, version, sequence) end
  id, version = result:match("^applied:(.*):(%d+)$")
  if id then return okReply("applied", id, version) end
  return errorReply("MQ_INVALID_ARGUMENT")
end
if p.mode == "pause" or p.mode == "resume" then
  local keys = p.keys
  if type(keys) ~= "table" or not keys.queueControls or not keys.wake or type(keys.wakeChannel) ~= "string" or not declaredInputKeys[keys.wakeChannel] or type(p.queue) ~= "string" or p.queue == "" or
    not keyTypeIs(keys.queueControls, "hash") or not keyTypeIs(keys.wake, "hash") then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
  if not wakeAvailable(p) then return errorReply("MQ_UNSAFE_INTEGER") end
  redis.call("HSET", keys.queueControls, p.queue, p.paused and "1" or "0")
  local version = bump(p)
  if version == nil then return errorReply("MQ_UNSAFE_INTEGER") end
  return okReply("applied", p.queue, version)
end
if p.mode == "heartbeat" then
  if type(p.items) ~= "table" or #p.items > 128 then return errorReply("MQ_BATCH_LIMIT") end
  local renewed, lost, requested = {}, {}, {}
  local now, duration = safeNumber(p.now), safeNumber(p.duration, true)
  if not now or not duration or now > MAX - duration then return errorReply("MQ_INVALID_ARGUMENT") end
  for _, item in ipairs(p.items) do
    local job = item.keys.job
    local id = redis.call("HGET", job, "id")
    local token = redis.call("HGET", job, "leaseToken")
    local expiry = safeNumber(redis.call("HGET", job, "leaseExpiresAt") or "")
    if not id or redis.call("HGET", job, "state") ~= "active" or token ~= item.token then
      lost[#lost + 1] = {id or item.jobId, item.token, "mismatched-token"}
    elseif not expiry or now >= expiry then
      lost[#lost + 1] = {id, item.token, "expired-lease"}
    elseif redis.call("HEXISTS", job, "cancellationRequestedAt") == 1 then
      requested[#requested + 1] = id
    else
      local nextExpiry = now + duration
      redis.call("HSET", job, "leaseExpiresAt", tostring(nextExpiry), "updatedAt", tostring(now))
      if item.keys.active then redis.call("ZADD", item.keys.active, nextExpiry, id) end
      renewed[#renewed + 1] = {id, item.token, tostring(nextExpiry)}
    end
  end
  return {"ok", replyName, "heartbeat", renewed, lost, requested}
end
return errorReply("MQ_INVALID_ARGUMENT")
