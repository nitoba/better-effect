# Changelog

## Unreleased

- Add the MySQL durable outbox v1 table, typed transactional append, Layer-first
  default/named outbox stores, fenced leases, recovery, settlement, and admin
  inspection operations.
- Add the MySQL `JobScheduleStore` adapter and schedules migration.
- Add atomic, deterministic schedule ticks with durable queue wake versions.

## 0.1.0

- Add the optional MySQL 8/InnoDB JobStore adapter for `better-effect-mq` protocol v1.
