# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
