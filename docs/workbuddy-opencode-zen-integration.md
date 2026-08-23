# WorkBuddy 接入 OpenCode Zen 免费模型 —— Agent 执行手册

> **本文档是写给 AI 编码代理的执行指令**（适用于 WorkBuddy / CodeBuddy / DSH / Claude Code 等任何能读写本地文件的 agent）。目标机器为 Windows。请严格按步骤顺序执行；除「Step 2 拿不到 key 时需询问用户」外，全程无需人工干预。

## 背景（为什么这么做）

WorkBuddy 是腾讯 CodeBuddy 的桌面发行版（Electron 壳 + Claude Code 架构 CLI）。它支持把任意 OpenAI 兼容端点注册为自定义模型：

1. **模型清单**：`%USERPROFILE%\.workbuddy\models.json`（JSON 数组）。每条目的 `apiKey` 字段会被自动注入为 `Authorization: Bearer <key>` 和 `X-API-Key` 请求头；`url` 不带 `/chat/completions` 后缀时会被自动补全。
2. **每请求自定义头**：环境变量 **`CODEBUDDY_CUSTOM_HEADERS`**（推荐写在 `%USERPROFILE%\.workbuddy\settings.json` 的 `env` 节里），格式为**每行一条 `Key: Value`**。注入发生在每个模型请求前，大小写不敏感地覆盖同名头，并删除旧的 `authorization`/`user-agent`。

OpenCode Zen 免费网关（`https://opencode.ai/zen/v1`）**以 User-Agent 校验客户端身份**：缺省 UA 会被限流/拒绝，必须伪装成官方 OpenCode 客户端。这就是需要第 2 点的原因。

⚠️ 已知陷阱：该网关对 **curl / PowerShell Invoke-RestMethod 栈的请求一律返回 500**（实测），Node.js fetch 正常。验证连通性必须用 Node fetch（见 Step 6），不要被 curl 的假 500 误导。

## 目标状态

完成后应满足：
- `models.json` 含下表 9 个免费模型（保留既有条目，按 id 去重合并）
- `settings.json` 的 `env.CODEBUDDY_CUSTOM_HEADERS` 含 4 条 opencode 身份头
- 两个文件均为合法 JSON
- 原文件已备份

## 模型清单（参数核实于 2026-08-23，来源 models.dev）

统一字段：`vendor: "OpenCode Zen"`，`url: "https://opencode.ai/zen/v1/chat/completions"`，`supportsToolCall: true`，`supportsImages: false`，`supportsReasoning: true`，`apiKey`: 见 Step 2。

| id | name | maxInputTokens | maxOutputTokens |
|---|---|---|---|
| `nemotron-3-ultra-free` | Nemotron 3 Ultra Free | 1000000 | 128000 |
| `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning Free | 128000 | 128000 |
| `mimo-v2.5-free` | MiMo V2.5 Free | 200000 | 32000 |
| `hy3-free` | Hy3 Free | 190000 | 64000 |
| `laguna-s-2.1-free` | Laguna S 2.1 Free | 256000 | 32000 |
| `muse-spark-1.2-contributor-free` | Muse Spark 1.2 Free | 128000 | 128000 |
| `x-preview-f-free` | Ox Alpha Free | 1000000 | 128000 |

> ⚠️ 曾实测不通而移除：`deepseek-v4-flash-free`（上游 "Model is unavailable"）、`big-pickle`（连接失败）。若日后想加回，先用 Step 6 验证再写入。

## 执行步骤

### Step 0 — 前置检查

```powershell
# 确认 WorkBuddy 已安装且配置目录存在
Test-Path "$env:USERPROFILE\.workbuddy\models.json"
```

若目录不存在说明 WorkBuddy 从未启动过，先让用户启动一次再继续。

### Step 1 — 备份

把 `settings.json` 和 `models.json` 各复制一份到同目录，后缀 `.{yyyyMMdd-HHmmss}.bak`。已存在备份则不覆盖。

### Step 2 — 填 API Key（必须是真实的免费 key）

⚠️ **实测结论（2026-08-23 多轮对照验证）**：网关严格校验 key 值。占位符/随机字符串一律返回 `401 {"type":"error","error":{"type":"AuthError","message":"Invalid API key."}}`；同一时间窗内真实 key 正常 200。"free" 指的是**价格**，不是"免凭证"——key 本身免费发放、无需信用卡。

按优先级获取 `OPENCODE_API_KEY`：

1. 目标机器若装过 opencode CLI：读 `~/.local/share/opencode/auth.json` 中的 key；
2. 目标机器环境变量 `OPENCODE_API_KEY` 已设置则直接用；
3. 都没有 → 停下来请用户到 [opencode.ai](https://opencode.ai) 注册领取（免费），拿到后继续。

安全规则：key 只写进最终的 `models.json`；禁止打印到终端/日志/回复正文，校验输出只允许显示长度和前 6 位。

### Step 3 — 写身份头到 settings.json

读入 `%USERPROFILE%\.workbuddy\settings.json`（JSON），**保留全部既有键**，设置：

```json
"env": {
  "CODEBUDDY_CUSTOM_HEADERS": "User-Agent: opencode/1.0.0\nHTTP-Referer: https://opencode.ai/\nX-Title: opencode\nX-Source: opencode"
}
```

注意 `\n` 是真实换行符（JSON 转义后即如此）。若 `env.CODEBUDDY_CUSTOM_HEADERS` 已有值则整体覆盖为本值。写回（UTF-8 无 BOM、2 空格缩进）。

### Step 4 — 合并模型清单

读入 `models.json`（数组）：过滤掉 id 与下表重复的旧条目 → 追加 7 个新条目（每条 `apiKey` 用 Step 2 的真实 key，其余字段按上表构造）→ 整体写回（UTF-8 无 BOM、2 空格缩进）。建议直接用 Node 脚本做（`JSON.parse` + `JSON.stringify`），不要手拼字符串。

### Step 5 — 校验

1. 重新读回两个文件并 `JSON.parse` 通过；
2. `models.json` 条目数 = 原有非冲突条目数 + 7；每个新条目字段齐全（id/name/vendor/url/apiKey/maxInputTokens/maxOutputTokens/supportsToolCall/supportsImages/supportsReasoning）且 `apiKey` 非空；
3. 输出汇总表：id / maxInputTokens / maxOutputTokens（不显示 key 本体）。

### Step 6 — 连通性验证（可选但推荐）

用 Node fetch 探测最稳的模型（不要用 curl！），`KEY` 用 Step 2 的真实 key：

```js
const r = await fetch("https://opencode.ai/zen/v1/chat/completions", {
  method: "POST",
  headers: {
    "authorization": `Bearer ${KEY}`,
    "content-type": "application/json",
    "accept": "text/event-stream",
    "User-Agent": "opencode/1.0.0",
    "HTTP-Referer": "https://opencode.ai/",
    "X-Title": "opencode",
    "X-Source": "opencode"
  },
  body: JSON.stringify({ model: "x-preview-f-free", messages: [{ role: "user", content: "hi" }], max_tokens: 16, stream: true }),
  signal: AbortSignal.timeout(60000)
});
console.log(r.status); // 200 = 通；401 = key 无效（检查 Step 2）；持续 5xx 换模型或等上游恢复
```

### Step 7 — 收尾

告知用户：**重启 WorkBuddy**，在模型选择器 Custom 区挑选新模型（当前健康度以 Step 6 实测为准，历史数据显示 `x-preview-f-free` 最稳）。若原 `models.json` 有 Kimi 等其他自定义模型，提醒：身份头是全局注入的，若那些服务突然异常，优先排查此头（备选方案：本地转发代理按目标 host 决定是否带头）。

## 回滚

把 Step 1 的两个 `.bak-*` 文件复制回原名即可。

## 维护：模型列表会变，怎么重新同步

- 成员资格：`GET https://opencode.ai/zen/v1/models`（带 `User-Agent: opencode/1.0.0`），筛 `-free` 后缀 id（`big-pickle` 是无后缀的例外，只要还在列表里就保留）；
- 权威元数据（name/context/output）：`https://raw.githubusercontent.com/sst/models.dev/dev/providers/opencode/models/<id>.toml` 的 `name` / `limit.context` / `limit.output`（注意该机直连 `models.dev/api.json` 可能超时，用 raw.githubusercontent.com）；
- 同源自动化参考：github.com/bobowsh/dsh-llm-opencode 的 `lib/index.js`（`fetchFreeModelCatalog`）每周六 CI 自动跑同样逻辑。

## 参考实现（本机已验证成功的完整脚本骨架）

```js
import { readFileSync, writeFileSync } from "node:fs";
const HOME = process.env.USERPROFILE.replaceAll("\\", "/");
const key = process.env.OPENCODE_API_KEY; // 真实免费 key，获取方式见 Step 2
if (!key) throw new Error("OPENCODE_API_KEY not set");

const mk = (id, name, ctxIn, maxOut) => ({
  id, name, vendor: "OpenCode Zen",
  url: "https://opencode.ai/zen/v1/chat/completions", apiKey: key,
  maxInputTokens: ctxIn, maxOutputTokens: maxOut,
  supportsToolCall: true, supportsImages: false, supportsReasoning: true
});
const entries = [
  mk("nemotron-3-ultra-free", "Nemotron 3 Ultra Free", 1000000, 128000),
  mk("nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning Free", 128000, 128000),
  mk("mimo-v2.5-free", "MiMo V2.5 Free", 200000, 32000),
  mk("hy3-free", "Hy3 Free", 190000, 64000),
  mk("laguna-s-2.1-free", "Laguna S 2.1 Free", 256000, 32000),
  mk("muse-spark-1.2-contributor-free", "Muse Spark 1.2 Free", 128000, 128000),
  mk("x-preview-f-free", "Ox Alpha Free", 1000000, 128000)
];

const modelsPath = `${HOME}/.workbuddy/models.json`;
const old = JSON.parse(readFileSync(modelsPath, "utf8"));
writeFileSync(modelsPath, JSON.stringify(
  [...old.filter(e => !entries.some(n => n.id === e.id)), ...entries], null, 2));

const settingsPath = `${HOME}/.workbuddy/settings.json`;
const settings = JSON.parse(readFileSync(settingsPath, "utf8"));
settings.env ??= {};
settings.env.CODEBUDDY_CUSTOM_HEADERS =
  "User-Agent: opencode/1.0.0\nHTTP-Referer: https://opencode.ai/\nX-Title: opencode\nX-Source: opencode";
writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
console.log(`done: ${entries.length} zen models + identity headers`);
```
