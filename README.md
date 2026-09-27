# dsh-llm-opencode

**中文** | [English](README.en.md)

[![npm version](https://img.shields.io/npm/v/dsh-llm-opencode)](https://www.npmjs.com/package/dsh-llm-opencode)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![DSH Plugin](https://img.shields.io/badge/DSH-Plugin-blue)](https://github.com/topics/dsh-plugin)

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的 OpenCode Zen 免费模型提供方适配器。

在 DSH 的 LLM 接缝中注册 `opencode-zen` 提供方路由，让你的编码 agent 直接使用 OpenCode Zen 的免费模型——**免费模型无需 API key**，无需信用卡，零配置开箱即用。

## 免费模型

内置目录（2026-08-29 已对网关 + [models.dev](https://github.com/sst/models.dev) 核实；每次启动自动刷新，每周六 CI 定时同步）：

| 模型 | ID | 上下文 | 最大输出 | 备注 |
|---|---|---|---|---|
| DeepSeek V4 Flash Free | `deepseek-v4-flash-free` | 200K | 128K | DeepSeek V4 Flash，SWE-bench 约 79% |
| Nemotron 3 Ultra Free | `nemotron-3-ultra-free` | 1M | 128K | NVIDIA 旗舰，超大上下文 |
| Nemotron 3.5 Lightning Free | `nemotron-3.5-lightning-free` | 128K | 128K | NVIDIA 快速版 |
| MiMo V2.5 Free | `mimo-v2.5-free` | 200K | 32K | 小米编码模型 |
| Hy3 Free | `hy3-free` | 190K | 64K | 腾讯混元 HY3 |
| Laguna S 2.1 Free | `laguna-s-2.1-free` | 256K | 32K | |
| Muse Spark 1.2 Free | `muse-spark-1.2-contributor-free` | 128K | 128K | |
| Ling 3.0 Flash Fin Free | `ling-3.0-flash-fin-free` | 128K | 128K | 金融向免费模型（models.dev 未声明上下文/输出上限，按 128K 兜底） |
| Big Pickle | `big-pickle` | 200K | 32K | 隐身通用模型 |

> 免费模型由 OpenCode Zen 公共网关提供服务，可用性可能变化；适配器会从 `/models` 端点自动发现带 `free` 标记的模型，内置目录也会在每次启动时后台重新同步（见下文「启动目录同步」）。

## 安装

```bash
# 从 npm 安装（预构建，推荐）
dsh plugin --profile web add dsh-llm-opencode

# 或直接从 GitHub 安装
dsh plugin --profile web add "github:bobowsh/dsh-llm-opencode#main"
```

## 快速上手

1. 把插件装进你的 DSH profile（见上文）。
2. 打开 DSH Web 设置 → 模型 → 选择 **OpenCode Zen** 作为提供方。
3. 选一个免费模型（如 `deepseek-v4-flash-free`）直接开始编码——无需 API key。

> 付费模型需要 API key：在 DSH 凭证中设置 `OPENCODE_API_KEY`（设置 → 凭证），或作为环境变量导出。

## 工作原理

本插件实现 `@deepseek-ai/dsh-llm` 的 `LlmAdapter` 接口，注册单个提供方路由 `opencode-zen`。当 DSH 把请求路由到该提供方时：

1. **序列化**——harness 消息被翻译为 OpenAI 兼容的 chat completions 请求（纯文本；图片会以 `UNSUPPORTED_CONTENT` 拒绝）。
2. **流式**——SSE 响应经 `eventsource-parser` 解析，翻译为 harness 的 `StreamChunk` 事件（`block-start`、`text-delta`、`reasoning-delta`、`tool-call-delta`、`usage`、`finish`）。
3. **身份标识**——请求携带 `User-Agent: opencode/1.0.0` 等头以满足 OpenCode Zen 的客户端身份校验（默认的 `deepseek-harness/...` user-agent 会被网关拒绝）。
4. **凭证**——从 DSH 凭证存储（环境变量 `OPENCODE_API_KEY`）或环境中解析 API key。免费模型无需 key；付费模型需要。
5. **模型发现**——注册发现处理器，从网关拉取 `/models` 并过滤带 `free` 标记的条目。
6. **启动目录同步**——每次插件加载时，在后台从网关（成员资格）+ [models.dev](https://github.com/sst/models.dev)（`name` / `limit.context` / `limit.output` 元数据）刷新免费模型目录。失败时保留内置目录；设置中自定义的 `models:` 列表永不被覆盖。可用 `autoSyncModels: false` 关闭。

## 配置

**开箱即用，无需手动配置。** 插件装入 profile 后自动注册（见「Bundle 补丁」），所有配置项都有合理默认值，`settings.yaml` 里**不需要**手工添加任何内容。

只有需要覆盖默认值时才配置：优先在 DSH Web 设置 → 模型页面修改（所见即所得），或在 profile 的 `settings.yaml` 的 `llm-opencode` 节中覆盖个别字段。改动立即生效，无需重启。

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `baseURL` | `https://opencode.ai/zen/v1` | 网关端点 |
| `apiKeyEnv` | `OPENCODE_API_KEY` | API token 的凭证存储键 |
| `maxTokens` | `128000` | 每次请求的默认最大输出 token 数 |
| `defaultContextWindow` | `1000000` | 未知模型的兜底上下文窗口 |
| `streamIdleTimeoutMs` | `300000` | 流被视为死亡前的最大空闲时间（毫秒） |
| `models` | *（内置目录）* | 覆盖模型目录 |
| `autoSyncModels` | `true` | 每次启动时从网关 + models.dev 刷新免费模型目录 |
| `retryPolicy` | *（内置）* | 瞬时错误的重试行为 |

### `settings.yaml` 示例（可选）

只有要覆盖默认值时才需要添加，以下仅为示意：

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

完整带注释示例见 [`settings.example.yaml`](settings.example.yaml)。

## Bundle 补丁

随附的 `cordis.patch.yml` 会把 `llm-opencode` 插件行注册进 DSH bundle 加载器，插件装入 profile 后即自动加载。

## 开发

```bash
npm install
npm test
npm run lint
```

## 环境要求

- DeepSeek Harness `>= 0.1.7`（本插件使用了 0.1.7 起才稳定化的 `LlmAdapter` 归因头契约、`loader/volatile-update` 配置注入与 `dsh-util-values` 的 `deepEqualJson`，且不再依赖 0.1.2 起已移除的 `@deepseek-ai/dsh-settings` 的 `installSettingsSection`/`settingsNamespace`）
- `@deepseek-ai/cordis ~4.0.4`（peer dependency）

> 免费模型目录由网关 `/models` 端点动态发现并在插件加载时后台同步，因此即使内置目录因网关调整而过时，运行时也会自动刷新（见上「工作原理 · 模型发现」）。

## 许可证

MIT © [bobowsh](https://github.com/bobowsh)
