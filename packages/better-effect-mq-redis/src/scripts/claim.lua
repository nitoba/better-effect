-- MQ_FOUNDATION_READY
-- Atomic Redis JobStore claim, delayed promotion, and bounded k-way merge.
local MAX = 9007199254740991
local MAX_LIMIT = 1024
local MAX_PROMOTION_BUDGET = 10000
local MAX_WAITING_SCAN = 8192
local MAX_IDENTITIES = 2048
local MAX_WORK = 250000
local MAX_BODY = 8388608
local declaredInputKeys = {}
for _, key in ipairs(KEYS) do declaredInputKeys[key] = true end
local function errorReply(code)
  return {"error", tostring(code)}
end
local function okReply(status, ...)
  local result = {"ok", "claim", status}
  local values = {...}
  for index, value in ipairs(values) do result[#result + 1] = value end
  return result
end
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
local function fixed(value)
  return string.format("%016d", value)
end
local function jobIdFromWaiting(member)
  return string.match(member, "^[^:]+:[^:]+:(.+)$")
end
local function jobIdFromDelayed(member)
  return string.match(member, "^[^:]+:(.+)$")
end
local function declaredKey(p, field, encodedId, suffix)
  if type(p[field]) ~= "table" then return nil end
  local key = p[field][encodedId]
  local expected = p.jobPrefix .. encodedId .. suffix
  if type(key) ~= "string" or key ~= expected or not declaredInputKeys[key] then return nil end
  return key
end
local function declaredJob(p, encodedId)
  return declaredKey(p, "jobKeys", encodedId, "")
end
local function declaredRevision(p, encodedId)
  return declaredKey(p, "revisionKeys", encodedId, ":revision")
end
local function declaredSettlement(p, encodedId)
  return declaredKey(p, "settlementKeys", encodedId, ":settlement")
end
local function waitingMember(job, encodedId)
  local runAt = integer(redis.call("HGET", job, "runAt"))
  local sequence = integer(redis.call("HGET", job, "orderingSequence"))
  if not runAt or not sequence then return nil end
  return fixed(runAt) .. ":" .. fixed(sequence) .. ":" .. encodedId
end
local function bump(keys, queue)
  local old = integer(redis.call("HGET", keys.wake, queue) or "0")
  if not old or old >= MAX then return nil end
  local version = old + 1
  redis.call("HSET", keys.wake, queue, tostring(version))
  if keys.wakeChannel then
    redis.pcall("PUBLISH", keys.wakeChannel, cjson.encode({queue=queue, version=version}))
  end
  return version
end
local function stateKey(keys, state)
  return keys["byState" .. string.upper(string.sub(state, 1, 1)) .. string.sub(state, 2)]
end
local function changeState(keys, id, oldState, newState)
  redis.call("SREM", stateKey(keys, oldState), id)
  redis.call("SADD", stateKey(keys, newState), id)
  redis.call("HINCRBY", keys.counts, oldState, -1)
  redis.call("HINCRBY", keys.counts, newState, 1)
end
local function countersValid(keys)
  local states = {"waiting", "delayed", "active", "completed", "failed", "cancelled"}
  local total = integer(redis.call("HGET", keys.counts, "total") or "0")
  if not total then return false end
  local sum = 0
  for _, state in ipairs(states) do
    local value = integer(redis.call("HGET", keys.counts, state) or "0")
    if not value or sum > MAX - value then return false end
    sum = sum + value
  end
  return sum == total
end
local function validJson(value)
  if type(value) ~= "string" then return false end
  return pcall(cjson.decode, value)
end
local function keyTypeIs(key, expected)
  if type(key) ~= "string" or key == "" or not declaredInputKeys[key] then return false end
  local actual = redis.call("TYPE", key)
  if type(actual) == "table" then actual = actual.ok end
  return actual == "none" or actual == expected
end
local function validJob(job)
  if not keyTypeIs(job, "hash") or redis.call("EXISTS", job) == 0 then return false end
  local knownFields = {
    id=true, name=true, version=true, queue=true, state=true, payload=true, metadata=true,
    priority=true, runAt=true, orderingSequence=true, attemptsMax=true, attemptsMade=true,
    attemptSequence=true, deliveryCount=true, stalledCount=true, backoff=true, timeoutMs=true,
    idempotencyKey=true, createdAt=true, updatedAt=true, processedAt=true, finishedAt=true,
    leaseOwner=true, leaseToken=true, leaseExpiresAt=true, cancellationRequestedAt=true,
    result=true, failure=true
  }
  for _, name in ipairs(redis.call("HKEYS", job)) do
    if not knownFields[name] then return false end
  end
  local state = redis.call("HGET", job, "state")
  if state ~= "waiting" and state ~= "delayed" and state ~= "active" and state ~= "completed" and state ~= "failed" and state ~= "cancelled" then return false end
  for _, name in ipairs({"id", "name", "queue", "payload", "metadata"}) do
    local value = redis.call("HGET", job, name)
    if type(value) ~= "string" or value == "" or string.find(value, "\000", 1, true) then return false end
  end
  if not validJson(redis.call("HGET", job, "payload")) or not validJson(redis.call("HGET", job, "metadata")) then return false end
  for _, name in ipairs({"version", "runAt", "orderingSequence", "attemptsMax", "attemptsMade", "deliveryCount", "stalledCount", "createdAt", "updatedAt"}) do
    if integer(redis.call("HGET", job, name)) == nil then return false end
  end
  local createdAt = integer(redis.call("HGET", job, "createdAt"))
  local updatedAt = integer(redis.call("HGET", job, "updatedAt"))
  if updatedAt < createdAt then return false end
  if signedInteger(redis.call("HGET", job, "priority")) == nil then return false end
  for _, name in ipairs({"attemptSequence", "timeoutMs", "processedAt", "finishedAt", "cancellationRequestedAt", "leaseExpiresAt"}) do
    local value = redis.call("HGET", job, name)
    if value ~= false and integer(value) == nil then return false end
  end
  for _, name in ipairs({"backoff", "result", "failure"}) do
    local value = redis.call("HGET", job, name)
    if value ~= false and not validJson(value) then return false end
  end
  local attemptsMax = integer(redis.call("HGET", job, "attemptsMax"))
  local attemptsMade = integer(redis.call("HGET", job, "attemptsMade"))
  local attemptSequenceValue = redis.call("HGET", job, "attemptSequence")
  local attemptSequence = attemptSequenceValue == false and attemptsMade or integer(attemptSequenceValue)
  local deliveryCount = integer(redis.call("HGET", job, "deliveryCount"))
  local cancellationAt = integer(redis.call("HGET", job, "cancellationRequestedAt"))
  if not attemptsMax or attemptsMax == 0 or not attemptsMade or not attemptSequence or not deliveryCount or
    attemptsMade > deliveryCount or attemptSequence < attemptsMade or attemptsMade > attemptsMax or
    (state == "active" and (deliveryCount == 0 or attemptsMade >= deliveryCount)) or
    (state == "waiting" or state == "delayed" or state == "active") and attemptsMade >= attemptsMax or
    (cancellationAt and (state ~= "active" or cancellationAt > updatedAt)) then
    return false
  end
  if state == "active" then
    local owner = redis.call("HGET", job, "leaseOwner")
    local token = redis.call("HGET", job, "leaseToken")
    if type(owner) ~= "string" or owner == "" or type(token) ~= "string" or token == "" or integer(redis.call("HGET", job, "leaseExpiresAt")) == nil then return false end
  elseif redis.call("HGET", job, "leaseOwner") ~= false or redis.call("HGET", job, "leaseToken") ~= false or redis.call("HGET", job, "leaseExpiresAt") ~= false or redis.call("HGET", job, "cancellationRequestedAt") ~= false then
    return false
  end
  return true
end
local physicalKeys = {}
local function rememberKey(key, expected)
  if type(key) ~= "string" or key == "" then return false end
  if physicalKeys[key] ~= nil then return physicalKeys[key] == expected end
  if not keyTypeIs(key, expected) then return false end
  physicalKeys[key] = expected
  return true
end
local function staticKeysValid(p)
  local keys = p.keys
  if type(keys.wakeChannel) ~= "string" or keys.wakeChannel == "" or not declaredInputKeys[keys.wakeChannel] then return false end
  for _, name in ipairs({"counts", "wake", "queueControls"}) do
    if not rememberKey(keys[name], "hash") then return false end
  end
  for _, name in ipairs({"all", "byQueue", "byStateWaiting", "byStateDelayed", "byStateActive"}) do
    if not rememberKey(keys[name], "set") then return false end
  end
  if not rememberKey(keys.active, "zset") then return false end
  for _, identity in ipairs(p.identities) do
    if not rememberKey(identity.waiting, "zset") or not rememberKey(identity.delayed, "zset") then return false end
  end
  return true
end
local function promoteIdentity(p, identity)
  local due = redis.call("ZRANGEBYSCORE", identity.delayed, "-inf", p.now, "LIMIT", "0", p.promotionBudget)
  local changed = false
  for _, member in ipairs(due) do
    local encodedId = jobIdFromDelayed(member)
    if not encodedId then return nil, "corrupt" end
    local job = declaredJob(p, encodedId)
    local revisionKey = declaredRevision(p, encodedId)
    local settlementKey = declaredSettlement(p, encodedId)
    if not job or not revisionKey or not settlementKey then return nil, "undeclared" end
    if not rememberKey(job, "hash") or not rememberKey(revisionKey, "string") or not rememberKey(settlementKey, "hash") then return nil, "corrupt" end
    redis.call("ZREM", identity.delayed, member)
    if redis.call("EXISTS", job) == 1 then
      if not validJob(job) then return nil, "corrupt" end
      local state = redis.call("HGET", job, "state")
      local queue = redis.call("HGET", job, "queue")
      local name = redis.call("HGET", job, "name")
      local version = integer(redis.call("HGET", job, "version"))
      local runAt = integer(redis.call("HGET", job, "runAt"))
      local sequence = integer(redis.call("HGET", job, "orderingSequence"))
      local priority = signedInteger(redis.call("HGET", job, "priority"))
      local id = redis.call("HGET", job, "id")
      local updatedAt = integer(redis.call("HGET", job, "updatedAt"))
      local createdAt = integer(redis.call("HGET", job, "createdAt"))
      local delivery = integer(redis.call("HGET", job, "deliveryCount"))
      if not state or not queue or not name or not version or not runAt or not sequence or not priority or not id or not updatedAt or not createdAt or updatedAt < createdAt then
        return nil, "corrupt"
      end
      if state == "delayed" and queue == p.queue and name == identity.name and version == identity.version then
        if updatedAt > p.now then return nil, "clock" end
        if not delivery or delivery >= MAX then return nil, "unsafe" end
        local revision = integer(redis.call("GET", revisionKey) or "0")
        if not revision or revision >= MAX then return nil, "unsafe" end
        local waiting = fixed(runAt) .. ":" .. fixed(sequence) .. ":" .. encodedId
        redis.call("HSET", job, "state", "waiting", "updatedAt", tostring(p.now))
        redis.call("SET", revisionKey, tostring(revision + 1))
        redis.call("ZADD", identity.waiting, -priority, waiting)
        changeState(p.keys, id, "delayed", "waiting")
        changed = true
      end
    end
  end
  return changed
end
local function candidate(p, identity, offset)
  local candidateOffset = offset or 0
  local position = tostring(candidateOffset)
  local head = redis.call("ZRANGE", identity.waiting, position, position)
  if candidateOffset >= p.waitingScanLimit then
    if #head == 0 then return nil end
    return nil, "undeclared"
  end
  if #head == 0 then return nil end
  local member = head[1]
  local encodedId = jobIdFromWaiting(member)
  if not encodedId then return nil, "stale" end
  local job = declaredJob(p, encodedId)
  local revisionKey = declaredRevision(p, encodedId)
  local settlementKey = declaredSettlement(p, encodedId)
  if not job or not revisionKey or not settlementKey then return nil, "undeclared" end
  if not rememberKey(job, "hash") or not rememberKey(revisionKey, "string") or not rememberKey(settlementKey, "hash") then return nil, "corrupt" end
  if redis.call("EXISTS", job) == 0 then return nil, "stale" end
  if not validJob(job) then return nil, "corrupt" end
  local state = redis.call("HGET", job, "state")
  local queue = redis.call("HGET", job, "queue")
  local name = redis.call("HGET", job, "name")
  local version = integer(redis.call("HGET", job, "version"))
  local runAt = integer(redis.call("HGET", job, "runAt"))
  local sequence = integer(redis.call("HGET", job, "orderingSequence"))
  local priority = signedInteger(redis.call("HGET", job, "priority"))
  local updatedAt = integer(redis.call("HGET", job, "updatedAt"))
  local createdAt = integer(redis.call("HGET", job, "createdAt"))
  local delivery = integer(redis.call("HGET", job, "deliveryCount"))
  local id = redis.call("HGET", job, "id")
  if not state or not queue or not name or not version or not runAt or not sequence or not priority or not updatedAt or not createdAt or not delivery or not id or updatedAt < createdAt then
    return nil, "corrupt"
  end
  if state ~= "waiting" or queue ~= p.queue or name ~= identity.name or version ~= identity.version or runAt > p.now then
    return nil, "stale"
  end
  if updatedAt > p.now then return nil, "clock" end
  local revision = integer(redis.call("GET", revisionKey) or "0")
  if not revision or revision >= MAX then return nil, "unsafe" end
  return {
    identity = identity,
    member = member,
    encodedId = encodedId,
    job = job,
    revisionKey = revisionKey,
    settlementKey = settlementKey,
    priority = priority,
    runAt = runAt,
    sequence = sequence,
    revision = revision,
    delivery = delivery,
    id = id
  }
end
local function better(left, right)
  if right == nil then return true end
  if left.priority ~= right.priority then return left.priority > right.priority end
  if left.runAt ~= right.runAt then return left.runAt < right.runAt end
  if left.sequence ~= right.sequence then return left.sequence < right.sequence end
  return left.id < right.id
end
local function nextRunAtAfterPromotions(p, removals)
  local nextValue = nil
  for index, identity in ipairs(p.identities) do
    local offset = tostring(removals[index] or 0)
    local head = redis.call("ZRANGE", identity.delayed, offset, offset, "WITHSCORES")
    if #head >= 2 then
      local value = integer(head[2])
      if not value then return nil, "corrupt" end
      if value > p.now and (nextValue == nil or value < nextValue) then nextValue = value end
    end
  end
  return nextValue
end
local function preflightPromotions(p, identity)
  local delayedHeads = redis.call("ZRANGE", identity.delayed, "0", tostring(p.promotionBudget), "WITHSCORES")
  if #delayedHeads % 2 ~= 0 then return "corrupt" end
  for index = 2, #delayedHeads, 2 do
    if not integer(delayedHeads[index]) then return "corrupt" end
  end
  local due = redis.call("ZRANGEBYSCORE", identity.delayed, "-inf", p.now, "LIMIT", "0", p.promotionBudget)
  local promoted, removed = 0, #due
  for _, member in ipairs(due) do
    local encodedId = jobIdFromDelayed(member)
    if not encodedId then return "corrupt" end
    local job = declaredJob(p, encodedId)
    local revisionKey = declaredRevision(p, encodedId)
    local settlementKey = declaredSettlement(p, encodedId)
    if not job or not revisionKey or not settlementKey then return "undeclared" end
    if not rememberKey(job, "hash") or not rememberKey(revisionKey, "string") or not rememberKey(settlementKey, "hash") then return "corrupt" end
    if redis.call("EXISTS", job) == 1 then
      if not validJob(job) then return "corrupt" end
      local state = redis.call("HGET", job, "state")
      local queue = redis.call("HGET", job, "queue")
      local name = redis.call("HGET", job, "name")
      local version = integer(redis.call("HGET", job, "version"))
      local runAt = integer(redis.call("HGET", job, "runAt"))
      local sequence = integer(redis.call("HGET", job, "orderingSequence"))
      local priority = signedInteger(redis.call("HGET", job, "priority"))
      local id = redis.call("HGET", job, "id")
      local updatedAt = integer(redis.call("HGET", job, "updatedAt"))
      local createdAt = integer(redis.call("HGET", job, "createdAt"))
      local delivery = integer(redis.call("HGET", job, "deliveryCount"))
      if not state or not queue or not name or not version or not runAt or not sequence or not priority or not id or not updatedAt or not createdAt or updatedAt < createdAt then
        return "corrupt"
      end
      if state == "delayed" and queue == p.queue and name == identity.name and version == identity.version then
        if updatedAt > p.now then return "clock" end
        if not delivery or delivery >= MAX then return "unsafe" end
        local revision = integer(redis.call("GET", revisionKey) or "0")
        if not revision or revision >= MAX then return "unsafe" end
        promoted = promoted + 1
      end
    end
  end
  return nil, promoted, removed
end
local function preflightWaiting(p)
  local offsets, selected = {}, {}
  for index in ipairs(p.identities) do offsets[index] = 0 end
  local operations, selectedCount = 0, 0
  local operationLimit = p.limit * (#p.identities + 1) + p.promotionBudget * #p.identities + 128
  while operations < operationLimit do
    operations = operations + 1
    local chosen, chosenIndex, staleIndex = nil, nil, nil
    for index, identity in ipairs(p.identities) do
      local item, problem = candidate(p, identity, offsets[index])
      if problem == "corrupt" then return "corrupt" end
      if problem == "undeclared" then return "undeclared" end
      if problem == "unsafe" then return "unsafe" end
      if problem == "clock" then return "clock" end
      if problem == "stale" then
        staleIndex = index
      elseif item and selected[item.id] then
        staleIndex = index
      elseif item and better(item, chosen) then
        chosen, chosenIndex = item, index
      end
    end
    if chosen then
      if chosen.delivery >= MAX then return "unsafe" end
      selected[chosen.id] = true
      selectedCount = selectedCount + 1
      offsets[chosenIndex] = offsets[chosenIndex] + 1
    elseif staleIndex then
      offsets[staleIndex] = offsets[staleIndex] + 1
    else
      break
    end
    if selectedCount >= p.limit then break end
  end
  return nil, selectedCount
end
if type(ARGV[1]) ~= "string" or #ARGV[1] > MAX_BODY then return errorReply("MQ_BATCH_LIMIT") end
local decodedOk, decoded = pcall(cjson.decode, ARGV[1])
if not decodedOk or type(decoded) ~= "table" or decoded.mode ~= "claim" or type(decoded.keys) ~= "table" or type(decoded.identities) ~= "table" or
  type(decoded.jobKeys) ~= "table" or type(decoded.revisionKeys) ~= "table" or type(decoded.settlementKeys) ~= "table" then
  return errorReply("MQ_INVALID_ARGUMENT")
end
local p = decoded
p.keys = decoded.keys
p.now = integer(p.now)
p.limit = integer(p.limit)
p.leaseDuration = integer(p.leaseDuration)
p.promotionBudget = integer(p.promotionBudget)
p.waitingScanLimit = integer(p.waitingScanLimit)
if not p.now or not p.limit or p.limit <= 0 or p.limit > MAX_LIMIT or not p.leaseDuration or p.leaseDuration <= 0 or not p.promotionBudget or p.promotionBudget <= 0 or p.promotionBudget > MAX_PROMOTION_BUDGET or not p.waitingScanLimit or p.waitingScanLimit <= 0 or p.waitingScanLimit > MAX_WAITING_SCAN or type(p.queue) ~= "string" or p.queue == "" or type(p.workerId) ~= "string" or p.workerId == "" or type(p.jobPrefix) ~= "string" or p.jobPrefix == "" or type(p.tokens) ~= "table" then
  return errorReply("MQ_INVALID_ARGUMENT")
end
if #p.identities > MAX_IDENTITIES or #p.identities * (p.limit + p.promotionBudget + 128) > MAX_WORK then
  return errorReply("MQ_BATCH_LIMIT")
end
if p.now > MAX - p.leaseDuration or #p.tokens < p.limit then return errorReply("MQ_INVALID_ARGUMENT") end
if not p.jobPrefix or not p.keys.all or not p.keys.active or not p.keys.counts or not p.keys.wake or not p.keys.wakeChannel or not p.keys.queueControls or not p.keys.byStateWaiting or not p.keys.byStateDelayed or not p.keys.byStateActive then
  return errorReply("MQ_INVALID_ARGUMENT")
end
for index, identity in ipairs(p.identities) do
  if type(identity) ~= "table" or type(identity.name) ~= "string" or identity.name == "" or not integer(identity.version) or type(identity.waiting) ~= "string" or type(identity.delayed) ~= "string" then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
end
if not staticKeysValid(p) then return errorReply("MQ_INVALID_ARGUMENT") end
for index = 1, p.limit do
  if type(p.tokens[index]) ~= "string" or p.tokens[index] == "" then return errorReply("MQ_INVALID_ARGUMENT") end
end
local wakeVersion = integer(redis.call("HGET", p.keys.wake, p.queue) or "0")
if not wakeVersion or wakeVersion >= MAX then return errorReply("MQ_UNSAFE_INTEGER") end
if redis.call("HGET", p.keys.queueControls, p.queue) == "1" then
  return okReply("applied", {}, cjson.null, wakeVersion)
end
local plannedPromotions = 0
local promotionRemovals = {}
for index, identity in ipairs(p.identities) do
  local problem, count, removed = preflightPromotions(p, identity)
  if problem == "unsafe" then return errorReply("MQ_UNSAFE_INTEGER") end
  if problem == "clock" then return errorReply("MQ_INVALID_ARGUMENT") end
  if problem == "undeclared" then return errorReply("MQ_CLAIM_RETRY") end
  if problem then return errorReply("MQ_CORRUPT_JOB") end
  promotionRemovals[index] = removed or 0
  plannedPromotions = plannedPromotions + (count or 0)
end
local waitingProblem, plannedClaims = preflightWaiting(p)
if waitingProblem == "unsafe" then return errorReply("MQ_UNSAFE_INTEGER") end
if waitingProblem == "clock" then return errorReply("MQ_INVALID_ARGUMENT") end
if waitingProblem == "undeclared" then return errorReply("MQ_CLAIM_RETRY") end
if waitingProblem then return errorReply("MQ_CORRUPT_JOB") end
if not countersValid(p.keys) then return errorReply("MQ_CORRUPT_COUNTER") end
local nextValue, nextProblem = nextRunAtAfterPromotions(p, promotionRemovals)
if nextProblem then return errorReply("MQ_CORRUPT_JOB") end
local waitingCount = integer(redis.call("HGET", p.keys.counts, "waiting") or "0")
local delayedCount = integer(redis.call("HGET", p.keys.counts, "delayed") or "0")
local activeCount = integer(redis.call("HGET", p.keys.counts, "active") or "0")
if not waitingCount or not delayedCount or not activeCount or
  delayedCount < plannedPromotions or waitingCount > MAX - plannedPromotions or
  waitingCount + plannedPromotions < plannedClaims or activeCount > MAX - plannedClaims then
  return errorReply("MQ_CORRUPT_COUNTER")
end
local changed = false
for _, identity in ipairs(p.identities) do
  local promoted, problem = promoteIdentity(p, identity)
  if problem == "unsafe" then return errorReply("MQ_UNSAFE_INTEGER") end
  if problem == "clock" then return errorReply("MQ_INVALID_ARGUMENT") end
  if problem == "undeclared" then return errorReply("MQ_CLAIM_RETRY") end
  if problem then return errorReply("MQ_CORRUPT_JOB") end
  if promoted then changed = true end
end
local jobs = {}
local operations = 0
local operationLimit = p.limit * (#p.identities + 1) + p.promotionBudget * #p.identities + 128
while #jobs < p.limit and operations < operationLimit do
  operations = operations + 1
  local chosen = nil
  local staleIdentity = nil
  for _, identity in ipairs(p.identities) do
    local item, problem = candidate(p, identity)
    if problem == "corrupt" then return errorReply("MQ_CORRUPT_JOB") end
    if problem == "undeclared" then return errorReply("MQ_CLAIM_RETRY") end
    if problem == "unsafe" then return errorReply("MQ_UNSAFE_INTEGER") end
    if problem == "clock" then return errorReply("MQ_INVALID_ARGUMENT") end
    if problem == "stale" then staleIdentity = identity end
    if item and better(item, chosen) then chosen = item end
  end
  if not chosen then
    if staleIdentity then
      local head = redis.call("ZRANGE", staleIdentity.waiting, "0", "0")
      if #head > 0 then redis.call("ZREM", staleIdentity.waiting, head[1]) end
      changed = true
    else
      break
    end
  else
    local token = p.tokens[#jobs + 1]
    local expiry = p.now + p.leaseDuration
    redis.call("ZREM", chosen.identity.waiting, chosen.member)
    local delivery = integer(redis.call("HGET", chosen.job, "deliveryCount"))
    if not delivery then return errorReply("MQ_CORRUPT_JOB") end
    if delivery >= MAX then return errorReply("MQ_UNSAFE_INTEGER") end
    delivery = delivery + 1
    redis.call("HSET", chosen.job,
      "state", "active",
      "leaseOwner", p.workerId,
      "leaseToken", token,
      "leaseExpiresAt", tostring(expiry),
      "processedAt", tostring(p.now),
      "updatedAt", tostring(p.now),
      "deliveryCount", tostring(delivery))
    redis.call("DEL", chosen.settlementKey)
    redis.call("SET", chosen.revisionKey, tostring(chosen.revision + 1))
    redis.call("ZADD", p.keys.active, expiry, chosen.id)
    changeState(p.keys, chosen.id, "waiting", "active")
    jobs[#jobs + 1] = redis.call("HGETALL", chosen.job)
    changed = true
  end
end
-- Delayed indexes and their next heads cannot change after the preflight:
-- this script only removes due members, so the value above is authoritative.
local finalWakeVersion = wakeVersion
if changed then
  finalWakeVersion = bump(p.keys, p.queue)
  if not finalWakeVersion then return errorReply("MQ_UNSAFE_INTEGER") end
end
return okReply("applied", jobs, nextValue or cjson.null, finalWakeVersion)
