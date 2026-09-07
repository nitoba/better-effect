-- MQ_SCHEDULES_READY
-- Compare-and-set a schedule and enqueue its deterministic occurrences in one unit.
local MAX = 9007199254740991
local declaredInputKeys = {}
for _, key in ipairs(KEYS) do declaredInputKeys[key] = true end

local function errorReply(code)
  return {"error", tostring(code)}
end

local function okReply(status, schedule, jobs, skipped, lastJobId)
  return {"ok", "tick-schedule", status, schedule, jobs, skipped, lastJobId or ""}
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

local function signedNumber(value)
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

local function validJson(value)
  if type(value) ~= "string" then return false end
  local ok = pcall(cjson.decode, value)
  return ok
end

local function keyTypeIs(key, expected)
  if type(key) ~= "string" or key == "" or not declaredInputKeys[key] then return false end
  local actual = redis.call("TYPE", key)
  if type(actual) == "table" then actual = actual.ok end
  return actual == "none" or actual == expected
end

local function rememberKey(seen, key, expected)
  if type(key) ~= "string" or key == "" then return false end
  if seen[key] ~= nil then return seen[key] == expected end
  if not keyTypeIs(key, expected) then return false end
  seen[key] = expected
  return true
end

local function fieldsToRecord(key)
  return redis.call("HGETALL", key)
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

local function validJob(item)
  local record = item.record
  if type(record) ~= "table" or type(item.keys) ~= "table" or type(item.id) ~= "string" then return false end
  if record.id ~= item.id or (record.state ~= "waiting" and record.state ~= "delayed") then return false end
  for key in pairs(record) do
    local known = {
    id=true, name=true, version=true, queue=true, dispatchKey=true, state=true, payload=true, metadata=true,
      priority=true, runAt=true, orderingSequence=true, attemptsMax=true, attemptsMade=true,
      attemptSequence=true, deliveryCount=true, stalledCount=true, backoff=true, timeoutMs=true,
      idempotencyKey=true, createdAt=true, updatedAt=true, processedAt=true, finishedAt=true,
      leaseOwner=true, leaseToken=true, leaseExpiresAt=true, cancellationRequestedAt=true,
      result=true, failure=true
    }
    if type(key) ~= "string" or not known[key] then return false end
  end
  for _, name in ipairs({"version", "runAt", "orderingSequence", "attemptsMax", "attemptsMade", "deliveryCount", "stalledCount", "createdAt", "updatedAt"}) do
    if safeNumber(record[name]) == nil then return false end
  end
  if signedNumber(record.priority) == nil then return false end
  if safeNumber(record.updatedAt) < safeNumber(record.createdAt) then return false end
  for _, name in ipairs({"id", "name", "queue", "payload", "metadata"}) do
    if type(record[name]) ~= "string" then return false end
  end
  if not validJson(record.payload) or not validJson(record.metadata) then return false end
  for _, name in ipairs({"attemptSequence", "timeoutMs", "processedAt", "finishedAt", "cancellationRequestedAt"}) do
    if record[name] ~= nil and safeNumber(record[name]) == nil then return false end
  end
  for _, name in ipairs({"backoff", "result", "failure"}) do
    if record[name] ~= nil and not validJson(record[name]) then return false end
  end
  if record.idempotencyKey ~= nil or record.leaseOwner ~= nil or record.leaseToken ~= nil or record.leaseExpiresAt ~= nil then return false end
  local expectedStateKey = record.state == "waiting" and "newWaiting" or "newDelayed"
  local expectedMemberKey = record.state == "waiting" and "newWaitingMember" or "newDelayedMember"
  if not item.keys[expectedStateKey] or type(item[expectedMemberKey]) ~= "string" then return false end
  if type(item.newCreatedMember) ~= "string" or type(item.newRunAtMember) ~= "string" or type(item.newFinishedMember) ~= "string" then return false end
  return true
end

local function scheduleKeysValid(keys)
  if type(keys) ~= "table" then return false end
  local seen = {}
  if not rememberKey(seen, keys.schedule, "hash") then return false end
  if not rememberKey(seen, keys.scheduleGroup, "set") then return false end
  if not rememberKey(seen, keys.scheduleGroups, "set") then return false end
  if not rememberKey(seen, keys.scheduleDue, "zset") then return false end
  if not rememberKey(seen, keys.all, "set") then return false end
  if not rememberKey(seen, keys.counts, "hash") then return false end
  if not rememberKey(seen, keys.wake, "hash") then return false end
  if not rememberKey(seen, keys.queueControls, "hash") then return false end
  if not rememberKey(seen, keys.sequenceJobs, "string") then return false end
  if type(keys.wakeChannel) ~= "string" or keys.wakeChannel == "" or not declaredInputKeys[keys.wakeChannel] then return false end
  if not rememberKey(seen, keys.created, "zset") or not rememberKey(seen, keys.runAt, "zset") or not rememberKey(seen, keys.finishedAt, "zset") then return false end
  if keys.overlapJob and not rememberKey(seen, keys.overlapJob, "hash") then return false end
  return true
end

local recordState

local function itemKeysValid(item)
  local keys = item.keys
  if type(keys) ~= "table" then return false end
  local seen = {}
  for _, name in ipairs({"job", "revision"}) do
    if not rememberKey(seen, keys[name], name == "job" and "hash" or "string") then return false end
  end
  for _, name in ipairs({"identities", "byQueue", "byIdentity", "byState"}) do
    if not rememberKey(seen, keys[name], "set") then return false end
  end
  if recordState(item) == "waiting" then
    if not rememberKey(seen, keys.newWaiting, "zset") then return false end
  else
    if not rememberKey(seen, keys.newDelayed, "zset") then return false end
  end
  return true
end

recordState = function(item)
  return item.record and item.record.state or ""
end

local function countersAvailable(keys, _queue, newCount)
  local states = {"waiting", "delayed", "active", "completed", "failed", "cancelled"}
  local total = safeNumber(redis.call("HGET", keys.counts, "total") or "0")
  if total == nil then return false end
  local sum, values = 0, {}
  for _, state in ipairs(states) do
    local value = safeNumber(redis.call("HGET", keys.counts, state) or "0")
    if value == nil or sum > MAX - value then return false end
    values[state] = value
    sum = sum + value
  end
  if sum ~= total or total > MAX - newCount then return false end
  return true
end

local function bumpWake(keys, queue, amount)
  if amount == 0 then return true end
  local old = safeNumber(redis.call("HGET", keys.wake, queue) or "0")
  if old == nil or old > MAX - amount then return false end
  local version = old + amount
  redis.call("HSET", keys.wake, queue, tostring(version))
  redis.pcall("PUBLISH", keys.wakeChannel, cjson.encode({queue=queue, version=version}))
  return true
end

local raw = ARGV[1]
if type(raw) ~= "string" or #raw > 1048576 then return errorReply("MQ_INVALID_ARGUMENT") end
local decoded, ok = nil, false
ok, decoded = pcall(cjson.decode, raw)
local p = ok and decoded or nil
if type(p) ~= "table" or p.mode ~= "tick-schedule" or type(p.keys) ~= "table" or not scheduleKeysValid(p.keys) then
  return errorReply("MQ_INVALID_ARGUMENT")
end
if type(p.expectedRevision) ~= "string" or type(p.expectedRunAtMs) ~= "string" or type(p.now) ~= "string" then
  return errorReply("MQ_INVALID_ARGUMENT")
end
local expectedRevision = safeNumber(p.expectedRevision)
local expectedRunAtMs = safeNumber(p.expectedRunAtMs)
local now = safeNumber(p.now)
local nextRunAtMs = p.nextRunAtMs and safeNumber(p.nextRunAtMs) or nil
if expectedRevision == nil or expectedRunAtMs == nil or now == nil or nextRunAtMs == nil or nextRunAtMs <= expectedRunAtMs then
  return errorReply("MQ_INVALID_ARGUMENT")
end
if type(p.items) ~= "table" or #p.items > 256 then return errorReply("MQ_BATCH_LIMIT") end
if type(p.skippedSlots) ~= "table" or #p.skippedSlots > 256 then return errorReply("MQ_BATCH_LIMIT") end
for _, slot in ipairs(p.skippedSlots) do if safeNumber(slot) == nil then return errorReply("MQ_INVALID_ARGUMENT") end end

local schedule = p.keys.schedule
if redis.call("EXISTS", schedule) == 0 then return errorReply("MQ_NOT_FOUND") end
local currentRevision = safeNumber(redis.call("HGET", schedule, "revision") or "")
local currentRunAt = safeNumber(redis.call("HGET", schedule, "nextRunAtMs") or "")
if currentRevision == nil or currentRunAt == nil then return errorReply("MQ_CORRUPT_SCHEDULE") end
local scheduleFields = fieldsToRecord(schedule)
if currentRevision ~= expectedRevision or currentRunAt ~= expectedRunAtMs then
  return okReply("stale", scheduleFields, {}, {}, redis.call("HGET", schedule, "lastJobId") or "")
end
if redis.call("HGET", schedule, "paused") == "1" then
  return okReply("paused", scheduleFields, {}, {}, redis.call("HGET", schedule, "lastJobId") or "")
end
local scheduleQueue = redis.call("HGET", schedule, "queue")
local scheduleOverlap = redis.call("HGET", schedule, "overlap")
if type(scheduleQueue) ~= "string" or scheduleQueue == "" or (scheduleOverlap ~= "allow" and scheduleOverlap ~= "skip") then
  return errorReply("MQ_CORRUPT_SCHEDULE")
end

local seenKeys = {}
local newItems, duplicateItems = {}, {}
for _, item in ipairs(p.items) do
  if not validJob(item) or not itemKeysValid(item) or item.record.queue ~= scheduleQueue then return errorReply("MQ_INVALID_ARGUMENT") end
  if safeNumber(item.slotMs) == nil or safeNumber(item.record.runAt) ~= safeNumber(item.slotMs) then return errorReply("MQ_INVALID_ARGUMENT") end
  if seenKeys[item.keys.job] then return errorReply("MQ_CONFLICT") end
  seenKeys[item.keys.job] = true
  if redis.call("EXISTS", item.keys.job) == 1 then
    if redis.call("HGET", item.keys.job, "id") ~= item.id then return errorReply("MQ_CONFLICT") end
    duplicateItems[#duplicateItems + 1] = item
  else
    newItems[#newItems + 1] = item
  end
end

local overlap = false
if scheduleOverlap == "skip" and p.keys.overlapJob then
  local state = redis.call("HGET", p.keys.overlapJob, "state")
  overlap = state == "waiting" or state == "delayed" or state == "active"
end
if overlap then
  duplicateItems = {}
  newItems = {}
end
if not countersAvailable(p.keys, scheduleQueue, #newItems) then return errorReply("MQ_CORRUPT_COUNTER") end
local sequence = safeNumber(redis.call("GET", p.keys.sequenceJobs) or "0")
if sequence == nil or sequence > MAX - #newItems then return errorReply("MQ_UNSAFE_INTEGER") end
local wake = safeNumber(redis.call("HGET", p.keys.wake, scheduleQueue) or "0")
if wake == nil or wake > MAX - #newItems then return errorReply("MQ_UNSAFE_INTEGER") end
if currentRevision >= MAX then return errorReply("MQ_UNSAFE_INTEGER") end

for _, item in ipairs(newItems) do
  local revisionKey = item.keys.revision
  local revision = safeNumber(redis.call("GET", revisionKey) or "0")
  if revision == nil or revision >= MAX then return errorReply("MQ_UNSAFE_INTEGER") end
end

local endingSequence = sequence + #newItems
local nextSequence = sequence
local jobs = {}
local firedLastId = ""
local lastScheduledAt = nil

for _, item in ipairs(p.items) do
  local selected = not overlap and (redis.call("EXISTS", item.keys.job) == 0)
  if overlap then
    -- The prior job is still running; every requested slot is an explicit skip.
  elseif selected then
    nextSequence = nextSequence + 1
    local record = item.record
    record.orderingSequence = tostring(nextSequence)
    local arguments = {}
    for key, value in pairs(record) do
      arguments[#arguments + 1] = key
      arguments[#arguments + 1] = tostring(value)
    end
    redis.call("HSET", item.keys.job, unpack(arguments))
    redis.call("SET", item.keys.revision, "1")
    redis.call("HSETNX", p.keys.queueControls, record.queue, "0")
    redis.call("SADD", item.keys.identities, item.identityMember)
    redis.call("SADD", p.keys.all, record.id)
    redis.call("SADD", item.keys.byQueue, record.id)
    redis.call("SADD", item.keys.byIdentity, record.id)
    redis.call("SADD", item.keys.byState, record.state == "waiting" and record.id or record.id)
    redis.call("HINCRBY", p.keys.counts, record.state, 1)
    redis.call("HINCRBY", p.keys.counts, "total", 1)
    if record.state == "waiting" then
      local member = replaceSequence(item.newWaitingMember, nextSequence)
      if not member then return errorReply("MQ_INVALID_ARGUMENT") end
      redis.call("ZADD", item.keys.newWaiting, -signedNumber(record.priority), member)
    else
      local member = replaceDelayedSequence(item.newDelayedMember, nextSequence)
      if not member then return errorReply("MQ_INVALID_ARGUMENT") end
      redis.call("ZADD", item.keys.newDelayed, safeNumber(record.runAt), member)
    end
    local createdMember = replaceSequence(item.newCreatedMember, nextSequence)
    local runAtMember = replaceSequence(item.newRunAtMember, nextSequence)
    local finishedMember = replaceSequence(item.newFinishedMember, nextSequence)
    if not createdMember or not runAtMember or not finishedMember then return errorReply("MQ_INVALID_ARGUMENT") end
    redis.call("ZADD", p.keys.created, 0, createdMember)
    redis.call("ZADD", p.keys.runAt, 0, runAtMember)
    redis.call("ZADD", p.keys.finishedAt, 0, finishedMember)
    jobs[#jobs + 1] = fieldsToRecord(item.keys.job)
    firedLastId = record.id
    local slot = safeNumber(item.slotMs)
    if lastScheduledAt == nil or slot > lastScheduledAt then lastScheduledAt = slot end
  elseif not overlap then
    jobs[#jobs + 1] = fieldsToRecord(item.keys.job)
    firedLastId = item.id
    local slot = safeNumber(item.slotMs)
    if lastScheduledAt == nil or slot > lastScheduledAt then lastScheduledAt = slot end
  end
end

if #newItems > 0 then redis.call("SET", p.keys.sequenceJobs, tostring(endingSequence)) end
if not bumpWake(p.keys, scheduleQueue, #newItems) then return errorReply("MQ_UNSAFE_INTEGER") end

local skipped = {}
for _, slot in ipairs(p.skippedSlots) do skipped[#skipped + 1] = slot end
if overlap then
  for _, item in ipairs(p.items) do skipped[#skipped + 1] = safeNumber(item.slotMs) end
end
local updatedRevision = currentRevision + 1
local lastJobId = redis.call("HGET", schedule, "lastJobId") or ""
local lastScheduledField = redis.call("HGET", schedule, "lastScheduledAtMs")
if lastScheduledAt ~= nil then
  lastJobId = firedLastId
  lastScheduledField = tostring(lastScheduledAt)
end
redis.call("HSET", schedule,
  "revision", tostring(updatedRevision),
  "nextRunAtMs", tostring(nextRunAtMs),
  "updatedAtMs", tostring(now),
  "lastJobId", lastJobId)
if lastScheduledField then redis.call("HSET", schedule, "lastScheduledAtMs", lastScheduledField) else redis.call("HDEL", schedule, "lastScheduledAtMs") end
redis.call("ZADD", p.keys.scheduleDue, nextRunAtMs, schedule)

return okReply(#jobs > 0 and "fired" or "skipped", fieldsToRecord(schedule), jobs, skipped, lastJobId)
