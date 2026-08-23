# dsh-llm-opencode

[![npm version](https://img.shields.io/npm/v/dsh-llm-opencode)](https://www.npmjs.com/package/dsh-llm-opencode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-blue)](https://github.com/topics/dsh-plugin)

OpenCode Zen free model provider adapter for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Registers the `opencode-zen` provider route in DSH's LLM seam, giving your coding agent access to OpenCode Zen's free-tier models — **no API key required for free models**, no credit card, no setup friction.

## Free Models

Built-in catalog (verified against the gateway + [models.dev](https://github.com/sst/models.dev) on 2026-08-23; refreshed automatically at startup and weekly via CI):

| Model | ID | Context | Max Output | Notes |
|---|---|---|---|---|
| DeepSeek V4 Flash Free | `deepseek-v4-flash-free` | 200K | 128K | DeepSeek's V4 Flash, SWE-bench ~79% |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` | 1M | 128K | NVIDIA's flagship, huge context |
| Nemotron 3.5 Lightning Free | `nemotron-3.5-lightning-free` | 128K | 128K | NVIDIA's fast variant |
| MiMo V2.5 Free | `mimo-v2.5-free` | 200K | 32K | Xiaomi's coding model |
| Hy3 Free | `hy3-free` | 190K | 64K | Tencent HY3 |
| Laguna S 2.1 Free | `laguna-s-2.1-free` | 256K | 32K | |
| Muse Spark 1.2 Free | `muse-spark-1.2-contributor-free` | 128K | 128K | |
| Ox Alpha Free (Unlimited) | `x-preview-f-free` | 1M | 128K | Stealth preview, huge context |
| Big Pickle | `big-pickle` | 200K | 32K | Stealth general-purpose model |

> Free models are served through OpenCode Zen's public gateway. Availability may change; the adapter auto-discovers models tagged `free` from the `/models` endpoint, and the built-in catalog is re-synced in the background on every startup (see **Startup catalog sync** below).

## Install

```bash
# From npm (prebuilt, recommended)
dsh plugin --profile web add dsh-llm-opencode

# Or from GitHub directly
dsh plugin --profile web add "github:bobowsh/dsh-llm-opencode#main"
```

## Quick Start

1. Install the plugin into your DSH profile (see above).
2. Open DSH Web Settings → Models → select **OpenCode Zen** as your provider.
3. Pick a free model (e.g. `deepseek-v4-flash-free`) and start coding — no API key needed.

> Paid models require an API key. Set `OPENCODE_API_KEY` in DSH credentials (Settings → Credentials) or as an environment variable.

## How It Works

This plugin implements the `LlmAdapter` interface from `@deepseek-ai/dsh-llm` and registers a single provider route `opencode-zen`. When DSH routes a request to this provider:

1. **Serialization** — harness messages are translated to OpenAI-compatible chat completions (text-only; images are rejected with `UNSUPPORTED_CONTENT`).
2. **Streaming** — SSE responses are parsed via `eventsource-parser` and translated into harness `StreamChunk` events (`block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `usage`, `finish`).
3. **Identity** — requests carry `User-Agent: opencode/1.0.0` and related headers to satisfy OpenCode Zen's client identity check (the default `deepseek-harness/...` user-agent is rejected by the gateway).
4. **Credentials** — resolves the API key from DSH's credential store (env var `OPENCODE_API_KEY`) or the ambient environment. Free models work without a key; paid models require one.
5. **Model discovery** — registers a discovery handler that fetches `/models` from the gateway and filters for `free`-tagged entries.
6. **Startup catalog sync** — on every plugin load the free model catalog is refreshed in the background from the gateway (membership) plus [models.dev](https://github.com/sst/models.dev) (`name` / `limit.context` / `limit.output` metadata). Failures keep the built-in catalog; a custom `models:` list in settings is never overwritten. Disable with `autoSyncModels: false`.

## Configuration

The adapter is configurable through DSH's settings system (`llm-opencode` section in `settings.yaml`). Changes take effect immediately without restart.

| Setting | Default | Description |
|---|---|---|
| `baseURL` | `https://opencode.ai/zen/v1` | Gateway endpoint |
| `apiKeyEnv` | `OPENCODE_API_KEY` | Credential store key for the API token |
| `maxTokens` | `128000` | Default max output tokens per request |
| `defaultContextWindow` | `1000000` | Fallback context window for unknown models |
| `streamIdleTimeoutMs` | `300000` | Max idle time (ms) before stream is considered dead |
| `models` | *(built-in catalog)* | Override the model catalog |
| `autoSyncModels` | `true` | Refresh the free model catalog from the gateway + models.dev on every startup |
| `retryPolicy` | *(built-in)* | Retry behavior for transient errors |

### Example `settings.yaml` snippet

```yaml
llm-opencode:
  baseURL: "https://opencode.ai/zen/v1"
  maxTokens: 64000
  models:
    - id: deepseek-v4-flash-free
      name: DeepSeek V4 Flash Free
      contextWindow: 200000
      maxTokens: 128000
```

See [`settings.example.yaml`](settings.example.yaml) for a full annotated example.

## Bundle Patch

The included `cordis.patch.yml` registers the `llm-opencode` plugin row into the DSH bundle loader, so the plugin is auto-loaded when installed into a profile.

## Development

```bash
npm install
npm test
npm run lint
```

## Requirements

- DeepSeek Harness `>= 0.1.0-rc.7`
- `@deepseek-ai/cordis ^4.0.1` (peer dependency)

## License

MIT © [bobowsh](https://github.com/bobowsh)
