-- MQ_FOUNDATION_READY
-- Atomic all-or-nothing enqueue batch. All validation that can be done by the
-- caller is performed before this script; this script reserves sequences and
-- commits every job, index, counter, idempotency mapping, and wake version in
-- one Redis transaction.
local MAX = 9007199254740991
local MAX_ITEMS = 128
local declaredInputKeys = {}
for _, key in ipairs(KEYS) do declaredInputKeys[key] = true end
local function errorReply(code) return {"error", tostring(code)} end
local function integer(value)
  local number
  if type(value) == "string" then
    if not string.match(value, "^0$") and not string.match(value, "^[1-9][0-9]*$") then return nil end
    number = tonumber(value)
  elseif type(value) == "number" then
    number = value
  else
    return nil
  end
  if not number or number < 0 or number > MAX or math.floor(number) ~= number then return nil end
  return number
end
local function signedInteger(value)
  local number
  if type(value) == "string" then
    if not string.match(value, "^0$") and not string.match(value, "^-[1-9][0-9]*$") and not string.match(value, "^[1-9][0-9]*$") then return nil end
    number = tonumber(value)
  elseif type(value) == "number" then
    number = value
  else
    return nil
  end
  if not number or number < -MAX or number > MAX or math.floor(number) ~= number then return nil end
  return number
end
local function fixed(value) return string.format("%016d", value) end
local function encodeSequence(template, sequence)
  if type(template) ~= "string" or #template < 33 then return nil end
  return string.sub(template, 1, 17) .. fixed(sequence) .. string.sub(template, 34)
end
local function encodeDelayed(template, sequence)
  if type(template) ~= "string" or #template < 17 then return nil end
  return fixed(sequence) .. string.sub(template, 17)
end
local function mappedJob(p, item, mapped)
  if type(mapped) ~= "string" or mapped == "" then return nil end
  -- The caller resolves both current full-key and legacy raw-id mappings
  -- before invocation. Consult that manifest first so raw IDs beginning with
  -- the full-key prefix cannot be mistaken for full keys.
  if type(p.declaredMappings) == "table" then
    local resolved = p.declaredMappings[item.jobPrefix .. "\000" .. mapped]
    if type(resolved) == "string" then return resolved end
  end
  if string.sub(mapped, 1, #item.jobPrefix) == item.jobPrefix then return mapped end
  return nil
end
local function declaredMappedJob(p, item, mapped)
  if mapped == nil or mapped == false then return nil end
  local job = mappedJob(p, item, mapped)
  if not job then return nil, "retry" end
  if type(p.declaredJobs) ~= "table" or p.declaredJobs[job] ~= true or not declaredInputKeys[job] then
    return nil, "retry"
  end
  return job
end
local function jobFields(job)
  return redis.call("HGETALL", job)
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
local physicalKeys = {}
local function rememberKey(key, expected)
  if type(key) ~= "string" or key == "" then return false end
  if physicalKeys[key] ~= nil then return physicalKeys[key] == expected end
  if not keyTypeIs(key, expected) then return false end
  physicalKeys[key] = expected
  return true
end
local function keyTypesValid(item)
  local keys = item.keys
  for _, name in ipairs({"job", "attempts", "settlement", "counts", "wake", "idempotency", "queueControls"}) do
    local expected = name == "attempts" and "list" or name == "job" and "hash" or name == "settlement" and "hash" or "hash"
    if keys[name] and not rememberKey(keys[name], expected) then return false end
  end
  if type(keys.wakeChannel) ~= "string" or keys.wakeChannel == "" or not declaredInputKeys[keys.wakeChannel] then return false end
  for _, name in ipairs({"all", "byQueue", "byIdentity", "byState", "identities"}) do
    if keys[name] and not rememberKey(keys[name], "set") then return false end
  end
  for _, name in ipairs({"newWaiting", "newDelayed", "created", "runAt", "finishedAt"}) do
    if keys[name] and not rememberKey(keys[name], "zset") then return false end
  end
  for _, name in ipairs({"sequenceJobs", "revision"}) do
    if keys[name] and not rememberKey(keys[name], "string") then return false end
  end
  return true
end
local function validRecord(item)
  local record, keys = item.record, item.keys
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
  if record.state ~= "waiting" and record.state ~= "delayed" then return false end
  if type(record.id) ~= "string" or record.id == "" or type(record.name) ~= "string" or record.name == "" or type(record.queue) ~= "string" or record.queue == "" then return false end
  if type(record.payload) ~= "string" or not validJson(record.payload) or type(record.metadata) ~= "string" or not validJson(record.metadata) then return false end
  local numeric = {"version", "runAt", "orderingSequence", "attemptsMax", "attemptsMade", "deliveryCount", "stalledCount", "createdAt", "updatedAt"}
  for _, field in ipairs(numeric) do if integer(record[field]) == nil then return false end end
  if signedInteger(record.priority) == nil then return false end
  for _, field in ipairs({"attemptSequence", "timeoutMs", "processedAt", "finishedAt", "cancellationRequestedAt", "leaseExpiresAt"}) do
    if record[field] ~= nil and integer(record[field]) == nil then return false end
  end
  for _, field in ipairs({"backoff", "result", "failure"}) do
    if record[field] ~= nil and (type(record[field]) ~= "string" or not validJson(record[field])) then return false end
  end
  for _, field in ipairs({"idempotencyKey", "leaseOwner", "leaseToken"}) do
    if record[field] ~= nil and type(record[field]) ~= "string" then return false end
  end
  if not encodeSequence(keys.newCreatedMember, 0) or not encodeSequence(keys.newRunAtMember, 0) or not encodeSequence(keys.newFinishedMember, 0) then return false end
  if record.state == "waiting" and not encodeSequence(item.newWaitingMember, 0) then return false end
  if record.state == "delayed" and not encodeDelayed(item.newDelayedMember, 0) then return false end
  return true
end
if type(ARGV[1]) ~= "string" or #ARGV[1] > 524288 then return errorReply("MQ_BATCH_LIMIT") end
local ok, p = pcall(cjson.decode, ARGV[1])
if not ok or type(p) ~= "table" or p.mode ~= "enqueue-many" or type(p.items) ~= "table" or
  type(p.declaredJobs) ~= "table" or type(p.declaredMappings) ~= "table" or
  type(p.wakeChannel) ~= "string" or p.wakeChannel == "" or not declaredInputKeys[p.wakeChannel] then
  return errorReply("MQ_INVALID_ARGUMENT")
end
local count = #p.items
if count > MAX_ITEMS then return errorReply("MQ_BATCH_LIMIT") end
local seenJobs, seenMappings = {}, {}
local newItems, wakeCounts, wakeKeys = {}, {}, {}
local sharedKeyNames = {"all", "counts", "wake", "wakeChannel", "queueControls", "active", "sequenceJobs", "created", "runAt", "finishedAt"}
local sharedKeys = {}
local sequenceKey = nil
for index, item in ipairs(p.items) do
  if type(item) ~= "table" or type(item.keys) ~= "table" or type(item.record) ~= "table" or type(item.queue) ~= "string" or type(item.jobPrefix) ~= "string" or type(item.encodedId) ~= "string" then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
  local keys = item.keys
  if index == 1 then
    for _, name in ipairs(sharedKeyNames) do sharedKeys[name] = keys[name] end
  else
    for _, name in ipairs(sharedKeyNames) do
      if keys[name] ~= sharedKeys[name] then return errorReply("MQ_INVALID_ARGUMENT") end
    end
  end
  if keys.wakeChannel ~= p.wakeChannel then return errorReply("MQ_INVALID_ARGUMENT") end
  if item.jobPrefix .. item.encodedId ~= keys.job then return errorReply("MQ_INVALID_ARGUMENT") end
  if item.idempotencyKey ~= nil and type(item.idempotencyKey) ~= "string" then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
  if item.idempotencyKey and item.idempotencyKey ~= "" and not keys.idempotency then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
  if not keyTypesValid(item) then return errorReply("MQ_INVALID_ARGUMENT") end
  if not keys.job or not keys.all or not keys.byQueue or not keys.byIdentity or not keys.identities or not keys.identityMember or not keys.byState or not keys.counts or not keys.wake or not keys.queueControls or not keys.sequenceJobs or not keys.revision or not keys.created or not keys.runAt or not keys.finishedAt or not keys.newCreatedMember or not keys.newRunAtMember or not keys.newFinishedMember then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
  if item.record.state == "waiting" and (not keys.newWaiting or not item.newWaitingMember) then return errorReply("MQ_INVALID_ARGUMENT") end
  if item.record.state == "delayed" and (not keys.newDelayed or not item.newDelayedMember) then return errorReply("MQ_INVALID_ARGUMENT") end
  sequenceKey = sequenceKey or keys.sequenceJobs
  if sequenceKey ~= keys.sequenceJobs then return errorReply("MQ_INVALID_ARGUMENT") end
  local job = keys.job
  local existingJob, plannedDuplicate = nil, nil
  if seenJobs[job] ~= nil then
    if item.explicitId then plannedDuplicate = seenJobs[job] else return errorReply("MQ_GENERATED_ID_COLLISION") end
  elseif item.explicitId then
    if redis.call("EXISTS", job) == 1 then existingJob = job end
  elseif item.idempotencyKey and item.idempotencyKey ~= "" then
    if not keys.idempotency then return errorReply("MQ_INVALID_ARGUMENT") end
    local mappingKey = keys.idempotency .. "\000" .. item.idempotencyKey
    plannedDuplicate = seenMappings[mappingKey]
    if not plannedDuplicate then
      local mapped = redis.call("HGET", keys.idempotency, item.idempotencyKey)
      local mappingProblem
      existingJob, mappingProblem = declaredMappedJob(p, item, mapped)
      if mappingProblem == "retry" then return errorReply("MQ_ENQUEUE_RETRY") end
      if mappingProblem == "corrupt" then return errorReply("MQ_CORRUPT_JOB") end
      if existingJob and redis.call("EXISTS", existingJob) == 0 then existingJob = nil end
    end
    if not existingJob and redis.call("EXISTS", job) == 1 then return errorReply("MQ_GENERATED_ID_COLLISION") end
  elseif redis.call("EXISTS", job) == 1 then
    return errorReply("MQ_GENERATED_ID_COLLISION")
  end
  if existingJob then
    if not rememberKey(existingJob, "hash") then return errorReply("MQ_INVALID_ARGUMENT") end
    item.existingJob = existingJob
  elseif plannedDuplicate then
    item.duplicateOf = plannedDuplicate
  else
    local sequence = integer(item.record.orderingSequence)
    if sequence == nil then return errorReply("MQ_INVALID_ARGUMENT") end
    newItems[#newItems + 1] = item
    seenJobs[job] = item
    wakeCounts[item.queue] = (wakeCounts[item.queue] or 0) + 1
    wakeKeys[item.queue] = keys.wake
    if item.idempotencyKey and item.idempotencyKey ~= "" then
      local mappingKey = keys.idempotency .. "\000" .. item.idempotencyKey
      if seenMappings[mappingKey] then return errorReply("MQ_CONFLICT") end
      seenMappings[mappingKey] = item
    end
  end
end
if sequenceKey == nil then return {"ok", "enqueue-many", "batch"} end
local existingFields = {}
for _, item in ipairs(p.items) do
  if item.existingJob then
    local fields = jobFields(item.existingJob)
    if #fields == 0 or type(redis.call("HGET", item.existingJob, "id")) ~= "string" then return errorReply("MQ_CONFLICT") end
    existingFields[item.existingJob] = fields
  elseif not item.duplicateOf and not validRecord(item) then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
end
local currentSequence = integer(redis.call("GET", sequenceKey) or "0")
if not currentSequence or currentSequence > MAX - #newItems then return errorReply("MQ_UNSAFE_INTEGER") end
-- Validate every wake counter before the first write. A script cannot roll
-- back an already-incremented counter when a later overflow is discovered.
for queue, amount in pairs(wakeCounts) do
  local old = integer(redis.call("HGET", wakeKeys[queue], queue) or "0")
  if not old or old > MAX - amount then return errorReply("MQ_UNSAFE_INTEGER") end
end
local counterStates = {"waiting", "delayed", "active", "completed", "failed", "cancelled"}
local counterValues, counterTotal, counterSum = {}, integer(redis.call("HGET", p.items[1].keys.counts, "total") or "0"), 0
if not counterTotal then return errorReply("MQ_CORRUPT_COUNTER") end
for _, state in ipairs(counterStates) do
  local value = integer(redis.call("HGET", p.items[1].keys.counts, state) or "0")
  if not value or counterSum > MAX - value then return errorReply("MQ_CORRUPT_COUNTER") end
  counterValues[state] = value
  counterSum = counterSum + value
end
if counterSum ~= counterTotal then return errorReply("MQ_CORRUPT_COUNTER") end
for _, item in ipairs(newItems) do
  local state = item.record.state
  local nextValue = counterValues[state] + 1
  if nextValue > MAX then return errorReply("MQ_CORRUPT_COUNTER") end
  counterValues[state] = nextValue
end
if counterTotal > MAX - #newItems then return errorReply("MQ_CORRUPT_COUNTER") end
for _, item in ipairs(newItems) do
  local old = integer(redis.call("GET", item.keys.revision) or "0")
  if not old or old >= MAX then return errorReply("MQ_UNSAFE_INTEGER") end
end
-- Reserve all new ordering sequences only after every duplicate/conflict check.
local endingSequence = currentSequence
if #newItems > 0 then endingSequence = redis.call("INCRBY", sequenceKey, #newItems) end
local output = {"ok", "enqueue-many", "batch"}
local nextSequence = currentSequence
for index, item in ipairs(p.items) do
  local record = item.record
  local job = item.keys.job
  if item.existingJob then
    local fields = existingFields[item.existingJob]
    output[#output + 1] = {"duplicate", redis.call("HGET", item.existingJob, "id"), fields}
  elseif item.duplicateOf then
    local source = item.duplicateOf
    local sourceJob = source.keys.job
    output[#output + 1] = {"duplicate", redis.call("HGET", sourceJob, "id"), jobFields(sourceJob)}
  else
    nextSequence = nextSequence + 1
    if nextSequence > endingSequence then return errorReply("MQ_UNSAFE_INTEGER") end
    record.orderingSequence = nextSequence
    local arguments = {}
    for key, value in pairs(record) do
      arguments[#arguments + 1] = key
      arguments[#arguments + 1] = tostring(value)
    end
    redis.call("HSET", job, unpack(arguments))
    redis.call("HSETNX", item.keys.queueControls, record.queue, "0")
    redis.call("SADD", item.keys.identities, item.keys.identityMember)
    redis.call("SET", item.keys.revision, tostring((integer(redis.call("GET", item.keys.revision) or "0") or 0) + 1))
    redis.call("SADD", item.keys.all, record.id)
    redis.call("SADD", item.keys.byQueue, record.id)
    redis.call("SADD", item.keys.byIdentity, record.id)
    redis.call("SADD", item.keys.byState, record.id)
    redis.call("HINCRBY", item.keys.counts, record.state, 1)
    redis.call("HINCRBY", item.keys.counts, "total", 1)
    if item.idempotencyKey and item.idempotencyKey ~= "" then
      redis.call("HSET", item.keys.idempotency, item.idempotencyKey, item.jobPrefix .. item.encodedId)
    end
    if record.state == "waiting" then
      local member = encodeSequence(item.newWaitingMember, nextSequence)
      if not member then return errorReply("MQ_INVALID_ARGUMENT") end
      redis.call("ZADD", item.keys.newWaiting, -signedInteger(record.priority), member)
    elseif record.state == "delayed" then
      local member = encodeDelayed(item.newDelayedMember, nextSequence)
      if not member then return errorReply("MQ_INVALID_ARGUMENT") end
      redis.call("ZADD", item.keys.newDelayed, integer(record.runAt), member)
    end
    local createdMember = encodeSequence(item.keys.newCreatedMember, nextSequence)
    local runAtMember = encodeSequence(item.keys.newRunAtMember, nextSequence)
    if not createdMember or not runAtMember then return errorReply("MQ_INVALID_ARGUMENT") end
    redis.call("ZADD", item.keys.created, 0, createdMember)
    redis.call("ZADD", item.keys.runAt, 0, runAtMember)
    local finishedMember = encodeSequence(item.keys.newFinishedMember, nextSequence)
    if not finishedMember then return errorReply("MQ_INVALID_ARGUMENT") end
    redis.call("ZADD", item.keys.finishedAt, 0, finishedMember)
    output[#output + 1] = {"applied", record.id, jobFields(job)}
  end
end
for queue, amount in pairs(wakeCounts) do
  local version = integer(redis.call("HGET", wakeKeys[queue], queue) or "0") + amount
  redis.call("HSET", wakeKeys[queue], queue, tostring(version))
  local channel = p.wakeChannel
  if channel then redis.pcall("PUBLISH", channel, cjson.encode({queue=queue, version=version})) end
end
return output
