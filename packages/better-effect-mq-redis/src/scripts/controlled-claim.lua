-- MQ_CONTROLS_V3
-- Controlled claim keeps the control revision, fixed-window rate window, and
-- fencing permits in the same atomic Redis execution as the Job transition.
local MAX = 9007199254740991
local MAX_LIMIT = 1024
local MAX_SCAN = 8192
local MAX_BODY = 8388608
local declared = {}
for _, key in ipairs(KEYS) do declared[key] = true end

local function err(code, value)
  local out = {"error", code}
  if value ~= nil then out[#out + 1] = tostring(value) end
  return out
end

local function integer(value, positive)
  local n
  if type(value) == "string" then
    if not string.match(value, "^0$") and not string.match(value, "^[1-9][0-9]*$") then return nil end
    n = tonumber(value)
  elseif type(value) == "number" then n = value end
  if not n or n < 0 or n > MAX or math.floor(n) ~= n or (positive and n == 0) then return nil end
  return n
end

local function signed(value)
  local n
  if type(value) == "string" then
    if not string.match(value, "^0$") and not string.match(value, "^-[1-9][0-9]*$") and not string.match(value, "^[1-9][0-9]*$") then return nil end
    n = tonumber(value)
  elseif type(value) == "number" then n = value end
  if not n or n < -MAX or n > MAX or math.floor(n) ~= n then return nil end
  return n
end

local function keyType(key, expected)
  if type(key) ~= "string" or key == "" or not declared[key] then return false end
  local actual = redis.call("TYPE", key)
  if type(actual) == "table" then actual = actual.ok end
  return actual == "none" or actual == expected
end

local function fixed(value) return string.format("%016d", value) end

local function bump(p)
  local version = integer(redis.call("HGET", p.keys.wake, p.queue) or "0")
  if not version or version >= MAX then return nil end
  version = version + 1
  redis.call("HSET", p.keys.wake, p.queue, tostring(version))
  redis.pcall("PUBLISH", p.keys.wakeChannel, cjson.encode({queue=p.queue, version=version}))
  return version
end

local function changeState(p, id, oldState, newState)
  redis.call("SREM", p.keys["byState" .. string.upper(string.sub(oldState, 1, 1)) .. string.sub(oldState, 2)], id)
  redis.call("SADD", p.keys["byState" .. string.upper(string.sub(newState, 1, 1)) .. string.sub(newState, 2)], id)
  redis.call("HINCRBY", p.keys.counts, oldState, -1)
  redis.call("HINCRBY", p.keys.counts, newState, 1)
end

local function jobFor(p, encodedId)
  local job = p.jobKeys[encodedId]
  local revision = p.revisionKeys[encodedId]
  local settlement = p.settlementKeys[encodedId]
  if type(job) ~= "string" or job ~= p.jobPrefix .. encodedId or not declared[job] then return nil end
  if type(revision) ~= "string" or revision ~= job .. ":revision" or not declared[revision] then return nil end
  if type(settlement) ~= "string" or settlement ~= job .. ":settlement" or not declared[settlement] then return nil end
  return job, revision, settlement
end

local function waitingId(member)
  return string.match(member, "^[^:]+:[^:]+:(.+)$")
end

local function delayedId(member)
  return string.match(member, "^[^:]+:(.+)$")
end

local function nextRunAt(p)
  local result = nil
  for _, identity in ipairs(p.identities) do
    if not keyType(identity.delayed, "zset") then return nil, "corrupt" end
    local head = redis.call("ZRANGE", identity.delayed, "0", "0", "WITHSCORES")
    if #head == 2 then
      local due = integer(head[2])
      if not due then return nil, "corrupt" end
      if due > p.now and (result == nil or due < result) then result = due end
    end
  end
  return result
end

local raw = ARGV[1]
if type(raw) ~= "string" or #raw > MAX_BODY then return err("MQ_BATCH_LIMIT") end
local decodedOk, p = pcall(cjson.decode, raw)
if not decodedOk or type(p) ~= "table" or p.mode ~= "controlled-claim" or type(p.keys) ~= "table" or
  type(p.identities) ~= "table" or type(p.jobKeys) ~= "table" or type(p.revisionKeys) ~= "table" or
  type(p.settlementKeys) ~= "table" then return err("MQ_INVALID_ARGUMENT") end

p.now = integer(p.now)
p.limit = integer(p.limit, true)
p.leaseDuration = integer(p.leaseDuration, true)
p.controlsRevision = integer(p.controlsRevision, true)
p.waitingScanLimit = integer(p.waitingScanLimit, true)
p.promotionBudget = integer(p.promotionBudget, true)
if not p.now or not p.limit or p.limit > MAX_LIMIT or not p.leaseDuration or p.now > MAX - p.leaseDuration or
  not p.controlsRevision or not p.waitingScanLimit or p.waitingScanLimit > MAX_SCAN or not p.promotionBudget or
  type(p.queue) ~= "string" or p.queue == "" or type(p.workerId) ~= "string" or p.workerId == "" or
  type(p.jobPrefix) ~= "string" or type(p.tokens) ~= "table" or #p.tokens < p.limit then
  return err("MQ_INVALID_ARGUMENT")
end

local k = p.keys
if type(k.wakeChannel) ~= "string" or not declared[k.wakeChannel] or not keyType(k.wake, "hash") or
  not keyType(k.queueControls, "hash") or not keyType(k.counts, "hash") or not keyType(k.active, "zset") or
  not keyType(k.control, "hash") or not keyType(k.permits, "hash") or not keyType(k.keyCounts, "hash") or
  not keyType(k.rate, "hash") or not keyType(k.rotation, "string") or not keyType(k.controlActive, "set") or
  not keyType(k.byStateWaiting, "set") or not keyType(k.byStateDelayed, "set") or not keyType(k.byStateActive, "set") then
  return err("MQ_INVALID_ARGUMENT")
end
for index, identity in ipairs(p.identities) do
  if type(identity) ~= "table" or type(identity.name) ~= "string" or not integer(identity.version, true) or
    not keyType(identity.waiting, "zset") or not keyType(identity.delayed, "zset") then return err("MQ_INVALID_ARGUMENT") end
end
for index = 1, p.limit do
  if type(p.tokens[index]) ~= "string" or p.tokens[index] == "" then return err("MQ_INVALID_ARGUMENT") end
end

local actualRevision = integer(redis.call("HGET", k.control, "revision") or "0")
local enabled = redis.call("HGET", k.control, "enabled")
if not actualRevision or enabled ~= "1" or actualRevision ~= p.controlsRevision then
  return err("MQ_CONTROLS_REVISION", actualRevision or 0)
end
local wakeVersion = integer(redis.call("HGET", k.wake, p.queue) or "0")
if not wakeVersion or wakeVersion >= MAX then return err("MQ_UNSAFE_INTEGER") end

local delayedNext, delayedProblem = nextRunAt(p)
if delayedProblem then return err("MQ_CORRUPT_JOB") end
local function empty(reason, eligible)
  return {"ok", "controlled-claim", "applied", {}, delayedNext or cjson.null, eligible or cjson.null, wakeVersion, reason}
end
if redis.call("HGET", k.queueControls, p.queue) == "1" then return empty("paused") end

-- Promote only the bounded due prefix. The job hash remains authoritative and
-- the same revision fencing used by v1 protects a racing settlement.
for _, identity in ipairs(p.identities) do
  local due = redis.call("ZRANGEBYSCORE", identity.delayed, "-inf", p.now, "LIMIT", "0", p.promotionBudget)
  for _, member in ipairs(due) do
    local encodedId = delayedId(member)
    local job, revision = encodedId and jobFor(p, encodedId)
    if not job then return err("MQ_CLAIM_RETRY") end
    if redis.call("EXISTS", job) == 1 then
      local state = redis.call("HGET", job, "state")
      local queue, name = redis.call("HGET", job, "queue"), redis.call("HGET", job, "name")
      local version = integer(redis.call("HGET", job, "version"))
      local runAt, sequence = integer(redis.call("HGET", job, "runAt")), integer(redis.call("HGET", job, "orderingSequence"))
      local priority = signed(redis.call("HGET", job, "priority"))
      local updatedAt = integer(redis.call("HGET", job, "updatedAt"))
      if state == "delayed" and queue == p.queue and name == identity.name and version == identity.version then
        if not runAt or not sequence or not priority or not updatedAt or updatedAt > p.now then return err("MQ_CORRUPT_JOB") end
        local currentRevision = integer(redis.call("GET", revision) or "0")
        if not currentRevision or currentRevision >= MAX then return err("MQ_UNSAFE_INTEGER") end
        redis.call("ZREM", identity.delayed, member)
        redis.call("HSET", job, "state", "waiting", "updatedAt", tostring(p.now))
        redis.call("SET", revision, tostring(currentRevision + 1))
        redis.call("ZADD", identity.waiting, -priority, fixed(runAt) .. ":" .. member)
        changeState(p, redis.call("HGET", job, "id"), "delayed", "waiting")
      end
    end
  end
end

local rawGlobalMax = redis.call("HGET", k.control, "globalConcurrency")
local rawPerKeyMax = redis.call("HGET", k.control, "perKeyConcurrency")
local rawRateMax = redis.call("HGET", k.control, "rateMax")
local rawRateDuration = redis.call("HGET", k.control, "rateDurationMs")
local globalMax = integer(rawGlobalMax or "", true)
local perKeyMax = integer(rawPerKeyMax or "", true)
local rateMax = integer(rawRateMax or "", true)
local rateDuration = integer(rawRateDuration or "", true)
if (rawGlobalMax and not globalMax) or (rawPerKeyMax and not perKeyMax) or
  (rawRateMax and (not rateMax or not rateDuration)) or (rawRateDuration and not rateDuration) then
  return err("MQ_CORRUPT_CONTROLS")
end
local permitCount = redis.call("HLEN", k.permits)
if globalMax and permitCount >= globalMax then return empty("global-concurrency") end

local rateCount = integer(redis.call("HGET", k.rate, "count") or "0") or 0
local rateStarted = integer(redis.call("HGET", k.rate, "startedAt") or "")
if rateMax then
  if not rateDuration then return err("MQ_CORRUPT_CONTROLS") end
  if rateCount > 0 and not rateStarted then return err("MQ_CORRUPT_CONTROLS") end
  if rateStarted and rateStarted > MAX - rateDuration then return err("MQ_UNSAFE_INTEGER") end
  if not rateStarted or p.now >= rateStarted + rateDuration then rateCount, rateStarted = 0, nil end
  if rateCount >= rateMax then return empty("rate-limited", rateStarted + rateDuration) end
end

local capacity = p.limit
if globalMax and globalMax - permitCount < capacity then capacity = globalMax - permitCount end
if rateMax and rateMax - rateCount < capacity then capacity = rateMax - rateCount end
if capacity <= 0 then return empty(globalMax and "global-concurrency" or "rate-limited", rateMax and rateStarted and rateStarted + rateDuration or nil) end

local rotation = integer(redis.call("GET", k.rotation) or "0") or 0
local offsets, jobs, examined, blocked = {}, {}, 0, false
for index = 1, #p.identities do offsets[index] = rotation end
local scanBudget = math.min(MAX_SCAN, math.max(p.limit * 4, 32))

local function candidate(identity, offset)
  local count = redis.call("ZCARD", identity.waiting)
  if count == 0 then return nil, "empty" end
  local position = offset % count
  local member = redis.call("ZRANGE", identity.waiting, tostring(position), tostring(position))[1]
  if not member then return nil, "empty" end
  local encodedId = waitingId(member)
  if not encodedId then return nil, "stale" end
  local job, revision, settlement = jobFor(p, encodedId)
  if not job then return nil, "undeclared" end
  if redis.call("EXISTS", job) == 0 then return nil, "stale" end
  local state, queue, name = redis.call("HGET", job, "state"), redis.call("HGET", job, "queue"), redis.call("HGET", job, "name")
  local version, runAt, sequence, priority = integer(redis.call("HGET", job, "version")), integer(redis.call("HGET", job, "runAt")), integer(redis.call("HGET", job, "orderingSequence")), signed(redis.call("HGET", job, "priority"))
  if state ~= "waiting" or queue ~= p.queue or name ~= identity.name or version ~= identity.version or not runAt or runAt > p.now or not sequence or not priority then return nil, "stale" end
  local dispatchKey = redis.call("HGET", job, "dispatchKey") or "__none__"
  if dispatchKey == "" or #dispatchKey > 512 or string.find(dispatchKey, "\000", 1, true) or dispatchKey == "__none__" and redis.call("HEXISTS", job, "dispatchKey") == 1 then
    return nil, "corrupt"
  end
  if perKeyMax then
    local current = integer(redis.call("HGET", k.keyCounts, dispatchKey) or "0") or 0
    local plannedForKey = 0
    for _, item in ipairs(jobs) do if item.dispatchKey == dispatchKey then plannedForKey = plannedForKey + 1 end end
    if current + plannedForKey >= perKeyMax then return {blocked=true, member=member, identity=identity, encodedId=encodedId}, "blocked" end
  end
  return {identity=identity, member=member, encodedId=encodedId, job=job, revision=revision, settlement=settlement, id=redis.call("HGET", job, "id"), runAt=runAt, sequence=sequence, priority=priority, dispatchKey=dispatchKey}
end

local function better(left, right)
  if not right then return true end
  if left.priority ~= right.priority then return left.priority > right.priority end
  if left.runAt ~= right.runAt then return left.runAt < right.runAt end
  return left.sequence < right.sequence or (left.sequence == right.sequence and left.id < right.id)
end

while #jobs < capacity and examined < scanBudget do
  local chosen, chosenIndex = nil, nil
  for index, identity in ipairs(p.identities) do
    local item, problem = candidate(identity, offsets[index])
    if problem == "undeclared" then return err("MQ_CLAIM_RETRY") end
    if problem == "corrupt" then return err("MQ_CORRUPT_JOB") end
    if problem == "blocked" then blocked = true end
    if item and not item.blocked and better(item, chosen) then chosen, chosenIndex = item, index end
  end
  if not chosen then break end
  examined = examined + 1
  offsets[chosenIndex] = offsets[chosenIndex] + 1
  local token = p.tokens[#jobs + 1]
  local expiry = p.now + p.leaseDuration
  local delivery = integer(redis.call("HGET", chosen.job, "deliveryCount"))
  if not delivery or delivery >= MAX then return err("MQ_UNSAFE_INTEGER") end
  redis.call("ZREM", chosen.identity.waiting, chosen.member)
  redis.call("HSET", chosen.job, "state", "active", "leaseOwner", p.workerId, "leaseToken", token,
    "leaseExpiresAt", tostring(expiry), "processedAt", tostring(p.now), "updatedAt", tostring(p.now),
    "deliveryCount", tostring(delivery + 1))
  redis.call("DEL", chosen.settlement)
  local revision = integer(redis.call("GET", chosen.revision) or "0")
  if not revision or revision >= MAX then return err("MQ_UNSAFE_INTEGER") end
  redis.call("SET", chosen.revision, tostring(revision + 1))
  redis.call("ZADD", k.active, expiry, chosen.id)
  redis.call("SADD", k.controlActive, chosen.encodedId)
  redis.call("HSET", k.permits, chosen.encodedId, token .. "\000" .. chosen.dispatchKey)
  redis.call("HINCRBY", k.keyCounts, chosen.dispatchKey, 1)
  changeState(p, chosen.id, "waiting", "active")
  jobs[#jobs + 1] = redis.call("HGETALL", chosen.job)
end

if examined > 0 then redis.call("SET", k.rotation, tostring(rotation + examined)) end
if #jobs > 0 and rateMax then
  if not rateStarted then rateStarted = p.now end
  redis.call("HSET", k.rate, "startedAt", tostring(rateStarted), "count", tostring(rateCount + #jobs))
end
local finalWake = wakeVersion
if #jobs > 0 or examined > 0 then finalWake = bump(p) end
if not finalWake then return err("MQ_UNSAFE_INTEGER") end
local reason = nil
if #jobs == 0 then reason = blocked and "per-key-concurrency" or "empty" end
return {"ok", "controlled-claim", "applied", jobs, delayedNext or cjson.null, cjson.null, finalWake, reason or cjson.null}
