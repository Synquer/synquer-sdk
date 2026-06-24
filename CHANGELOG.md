# Changelog

All notable changes to `synquer-sdk` are documented here.

This project follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.2.1] - 2026-06-24

### Fixed
- `job.failed(error)` no longer collapses a non-`Error` value to the string `"[object Object]"`. When the thrown value is a plain object (a node-soap SOAP fault, an axios error, any rejected object), the SDK now uses its `.message` if present, and otherwise serializes the object so the real detail reaches the dashboard.
- The error serializer is circular-safe and length-bounded, so passing an object that holds a live socket or other circular reference (e.g. a raw axios error) can no longer throw a `Converting circular structure to JSON` error out of `job.failed()`. Telemetry stays fire-and-forget.

## [0.2.0] - 2026-05-14

### Added
- `job.setExternalId(id)` — set or update the external ID after job creation. Useful when the upstream system only returns its ID after the work runs (SAP order number, Stripe payment intent, etc.).
- `externalId` getter on `Job` — read the current external ID.
- Optional `{ externalId }` second argument on `done()`, `failed()`, `skip()`, `review()` — sugar over `setExternalId()` for the case where you only learn the ID from the terminal work itself.

### Changed
- Terminal events (`job.done`, `job.failed`, `job.skipped`, `job.review`) now carry the current `externalId` on the envelope. Backwards-compatible — the server only uses this when the started event has no external ID.

### Notes
- Requires server-side support (synquer-platform 2026-05-14 or later) to read external IDs from terminal events. Older platforms see this as a no-op.

## [0.1.0] - 2026-05-07

First public release.

### Added
- `Synquer` client with `per-job` (default) and `batch` modes
- `Job` lifecycle: `event()`, `done()`, `failed()`, `skip()`, `review()`
- Idempotency via `externalId`
- Entity references (`{ type, id, ref }`) for tying jobs to domain objects
- Configurable retry with exponential backoff (default 3 attempts, 10s timeout)
- `onError` callback for telemetry failures
- `disabled` option for tests/CI
- ESM + CJS dual builds with TypeScript declarations
- `durationMs` reported on all four terminal events (`done`, `failed`, `skipped`, `review`)

### Notes
- Telemetry never throws into application code — failures are silent and surface only via `onError`.
- Requires Node.js 22+ (also runs on Bun and edge runtimes).

[unreleased]: https://github.com/Synquer/synquer-sdk/compare/0.2.1...HEAD
[0.2.1]: https://github.com/Synquer/synquer-sdk/compare/0.2.0...0.2.1
[0.2.0]: https://github.com/Synquer/synquer-sdk/compare/0.1.0...0.2.0
[0.1.0]: https://github.com/Synquer/synquer-sdk/releases/tag/0.1.0
