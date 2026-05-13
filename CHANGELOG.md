# Changelog

All notable changes to `synquer-sdk` are documented here.

This project follows [Semantic Versioning](https://semver.org/).

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

[0.1.0]: https://github.com/Synquer/synquer-sdk/releases/tag/v0.1.0
