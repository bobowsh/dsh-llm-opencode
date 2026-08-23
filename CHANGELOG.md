# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Startup auto-sync of the free model catalog: on every plugin load the catalog is
  refreshed in the background from the gateway (membership) + models.dev (metadata);
  failures keep the built-in catalog, custom `models:` settings are never overwritten,
  and `autoSyncModels: false` opts out.
- Five more free models in the built-in catalog: Nemotron 3.5 Lightning Free, Hy3 Free,
  Laguna S 2.1 Free, Muse Spark 1.2 Free, X Preview F Free (Ox Alpha).
- `registerConfigurableProviders` declaration so OpenCode Zen appears on the web
  Settings → Models page.
- Weekly GitHub Action that syncs the committed catalog from the gateway + models.dev
  (Saturdays 19:00 Asia/Shanghai) and smoke-tests the result.

### Changed
- Catalog metadata corrected against models.dev (hy3-free 190K/64K,
  laguna-s-2.1-free 256K/32K, x-preview-f-free 1M/128K, big-pickle output 32K).
- `@deepseek-ai/dsh-*` dependencies follow the `latest` tag.

## [0.1.0] - 2026-08-20

### Added
- Initial release of the OpenCode Zen provider adapter for DSH.
- Registers `opencode-zen` provider route in the LLM seam.
- Supports free-tier models: DeepSeek V4 Flash Free, Nemotron 3 Ultra Free, MiMo V2.5 Free, Big Pickle.
- Streaming SSE response parsing with `eventsource-parser`.
- Model discovery from `/models` endpoint with automatic `free` tag filtering.
- Configurable via `llm-opencode` settings section (`settings.yaml`).
- Client identity headers (`User-Agent: opencode/1.0.0`) for gateway compatibility.
- TypeScript type declarations for public API surface.
