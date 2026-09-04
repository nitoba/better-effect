-- better-effect-mq-redis promote foundation script v1
local operation = "promote"
local key_count = #KEYS
local argument_count = #ARGV
if key_count < 0 or argument_count < 0 then
  return redis.error_reply("MQ_INVALID_ARGUMENT")
end
return redis.status_reply("MQ_FOUNDATION_READY:" .. operation)
