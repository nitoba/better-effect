-- MQ_FOUNDATION_READY
-- Atomic fenced lease renewal for a batch of jobs.
local MAX = 9007199254740991
local declaredInputKeys = {}
for _, key in ipairs(KEYS) do declaredInputKeys[key] = true end
local MAX_ITEMS = 128
local MAX_BYTES = 524288
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
local function lost(jobId, token, reason) return {jobId, token, reason} end
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
local function validJobFields(job)
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
  return true
end
local function validJson(value)
  if type(value) ~= "string" then return false end
  return pcall(cjson.decode, value)
end
local function validActiveJob(job)
  if redis.call("HGET", job, "state") ~= "active" then return false end
  for _, name in ipairs({"id", "name", "queue", "payload", "metadata"}) do
    local value = redis.call("HGET", job, name)
    if type(value) ~= "string" or value == "" or string.find(value, "\000", 1, true) then return false end
    if (name == "payload" or name == "metadata") and not validJson(value) then return false end
  end
  for _, name in ipairs({"version", "runAt", "orderingSequence", "attemptsMax", "attemptsMade", "deliveryCount", "stalledCount", "createdAt", "updatedAt", "attemptSequence", "timeoutMs", "processedAt", "finishedAt", "leaseExpiresAt", "cancellationRequestedAt"}) do
    local value = redis.call("HGET", job, name)
    if value ~= false and integer(value) == nil then return false end
  end
  if signedInteger(redis.call("HGET", job, "priority")) == nil then return false end
  for _, name in ipairs({"backoff", "result", "failure"}) do
    local value = redis.call("HGET", job, name)
    if value ~= false and not validJson(value) then return false end
  end
  local attemptsMax = integer(redis.call("HGET", job, "attemptsMax"))
  local attemptsMade = integer(redis.call("HGET", job, "attemptsMade"))
  local attemptSequenceValue = redis.call("HGET", job, "attemptSequence")
  local attemptSequence = attemptSequenceValue == false and attemptsMade or integer(attemptSequenceValue)
  local deliveryCount = integer(redis.call("HGET", job, "deliveryCount"))
  local createdAt = integer(redis.call("HGET", job, "createdAt"))
  local updatedAt = integer(redis.call("HGET", job, "updatedAt"))
  local cancellationAt = integer(redis.call("HGET", job, "cancellationRequestedAt"))
  local owner = redis.call("HGET", job, "leaseOwner")
  local token = redis.call("HGET", job, "leaseToken")
  if not attemptsMax or attemptsMax == 0 or not attemptsMade or not attemptSequence or not deliveryCount or
    attemptsMade > deliveryCount or attemptSequence < attemptsMade or attemptsMade > attemptsMax or
    deliveryCount == 0 or attemptsMade >= deliveryCount or attemptsMade >= attemptsMax or
    not createdAt or not updatedAt or updatedAt < createdAt then return false end
  if type(owner) ~= "string" or owner == "" or type(token) ~= "string" or token == "" or integer(redis.call("HGET", job, "leaseExpiresAt")) == nil then return false end
  if cancellationAt ~= nil and cancellationAt > updatedAt then return false end
  return true
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
if type(ARGV[1]) ~= "string" or #ARGV[1] > MAX_BYTES then return errorReply("MQ_BATCH_LIMIT") end
local ok, decoded = pcall(cjson.decode, ARGV[1])
local p = decoded
if not ok or type(p) ~= "table" or p.mode ~= "heartbeat" or type(p.leases) ~= "table" or #p.leases > MAX_ITEMS or type(p.jobPrefix) ~= "string" or type(p.keys) ~= "table" then
  return errorReply("MQ_INVALID_ARGUMENT")
end
p.now = integer(p.now)
p.leaseDuration = integer(p.leaseDuration)
if not p.now or not p.leaseDuration or p.leaseDuration <= 0 or p.now > MAX - p.leaseDuration or not p.keys.active or not rememberKey(p.keys.active, "zset") then
  return errorReply("MQ_INVALID_ARGUMENT")
end
-- Validate the clock relationship before making any renewal visible.
for _, lease in ipairs(p.leases) do
  if type(lease) ~= "table" or type(lease.encodedId) ~= "string" or type(lease.jobId) ~= "string" or type(lease.leaseToken) ~= "string" then
    return errorReply("MQ_INVALID_ARGUMENT")
  end
  local job = p.jobPrefix .. lease.encodedId
  if not rememberKey(job, "hash") or not rememberKey(job .. ":revision", "string") then return errorReply("MQ_CORRUPT_JOB") end
  if redis.call("EXISTS", job) == 1 and not validJobFields(job) then return errorReply("MQ_CORRUPT_JOB") end
  if redis.call("EXISTS", job) == 1 and redis.call("HGET", job, "state") == "active" and not validActiveJob(job) then return errorReply("MQ_CORRUPT_JOB") end
  if redis.call("EXISTS", job) == 1 and redis.call("HGET", job, "state") == "active" then
    local updatedAt = integer(redis.call("HGET", job, "updatedAt"))
    if not updatedAt then return errorReply("MQ_CORRUPT_JOB") end
    if p.now < updatedAt then return errorReply("MQ_INVALID_ARGUMENT") end
    local currentToken = redis.call("HGET", job, "leaseToken")
    if currentToken == lease.leaseToken then
      local expiry = integer(redis.call("HGET", job, "leaseExpiresAt"))
      if not expiry then return errorReply("MQ_CORRUPT_JOB") end
    end
    local revision = integer(redis.call("GET", job .. ":revision") or "0")
    if not revision or revision >= MAX then return errorReply("MQ_UNSAFE_INTEGER") end
  end
end
local renewed = {}
local lostLeases = {}
local cancellationRequested = {}
for _, lease in ipairs(p.leases) do
  local job = p.jobPrefix .. lease.encodedId
  if redis.call("EXISTS", job) == 0 then
    lostLeases[#lostLeases + 1] = lost(lease.jobId, lease.leaseToken, "missing-lease")
  else
    local state = redis.call("HGET", job, "state")
    local currentToken = redis.call("HGET", job, "leaseToken")
    if state ~= "active" then
      lostLeases[#lostLeases + 1] = lost(lease.jobId, lease.leaseToken, "missing-lease")
    elseif currentToken ~= lease.leaseToken then
      lostLeases[#lostLeases + 1] = lost(lease.jobId, lease.leaseToken, "mismatched-token")
    else
      local expiry = integer(redis.call("HGET", job, "leaseExpiresAt"))
      if not expiry then return errorReply("MQ_CORRUPT_JOB") end
      if p.now >= expiry then
        lostLeases[#lostLeases + 1] = lost(lease.jobId, lease.leaseToken, "expired-lease")
      elseif redis.call("HEXISTS", job, "cancellationRequestedAt") == 1 then
        cancellationRequested[#cancellationRequested + 1] = lease.jobId
      else
        local nextExpiry = p.now + p.leaseDuration
        local revision = integer(redis.call("GET", job .. ":revision") or "0")
        if not revision or revision >= MAX then return errorReply("MQ_UNSAFE_INTEGER") end
        redis.call("HSET", job, "leaseExpiresAt", tostring(nextExpiry), "updatedAt", tostring(p.now))
        redis.call("SET", job .. ":revision", tostring(revision + 1))
        redis.call("ZADD", p.keys.active, nextExpiry, lease.jobId)
        renewed[#renewed + 1] = redis.call("HGETALL", job)
      end
    end
  end
end
return {"ok", "heartbeat", "applied", renewed, lostLeases, cancellationRequested}
