# dsh-llm-opencode

OpenCode Zen free model provider adapter for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH).

Registers the `opencode-zen` provider route in DSH's LLM seam, giving your coding agent access to OpenCode Zen's free-tier models — **no API key required for free models**, no credit card, no setup friction.

## Free Models

| Model | ID | Context | Max Output | Notes |
|---|---|---|---|---|
| DeepSeek V4 Flash Free | `deepseek-v4-flash-free` | 200K | 128K | DeepSeek's V4 Flash, SWE-bench ~79% |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` | 1M | 128K | NVIDIA's flagship, huge context |
| MiMo V2.5 Free | `mimo-v2.5-free` | 200K | 32K | Xiaomi's coding model |
| Big Pickle | `big-pickle` | 200K | 128K | Stealth general-purpose model |

> Free models are served through OpenCode Zen's public gateway. Availability may change; the adapter auto-discovers models tagged `free` from the `/models` endpoint.

## Install

```bash
# Into a DSH web profile
dsh plugin --profile web add dsh-llm-opencode

# Or from GitHub directly
dsh plugin --profile web add "github:bobowsh/dsh-llm-opencode#main"
```

## How It Works

This plugin implements the `LlmAdapter` interface from `@deepseek-ai/dsh-llm` and registers a single provider route `opencode-zen`. When DSH routes a request to this provider:

1. **Serialization** — harness messages are translated to OpenAI-compatible chat completions (text-only; images are rejected with `UNSUPPORTED_CONTENT`).
2. **Streaming** — SSE responses are parsed via `eventsource-parser` and translated into harness `StreamChunk` events (`block-start`, `text-delta`, `reasoning-delta`, `tool-call-delta`, `usage`, `finish`).
3. **Identity** — requests carry `User-Agent: opencode/1.0.0` and related headers to satisfy OpenCode Zen's client identity check (the default `deepseek-harness/...` user-agent is rejected by the gateway).
4. **Credentials** — resolves the API key from DSH's credential store (env var `OPENCODE_API_KEY`) or the ambient environment. Free models work without a key; paid models require one.
5. **Model discovery** — registers a discovery handler that fetches `/models` from the gateway and filters for `free`-tagged entries.

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

## Bundle Patch

The included `cordis.patch.yml` registers the `llm-opencode` plugin row into the DSH bundle loader, so the plugin is auto-loaded when installed into a profile.

## Requirements

- DeepSeek Harness `>= 0.1.0-rc.7`
- `@deepseek-ai/cordis ^4.0.1` (peer dependency)

## License

MIT
