-- MQ_CONTROLS_V3
-- Single-queue compare-and-set for durable control records.
local MAX = 9007199254740991
local declared = {}
for _, key in ipairs(KEYS) do declared[key] = true end
local function integer(value, positive)
  local n
  if type(value) == "string" then
    if not string.match(value, "^0$") and not string.match(value, "^[1-9][0-9]*$") then return nil end
    n = tonumber(value)
  elseif type(value) == "number" then n = value end
  if not n or n < 0 or n > MAX or math.floor(n) ~= n or (positive and n == 0) then return nil end
  return n
end
local function keyType(key, expected)
  if type(key) ~= "string" or key == "" or not declared[key] then return false end
  local actual = redis.call("TYPE", key)
  if type(actual) == "table" then actual = actual.ok end
  return actual == "none" or actual == expected
end
local function bumpWake(key, channel, queue)
  local version = integer(redis.call("HGET", key, queue) or "0")
  if not version or version >= MAX then return false end
  version = version + 1
  redis.call("HSET", key, queue, tostring(version))
  redis.pcall("PUBLISH", channel, cjson.encode({queue=queue, version=version}))
  return true
end
local function snapshot(key)
  local fields = redis.call("HGETALL", key)
  local output = {}
  for index = 1, #fields, 2 do output[fields[index]] = fields[index + 1] end
  return output
end
local function validRetention(value)
  if value == nil then return true end
  for key, item in pairs(value) do
    if (key ~= "ageMs" and key ~= "count") or type(item) ~= "number" or item <= 0 or item > MAX or math.floor(item) ~= item then return false end
  end
  return true
end
local function appendEvent(p, action)
  if p.eventType == nil then return true end
  if type(p.eventType) ~= "string" or p.eventType == "" or
    type(p.keys.events) ~= "string" or type(p.keys.eventsMeta) ~= "string" or
    not declared[p.keys.events] or not declared[p.keys.eventsMeta] or
    not keyType(p.keys.events, "stream") or not keyType(p.keys.eventsMeta, "hash") or
    not validRetention(p.eventRetention) then return false end
  local event = {
    type = p.eventType,
    recordedAtMs = p.now,
    jobId = nil,
    queue = p.queue,
    name = nil,
    version = nil,
    state = nil,
    attempt = nil,
    delivery = nil,
    workerId = nil,
    outcome = nil,
    failureKind = nil,
    duplicate = nil,
    attributes = {action = action}
  }
  redis.call("XADD", p.keys.events, "*", "data", cjson.encode(event))
  redis.call("HSET", p.keys.eventsMeta, "initialized", "1")
  local retention = p.eventRetention or {}
  local removed = 0
  if retention.ageMs then
    local cutoff = p.now - retention.ageMs
    if cutoff < 0 then cutoff = 0 end
    removed = removed + redis.call("XTRIM", p.keys.events, "MINID", "=", tostring(cutoff) .. "-0")
  end
  if retention.count then removed = removed + redis.call("XTRIM", p.keys.events, "MAXLEN", "=", tostring(retention.count)) end
  if removed > 0 then
    local first = redis.call("XRANGE", p.keys.events, "-", "+", "COUNT", "1")
    if first[1] and first[1][1] then redis.call("HSET", p.keys.eventsMeta, "trimmedThrough", first[1][1]) end
  end
  return true
end
local raw = ARGV[1]
if type(raw) ~= "string" then return {"error", "MQ_INVALID_ARGUMENT"} end
local decodedOk, p = pcall(cjson.decode, raw)
if not decodedOk or type(p) ~= "table" or type(p.mode) ~= "string" or type(p.keys) ~= "table" or type(p.queue) ~= "string" or p.queue == "" then return {"error", "MQ_INVALID_ARGUMENT"} end
local k = p.keys
if not keyType(k.control, "hash") or not keyType(k.controlsIndex, "set") or not keyType(k.wake, "hash") or not keyType(k.queueControls, "hash") or type(k.wakeChannel) ~= "string" or not declared[k.wakeChannel] then return {"error", "MQ_INVALID_ARGUMENT"} end
if p.eventType ~= nil and (not keyType(k.events, "stream") or not keyType(k.eventsMeta, "hash") or not validRetention(p.eventRetention)) then return {"error", "MQ_INVALID_ARGUMENT"} end
local now = integer(p.now)
if not now then return {"error", "MQ_INVALID_ARGUMENT"} end
local wakeVersion = integer(redis.call("HGET", k.wake, p.queue) or "0")
if not wakeVersion or wakeVersion >= MAX then return {"error", "MQ_UNSAFE_INTEGER"} end
local current = snapshot(k.control)
local currentRevision = integer(current.revision or "0") or 0
local function reply(status, value)
  return {"ok", "controls-reconcile", status, cjson.encode(value)}
end
if p.mode == "disable" then
  if currentRevision == 0 or current.enabled ~= "1" then return reply("unchanged", current) end
  if currentRevision >= MAX then return {"error", "MQ_UNSAFE_INTEGER"} end
  redis.call("HSET", k.control, "enabled", "0", "revision", tostring(currentRevision + 1), "updatedAtMs", tostring(now))
  if not bumpWake(k.wake, k.wakeChannel, p.queue) then return {"error", "MQ_UNSAFE_INTEGER"} end
  if not appendEvent(p, "disabled") then return {"error", "MQ_INVALID_ARGUMENT"} end
  return reply("disabled", snapshot(k.control))
end
if p.mode ~= "upsert" or type(p.group) ~= "string" or p.group == "" or type(p.enabled) ~= "boolean" then return {"error", "MQ_INVALID_ARGUMENT"} end
local global = integer(p.globalConcurrency, true)
local perKey = integer(p.perKeyConcurrency, true)
local rateMax = integer(p.rateMax, true)
local rateDuration = integer(p.rateDurationMs, true)
if (p.globalConcurrency ~= nil and not global) or (p.perKeyConcurrency ~= nil and not perKey) or (p.rateMax ~= nil and (not rateMax or not rateDuration)) then return {"error", "MQ_INVALID_ARGUMENT"} end
local same = currentRevision > 0 and current.enabled == "1" and current.group == p.group and
  (current.globalConcurrency or "") == (global and tostring(global) or "") and
  (current.perKeyConcurrency or "") == (perKey and tostring(perKey) or "") and
  (current.rateMax or "") == (rateMax and tostring(rateMax) or "") and
  (current.rateDurationMs or "") == (rateDuration and tostring(rateDuration) or "")
if same then return reply("unchanged", current) end
local revision = currentRevision == 0 and 1 or currentRevision + 1
if revision > MAX then return {"error", "MQ_UNSAFE_INTEGER"} end
local fields = {"queue", p.queue, "group", p.group, "enabled", "1", "revision", tostring(revision), "createdAtMs", current.createdAtMs or tostring(now), "updatedAtMs", tostring(now)}
for _, name in ipairs({"globalConcurrency", "perKeyConcurrency", "rateMax", "rateDurationMs"}) do
  if (name == "globalConcurrency" and not global) or (name == "perKeyConcurrency" and not perKey) or ((name == "rateMax" or name == "rateDurationMs") and not rateMax) then redis.call("HDEL", k.control, name) end
end
if global then fields[#fields + 1] = "globalConcurrency"; fields[#fields + 1] = tostring(global) end
if perKey then fields[#fields + 1] = "perKeyConcurrency"; fields[#fields + 1] = tostring(perKey) end
if rateMax then fields[#fields + 1] = "rateMax"; fields[#fields + 1] = tostring(rateMax); fields[#fields + 1] = "rateDurationMs"; fields[#fields + 1] = tostring(rateDuration) end
redis.call("HSET", k.control, unpack(fields))
redis.call("SADD", k.controlsIndex, p.queue)
if not bumpWake(k.wake, k.wakeChannel, p.queue) then return {"error", "MQ_UNSAFE_INTEGER"} end
if not appendEvent(p, currentRevision == 0 and "created" or "updated") then return {"error", "MQ_INVALID_ARGUMENT"} end
return reply(currentRevision == 0 and "created" or "updated", snapshot(k.control))
