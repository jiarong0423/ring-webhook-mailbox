# Changelog

## 0.1.0 — 2026-10-17

First release, built during the *Build, Ship, Shape: Amazon Developer Hackathon 2026* (Ring track).

- AWS Lambda function URL that receives Ring partner webhooks: `X-Signature` (`sha256=` + HMAC-SHA256 of the raw body) checked in constant time, repeats dropped by `meta.request_id`, 5xx on storage trouble so Ring retries, 4xx for bad input.
- DynamoDB queue (on-demand, TTL 24 h, encrypted) keeping only `{ type, subType, deviceId, at }` for five event types.
- Hub client that pulls with single-use Ed25519-signed requests (15 s validity); the first pull only records the queue position.
- CloudFormation template with a least-privilege role, a deterministic Lambda bundle (`npm run build`), example payloads in Ring's documented shape, and in-memory tests.
- Tested with signed events in the documented format; not yet with live Ring deliveries (they need partner credentials).
