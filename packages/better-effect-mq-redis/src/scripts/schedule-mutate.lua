-- MQ_SCHEDULES_READY
local MAX_BODY = 8388608
local MAX = 9007199254740991
local declared = {}
for _, key in ipairs(KEYS) do declared[key] = true end

local function errorReply(code)
  return redis.error_reply(code)
end

local function keyTypeIs(key, expected)
  if type(key) ~= "string" or key == "" or not declared[key] then return false end
  local actual = redis.call("TYPE", key)
  if type(actual) == "table" then actual = actual.ok end
  return actual == "none" or actual == expected
end

local function validRetention(value)
  if value == nil then return true end
  for key, item in pairs(value) do
    if (key ~= "ageMs" and key ~= "count") or type(item) ~= "number" or item <= 0 or item > MAX or math.floor(item) ~= item then return false end
  end
  return true
end

local function appendEvent(p)
  local event = p.event
  if event == nil then return true end
  local keys = p.eventKeys
  if type(keys) ~= "table" or type(keys.events) ~= "string" or type(keys.eventsMeta) ~= "string" or
    not keyTypeIs(keys.events, "stream") or not keyTypeIs(keys.eventsMeta, "hash") or
    type(event.type) ~= "string" or event.type == "" or type(event.recordedAtMs) ~= "number" or
    event.recordedAtMs < 0 or math.floor(event.recordedAtMs) ~= event.recordedAtMs or
    type(event.attributes) ~= "table" or not validRetention(p.eventRetention) then return false end
  redis.call("XADD", keys.events, "*", "data", cjson.encode(event))
  redis.call("HSET", keys.eventsMeta, "initialized", "1")
  local retention = p.eventRetention or {}
  if retention.count then redis.call("XTRIM", keys.events, "MAXLEN", "=", tostring(retention.count)) end
  if retention.ageMs then
    local cutoff = event.recordedAtMs - retention.ageMs
    if cutoff < 0 then cutoff = 0 end
    redis.call("XTRIM", keys.events, "MINID", "=", tostring(cutoff) .. "-0")
  end
  return true
end

local function fieldsToRecord(key)
  local fields = redis.call("HGETALL", key)
  local record = {}
  for index = 1, #fields, 2 do record[fields[index]] = fields[index + 1] end
  return record
end

if #KEYS < 4 or type(ARGV[1]) ~= "string" or #ARGV[1] > MAX_BODY then return errorReply("MQ_INVALID_ARGUMENT") end
local decodedOk, p = pcall(cjson.decode, ARGV[1])
if not decodedOk or type(p) ~= "table" or
  (p.mode ~= "upsert" and p.mode ~= "remove" and p.mode ~= "pause" and p.mode ~= "resume") or
  type(p.record) ~= "table" or type(p.groupMember) ~= "string" then return errorReply("MQ_INVALID_ARGUMENT") end

local schedule, group, groups, due = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
if not keyTypeIs(schedule, "hash") or not keyTypeIs(group, "set") or not keyTypeIs(groups, "set") or not keyTypeIs(due, "zset") then
  return errorReply("MQ_CORRUPT_COUNTER")
end
if p.event ~= nil and (type(KEYS[5]) ~= "string" or type(KEYS[6]) ~= "string") then return errorReply("MQ_INVALID_ARGUMENT") end

local existing = redis.call("EXISTS", schedule) == 1
if p.mode == "remove" then
  if not existing then return {"ok", "schedule-mutate", "missing"} end
  redis.call("DEL", schedule)
  redis.call("SREM", group, schedule)
  redis.call("ZREM", due, schedule)
  if redis.call("SCARD", group) == 0 then
    redis.call("SREM", groups, p.groupMember)
    redis.call("DEL", group)
  end
  if not appendEvent(p) then return errorReply("MQ_INVALID_ARGUMENT") end
  return {"ok", "schedule-mutate", "removed", p.record.key}
end

local fields = {}
for key, value in pairs(p.record) do fields[#fields + 1] = key; fields[#fields + 1] = tostring(value) end
local old = redis.call("HKEYS", schedule)
for _, key in ipairs(old) do if p.record[key] == nil then redis.call("HDEL", schedule, key) end end
if #fields > 0 then redis.call("HSET", schedule, unpack(fields)) end
redis.call("SADD", group, schedule)
redis.call("SADD", groups, p.record.group)
if p.record.paused == "1" then redis.call("ZREM", due, schedule) else redis.call("ZADD", due, p.record.nextRunAtMs, schedule) end
if not appendEvent(p) then return errorReply("MQ_INVALID_ARGUMENT") end
if p.mode == "upsert" then return {"ok", "schedule-mutate", existing and "updated" or "created", fieldsToRecord(schedule)} end
return {"ok", "schedule-mutate", "applied", fieldsToRecord(schedule)}
