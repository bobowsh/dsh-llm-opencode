import z from "@deepseek-ai/schemastery";
import {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  ToolCallId,
  EMPTY_RESPONSE_CODE,
  LlmAdapter,
  LlmError,
  ProviderRequestId,
  QUOTA_EXCEEDED_CODE,
  RetryPolicySchema,
  assertUsableApiKey,
  attributionHeaders,
  contentHasImage,
  isContextWindowExceededError,
  isQuotaExceededError,
  resolveRetryPolicy
} from "@deepseek-ai/dsh-llm";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { deepEqualJson } from "@deepseek-ai/dsh-util-values";
import { MAX_TIMER_DELAY_MS, idleWatchdog, timeoutOf } from "@deepseek-ai/dsh-timeout";
import { EventSourceParserStream } from "eventsource-parser/stream";
//#region 序列化：将 harness 消息转成 opencode zen 网关的 OpenAI 兼容请求体
/**
 * 展平消息中的文本块（用户消息与工具返回共用）。
 * @param blocks - harness 消息内容块。
 * @returns 拼接后的纯文本。
 */
function flattenText(blocks) {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/**
 * 拒绝图片内容：opencode zen 免费网关走文本通道，静默丢弃会误导调用方。
 * @param blocks - harness 消息内容块。
 */
function assertTextOnly(blocks) {
  if (contentHasImage(blocks)) {
    throw new LlmError("The opencode zen adapter does not support image content.", "UNSUPPORTED_CONTENT");
  }
}

/**
 * 序列化一条 assistant 消息：文本 + 工具调用（reasoning_content 在
 * opencode 网关表现为普通文本或独立字段，这里按标准 OpenAI 格式回放）。
 * @param message - harness 的 assistant 消息。
 * @returns wire 上的 assistant 消息。
 */
function serializeAssistant(message) {
  const text = flattenText(message.content);
  const toolCalls = message.content
    .filter((block) => block.type === "tool-call")
    .map((block) => ({
      id: block.id,
      type: "function",
      function: {
        name: block.name,
        arguments: block.arguments
      }
    }));
  return {
    role: "assistant",
    content: text,
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
  };
}

/**
 * 序列化整段会话。工具结果拆成独立的 `{role:'tool'}` wire 消息；
 * 混合 user 消息先发文本再发其工具结果。
 * @param messages - harness 会话，按时间顺序。
 * @returns wire 消息数组，顺序保持。
 */
function serializeMessages(messages) {
  const wire = [];
  for (const message of messages) {
    assertTextOnly(message.content);
    if (message.role === "system") {
      wire.push({ role: "system", content: flattenText(message.content) });
      continue;
    }
    if (message.role === "assistant") {
      wire.push(serializeAssistant(message));
      continue;
    }
    const toolResults = message.content.filter((block) => block.type === "tool-result");
    const text = flattenText(message.content);
    if (text.length > 0 || toolResults.length === 0) {
      wire.push({ role: "user", content: text });
    }
    for (const result of toolResults) {
      wire.push({
        role: "tool",
        tool_call_id: result.toolCallId,
        content: flattenText(result.content) || "(no output)"
      });
    }
  }
  return wire;
}

/**
 * 构造完整的 wire 请求体。始终走流式 + usage 上报；
 * opencode 网关是 OpenAI 兼容接口，不发送 DeepSeek 专有的 thinking 字段。
 * @param options - harness 请求（模型、历史、system、tools、采样参数）。
 * @returns chat-completions 请求体。
 */
function serializeRequest(options) {
  const messages = [];
  if (options.system !== void 0) messages.push({ role: "system", content: options.system });
  messages.push(...serializeMessages(options.messages));
  const tools = options.tools?.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }
  }));
  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== void 0 && tools.length > 0 ? { tools } : {},
    ...options.temperature !== void 0 ? { temperature: options.temperature } : {},
    ...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens },
    ...options.stop !== void 0 ? { stop: options.stop } : {}
  };
}
//#endregion
//#region SSE 解析与 translate
/**
 * 解析 SSE 字节流为数据载荷。以 `[DONE]` 结尾；若流未经 `[DONE]` 就结束
 * 则抛 `STREAM_CLOSED`（截断的响应不可信）。
 * @param stream - 原始 SSE 字节流。
 * @param onComment - 可选的传输层活动回调；注释不会进入载荷流。
 * @returns 按到达顺序产生的 data 载荷，最后是 `[DONE]` 哨兵。
 */
async function* parseSse(stream, onComment) {
  const events = stream
    .pipeThrough(new TextDecoderStream())
    .pipeThrough(new EventSourceParserStream({ onComment }));
  for await (const { data } of events) {
    yield data;
    if (data === "[DONE]") return;
  }
  throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}

/**
 * 把 wire 的 finish_reason 词表映射到 harness 的 FinishReason。
 * @param reason - wire 的 finish_reason 字符串。
 * @returns 映射结果；未知值（content_filter 等）变为 error 且 code 为大写原文。
 */
function mapFinishReason(reason) {
  switch (reason) {
    case "stop": return { kind: "stop" };
    case "tool_calls": return { kind: "tool-calls" };
    case "length": return { kind: "max-tokens" };
    default: return {
      kind: "error",
      failure: {
        message: `model stopped: ${reason}`,
        code: reason.toUpperCase()
      }
    };
  }
}

/**
 * 映射 wire usage 到 harness 的 TokenUsage。opencode 网关的 prompt_tokens
 * 按 DeepSeek 惯例含缓存命中（cached_tokens），harness 约定是不重叠计数，
 * 因此缓存读从 inputTokens 中剔除。
 * @param usage - wire usage。
 * @returns 不重叠的 harness 计数。
 */
function mapUsage(usage) {
  const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
  const reasoning = usage.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
    outputTokens: usage.completion_tokens,
    ...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
  };
}

/** 组装一个开放 block 的最终 ContentBlock。 */
function closeBlock(block) {
  switch (block.kind) {
    case "text": return { type: "text", text: block.text };
    case "reasoning": return { type: "reasoning", text: block.text };
    case "tool-call": return {
      type: "tool-call",
      id: ToolCallId(block.callId ?? ""),
      name: block.name ?? "",
      arguments: block.text
    };
  }
}

/**
 * 消费 SSE 数据载荷并产出 StreamChunk。`block-end`、usage、finish
 * 统一推迟到 `[DONE]` 配合出现，保证 finish 后不再有内容块。
 * @param payloads - parseSse 的载荷流。
 * @returns 增量到达的内容块；畸形 JSON 以 `MALFORMED_RESPONSE` 中止。
 */
async function* translate(payloads) {
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const toolBlocks = /* @__PURE__ */ new Map();
  const order = [];
  let pendingFinish;
  let pendingUsage;
  function open(kind) {
    const block = { index: nextIndex++, kind, text: "" };
    order.push(block);
    return block;
  }
  for await (const payload of payloads) {
    if (payload === "[DONE]") {
      for (const block of order) {
        yield { type: "block-end", index: block.index, block: closeBlock(block) };
      }
      if (pendingUsage) yield { type: "usage", usage: pendingUsage };
      const reason = pendingFinish ?? { kind: "stop" };
      yield {
        type: "finish",
        reason: reason.kind === "stop" && order.length === 0
          ? {
              kind: "error",
              failure: {
                message: "model returned a completed response with no content",
                code: EMPTY_RESPONSE_CODE
              }
            }
          : reason
      };
      return;
    }
    let chunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
    }
    for (const choice of chunk.choices ?? []) {
      const delta = choice.delta;
      const reasoning = delta?.reasoning_content;
      if (typeof reasoning === "string" && reasoning.length > 0) {
        if (!reasoningBlock) {
          reasoningBlock = open("reasoning");
          yield { type: "block-start", index: reasoningBlock.index, blockType: "reasoning" };
        }
        reasoningBlock.text += reasoning;
        yield { type: "reasoning-delta", index: reasoningBlock.index, text: reasoning };
      }
      const content = delta?.content;
      if (typeof content === "string" && content.length > 0) {
        if (!textBlock) {
          textBlock = open("text");
          yield { type: "block-start", index: textBlock.index, blockType: "text" };
        }
        textBlock.text += content;
        yield { type: "text-delta", index: textBlock.index, text: content };
      }
      for (const call of delta?.tool_calls ?? []) {
        let block = toolBlocks.get(call.index);
        if (!block) {
          block = open("tool-call");
          toolBlocks.set(call.index, block);
          yield { type: "block-start", index: block.index, blockType: "tool-call" };
        }
        if (call.id !== void 0) block.callId = call.id;
        if (call.function?.name !== void 0) block.name = call.function.name;
        const fragment = call.function?.arguments ?? "";
        block.text += fragment;
        yield {
          type: "tool-call-delta",
          index: block.index,
          id: ToolCallId(block.callId ?? ""),
          ...block.name !== void 0 ? { name: block.name } : {},
          argumentsDelta: fragment
        };
      }
      if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
    }
    if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
  }
  throw new LlmError("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}
//#endregion
//#region OpenCodeAdapter
/** 默认的最大流式读取空闲间隔。 */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 3e5;
/** 默认的请求+响应上下文容量。 */
const DEFAULT_CONTEXT_WINDOW = 1e6;
/** 默认单请求输出 token 上限。 */
const DEFAULT_MAX_TOKENS = 128e3;
const STREAM_IDLE_TIMEOUT_CODE = "LLM_STREAM_IDLE_TIMEOUT";
/** 该适配器支持的全部推理档位（OpenAI 兼容接口不传 effort，仅用于 UI 展示）。 */
const REASONING_EFFORTS = [
  { id: "off", name: "Off" },
  { id: "low", name: "Low" },
  { id: "high", name: "High" },
  { id: "max", name: "Max" }
];

/**
 * 将目录条目转为 harness 的只读模型元数据。
 * @param provider - provider route id。
 * @param model - 目录中的一个模型。
 * @returns 脱敏后的 discoverable 模型信息。
 */
function modelInfo(provider, model) {
  return {
    provider,
    id: model.id,
    name: model.name ?? model.id,
    ...model.description === void 0 ? {} : { description: model.description },
    inputModalities: model.supportsImages === true ? ["text", "image"] : ["text"]
  };
}

/**
 * 解析 Retry-After 头。
 * @param value - 头部原始值，可能为 null。
 * @returns 延迟毫秒数，无法解析时返回 undefined。
 */
function providerRetryAfterMs(value) {
  if (value === null) return void 0;
  if (/^\d+$/.test(value)) {
    const delay = Number(value) * 1e3;
    return Number.isFinite(delay) && delay > 0 ? delay : void 0;
  }
  const delay = Date.parse(value) - Date.now();
  return Number.isFinite(delay) && delay > 0 ? delay : void 0;
}

/**
 * 从响应头提取请求 id。
 * @param headers - provider 响应头。
 * @returns 规范化后的 ProviderRequestId，无则 undefined。
 */
function requestId(headers) {
  const value = headers.get("x-request-id") ?? headers.get("x-opencode-request-id");
  return value === null || value.length === 0 ? void 0 : ProviderRequestId(value);
}

/**
 * 将 HTTP 状态映射为稳定的 LlmError code。
 * @param status - 非 2xx 响应的状态码。
 * @param error - 解析出的 provider 错误体（若有）。
 * @returns 规范化 harness 错误码。
 */
function httpErrorCode(status, error) {
  if (status === 401 || status === 403) return "AUTH";
  const detail = [error?.code, error?.type, error?.message].filter(Boolean).join(" ");
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE;
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) {
    if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE;
    return "INVALID_REQUEST";
  }
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}

/**
 * OpenCodeAdapter：向 opencode zen 网关发起流式 chat-completions 请求。
 *
 * 与 DeepSeek adapter 最大的差异在请求头：opencode 网关校验客户端身份
 * （User-Agent: opencode/... 缺省时免费模型返回 429 FreeUsageLimitError），
 * 因此这里刻意不调用 dsh-llm 的 attributionHeaders()（其 user-agent 恒为
 * deepseek-harness/...，会被网关拒绝），而是模拟官方 opencode 客户端的
 * 自定义标识头。
 */
var OpenCodeAdapter = class extends LlmAdapter {
  config;
  constructor(config) {
    super();
    this.config = config;
  }
  providerInfo(provider) {
    return {
      id: provider,
      name: "OpenCode Zen"
    };
  }
  providerRetryPolicy(_provider) {
    return this.config.options().retryPolicy;
  }
  listModels(provider) {
    return Promise.resolve(this.config.options().models.map((model) => modelInfo(provider, model)));
  }
  resolveModel(provider, model, _signal) {
    const connection = this.config.options();
    const configured = connection.models.find((entry) => entry.id === model);
    const contextWindow = configured?.contextWindow ?? connection.defaultContextWindow;
    return Promise.resolve({
      ...configured === void 0
        ? { provider, id: model, name: model, inputModalities: ["text"] }
        : modelInfo(provider, configured),
      context: { contextWindow },
      defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens,
      reasoning: {
        efforts: REASONING_EFFORTS,
        defaultEffort: "off"
      }
    });
  }
  async *stream(options) {
    const env_1 = { stack: [], error: void 0, hasError: false };
    try {
      const connection = this.config.options();
      const apiKey = await this.config.resolveApiKey(connection);
      const consumer = new AbortController();
      const watchdog = __addDisposableResource(
        env_1,
        idleWatchdog(
          options.signal === void 0
            ? consumer.signal
            : AbortSignal.any([options.signal, consumer.signal]),
          connection.streamIdleTimeoutMs,
          STREAM_IDLE_TIMEOUT_CODE
        ),
        false
      );
      const iterator = this.request(options, watchdog.signal, connection, apiKey, () => {
        watchdog.pulse();
      })[Symbol.asyncIterator]();
      let exhausted = false;
      try {
        while (true) {
          const result = await watchdog.next(iterator);
          if (result.done) {
            exhausted = true;
            return;
          }
          yield result.value;
        }
      } catch (error) {
        if (timeoutOf(watchdog.signal, STREAM_IDLE_TIMEOUT_CODE) !== void 0) {
          throw new LlmError(`OpenCode stream idle timeout after ${connection.streamIdleTimeoutMs}ms`, "TIMEOUT", { cause: error });
        }
        if (options.signal?.aborted) {
          throw new LlmError("OpenCode request aborted by caller", "ABORTED", { cause: error });
        }
        if (error instanceof LlmError) throw error;
        throw new LlmError(`OpenCode API stream from ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
      } finally {
        consumer.abort("OpenCode stream consumer stopped");
        if (!exhausted && iterator.return !== void 0) {
          try {
            await iterator.return();
          } catch (_abortedTransportTeardown) {}
        }
      }
    } catch (e_1) {
      env_1.error = e_1;
      env_1.hasError = true;
    } finally {
      __disposeResources(env_1);
    }
  }
  /**
   * 发起单个请求并产出翻译后的 StreamChunk。
   * @param options - harness 请求。
   * @param signal - 合并后的中止信号（调用方 + 空闲看门狗）。
   * @param connection - 已解析的连接事实。
   * @param apiKey - 已解析的 bearer token。
   * @param onComment - SSE 注释回调，用于喂给看门狗。
   */
  async *request(options, signal, connection, apiKey, onComment) {
    const body = serializeRequest(options);
    const payload = JSON.stringify(body);
    // 先铺 dsh-llm 强制要求的归因头（满足 harness 契约），再覆盖 User-Agent：
    // opencode zen 网关以 User-Agent 校验客户端身份，必须是 opencode/1.0.0
    // 才能使用免费额度，因此这里显式覆盖 attributionHeaders() 写入的
    // deepseek-harness/... 默认值。其余归因头（如有）仍随请求发送。
    const headers = {
      ...attributionHeaders(),
      "content-type": "application/json",
      "accept": "text/event-stream",
      "authorization": `Bearer ${apiKey}`,
      "User-Agent": "opencode/1.0.0",
      "HTTP-Referer": "https://opencode.ai/",
      "X-Title": "opencode",
      "X-Source": "opencode"
    };
    let response;
    try {
      response = await fetch(`${connection.baseURL}/chat/completions`, {
        method: "POST",
        headers,
        body: payload,
        signal
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new LlmError(`OpenCode API request to ${connection.baseURL} failed`, "TRANSPORT", { cause: error });
    }
    if (!response.ok) {
      let message = `OpenCode API error (HTTP ${response.status})`;
      let providerError;
      try {
        providerError = (await response.json()).error;
        if (providerError?.message) message = providerError.message;
      } catch {}
      const delay = providerRetryAfterMs(response.headers.get("retry-after"));
      const id = requestId(response.headers);
      throw new LlmError(message, httpErrorCode(response.status, providerError), {
        status: response.status,
        ...delay === void 0 ? {} : { providerRetryAfterMs: delay },
        ...id === void 0 ? {} : { requestId: id }
      });
    }
    if (!response.body) throw new LlmError("OpenCode API returned no response body", "EMPTY_RESPONSE");
    yield* translate(parseSse(response.body, onComment));
  }
};
//#endregion
//#region 资源管理辅助（与 dsh-llm-deepseek 产物保持一致）
var __addDisposableResource = function (env, value, async) {
  if (value !== null && value !== void 0) {
    if (typeof value !== "object" && typeof value !== "function") throw new TypeError("Object expected.");
    var dispose, inner;
    if (async) {
      if (!Symbol.asyncDispose) throw new TypeError("Symbol.asyncDispose is not defined.");
      dispose = value[Symbol.asyncDispose];
    }
    if (dispose === void 0) {
      if (!Symbol.dispose) throw new TypeError("Symbol.dispose is not defined.");
      dispose = value[Symbol.dispose];
      if (async) inner = dispose;
    }
    if (typeof dispose !== "function") throw new TypeError("Object not disposable.");
    if (inner) dispose = function () {
      try {
        inner.call(this);
      } catch (e) {
        return Promise.reject(e);
      }
    };
    env.stack.push({ value, dispose, async });
  } else if (async) env.stack.push({ async: true });
  return value;
};
var __disposeResources = (function (SuppressedError) {
  return function (env) {
    function fail(e) {
      env.error = env.hasError
        ? new SuppressedError(e, env.error, "An error was suppressed during disposal.")
        : e;
      env.hasError = true;
    }
    var r, s = 0;
    function next() {
      while ((r = env.stack.pop())) {
        try {
          if (!r.async && s === 1) return (s = 0), env.stack.push(r), Promise.resolve().then(next);
          if (r.dispose) {
            var result = r.dispose.call(r.value);
            if (r.async) return (s |= 2), Promise.resolve(result).then(next, function (e) {
              fail(e);
              return next();
            });
          } else s |= 1;
        } catch (e) {
          fail(e);
        }
      }
      if (s === 1) return env.hasError ? Promise.reject(env.error) : Promise.resolve();
      if (env.hasError) throw env.error;
    }
    return next();
  };
})(typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
  var e = new Error(message);
  return (e.name = "SuppressedError"), (e.error = error), (e.suppressed = suppressed), e;
});
//#endregion
//#region 配置解析与入口
/** 插件元数据：名字、依赖注入、命名空间、provider route。 */
const name = "llm-opencode";
const inject = ["llm"];
const PROVIDER = "opencode-zen";
/** 实测可用的 opencode zen 免费模型目录（2026-08-29 自动更新，来源：GET https://opencode.ai/zen/v1/models + models.dev 元数据，共 9 个免费模型；x-preview-f-free 上游已 deprecated 下架，由 ling-3.0-flash-fin-free 替补）。supportsImages 按 models.dev 的 attachment/modalities.input 声明：true=声明支持图片输入，false=声明纯文本或未声明（保守）。 */
const DEFAULT_MODELS = [
  {
    id: "deepseek-v4-flash-free",
    name: "DeepSeek V4 Flash Free",
    description: "opencode zen 免费模型，DeepSeek V4 Flash，200K 上下文。",
    contextWindow: 200000,
    maxTokens: 128000,
    supportsImages: false
  },
  {
    id: "nemotron-3-ultra-free",
    name: "Nemotron 3 Ultra Free",
    description: "opencode zen 免费模型，NVIDIA Nemotron 3 Ultra，1M 上下文。",
    contextWindow: 1000000,
    maxTokens: 128000,
    supportsImages: false
  },
  {
    id: "nemotron-3.5-lightning-free",
    name: "Nemotron 3.5 Lightning Free",
    description: "opencode zen 免费模型，NVIDIA Nemotron 3.5 Lightning，128K 上下文。",
    contextWindow: 128000,
    maxTokens: 128000,
    supportsImages: false
  },
  {
    id: "mimo-v2.5-free",
    name: "MiMo V2.5 Free",
    description: "opencode zen 免费模型，Xiaomi MiMo V2.5（omni：文本/图片/音频/视频），200K 上下文。",
    contextWindow: 200000,
    maxTokens: 32000,
    supportsImages: true
  },
  {
    id: "hy3-free",
    name: "Hy3 Free",
    description: "opencode zen 免费模型，Hy3，190K 上下文。",
    contextWindow: 190000,
    maxTokens: 64000,
    supportsImages: false
  },
  {
    id: "laguna-s-2.1-free",
    name: "Laguna S 2.1 Free",
    description: "opencode zen 免费模型，Laguna S 2.1，256K 上下文。",
    contextWindow: 256000,
    maxTokens: 32000,
    supportsImages: false
  },
  {
    id: "muse-spark-1.2-contributor-free",
    name: "Muse Spark 1.2 Free",
    description: "opencode zen 免费模型，Muse Spark 1.2 Contributor，128K 上下文。",
    contextWindow: 128000,
    maxTokens: 128000,
    supportsImages: false
  },
  {
    id: "ling-3.0-flash-fin-free",
    name: "Ling 3.0 Flash Fin Free",
    description: "opencode zen 免费模型，Ling 3.0 Flash Fin（金融向），128K 上下文（models.dev 未声明上下文/输出上限，按兜底值）。",
    contextWindow: 128000,
    maxTokens: 128000,
    supportsImages: false
  },
  {
    id: "big-pickle",
    name: "Big Pickle",
    description: "opencode zen 免费模型，Big Pickle（隐身模型），200K 上下文。",
    contextWindow: 200000,
    maxTokens: 32000,
    supportsImages: false
  }
];
/** 校验模型目录的 schema。 */
const catalogModel = z.object({
  id: z.string().required(),
  name: z.string(),
  description: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  supportsImages: z.boolean()
});

/**
 * 插件配置 schema，同时作为 `llm-opencode` 设置节形状。
 *
 * 顶层声明为 volatile：配置改动经 `loader/volatile-update` 事件下发到运行中的
 * fiber，无需重启即对下一个请求生效（与 dsh-llm-pi-ai 0.1.7 的模式一致）。
 * 运行时 `config` 是 volatile 包装，调用 `config.get()` 取回纯对象。
 */
const Config = z.object({
  apiKeyEnv: z.string().role("credential-ref").default("OPENCODE_API_KEY"),
  baseURL: z.string(),
  maxTokens: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOKENS),
  defaultContextWindow: z.number().step(1).min(1).default(DEFAULT_CONTEXT_WINDOW),
  models: z.array(catalogModel).default(DEFAULT_MODELS),
  autoSyncModels: z.boolean().default(true),
  streamIdleTimeoutMs: z.number().min(Number.MIN_VALUE).max(MAX_TIMER_DELAY_MS).default(DEFAULT_STREAM_IDLE_TIMEOUT_MS),
  retryPolicy: RetryPolicySchema
}).volatile();

/** 公开网关端点。 */
const PUBLIC_BASE_URL = "https://opencode.ai/zen/v1";

/** models.dev 元数据源（opencode 官方模型元数据仓库，每个模型一个 TOML 文件）。 */
const MODELS_DEV_URL = "https://raw.githubusercontent.com/sst/models.dev/dev/providers/opencode/models";

/** 把上下文档位数格式化成目录描述里的习惯写法：200000 -> "200K"，1000000 -> "1M"。 */
function formatSize(n) {
  return n >= 1000000 && n % 1000000 === 0 ? `${n / 1000000}M` : `${Math.round(n / 1000)}K`;
}

/** 从 id 推导显示名（models.dev 缺条目时的兜底，"hy3-free" -> "Hy3 Free"）。 */
function displayName(id) {
  const bare = id.replace(/-free$/i, "");
  const words = bare.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1));
  return [...words, "Free"].join(" ");
}

/** 解析 models.dev TOML 里需要的字段（正则实现，零依赖）。 */
function parseTomlMeta(text) {
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  // 注意：区块截断的 $ 不能用 /m（多行模式下 \s*$ 会匹配任意行尾，导致区块恒为空）
  const limitBlock = /\[limit\]\s*\n([\s\S]*?)(?=\n\s*\[|$)/.exec(text)?.[1] ?? "";
  const num = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*([\\d_]+)`, "m").exec(limitBlock);
    return m ? Number(m[1].replaceAll("_", "")) : undefined;
  };
  // 识图能力：attachment = true 或 modalities.input 含 "image" 才算支持；
  // 两者都缺失时返回 undefined（未知，不臆断）。
  const modalitiesBlock = /\[modalities\]\s*\n([\s\S]*?)(?=\n\s*\[|$)/.exec(text)?.[1] ?? "";
  const inputList = /^\s*input\s*=\s*\[([^\]]*)\]/m.exec(modalitiesBlock)?.[1] ?? "";
  const declaresImage = /"image"/i.test(inputList);
  const attachment = /^\s*attachment\s*=\s*(true|false)\s*$/m.exec(text);
  const supportsImages = attachment !== null
    ? attachment[1] === "true" && (inputList === "" || declaresImage)
    : inputList === "" ? undefined : declaresImage;
  return { name, context: num("context"), output: num("output"), supportsImages };
}

/** 拉取单个模型的 models.dev 元数据；404/网络失败返回 null（重试 3 次，最终失败打 warn）。 */
async function fetchModelsDevMeta(id, metaURL, signal, warn) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const timeout = AbortSignal.timeout(30000);
      const r = await fetch(`${metaURL}/${encodeURIComponent(id)}.toml`, {
        headers: { "User-Agent": "dsh-llm-opencode-catalog-sync" },
        signal: signal === void 0 ? timeout : AbortSignal.any([signal, timeout])
      });
      if (!r.ok) {
        if (r.status === 404) return null; // models.dev 上没有该模型 —— 正常缺失，不重试
        throw new Error(`HTTP ${r.status}`);
      }
      return parseTomlMeta(await r.text());
    } catch (error) {
      if (signal?.aborted) return null;
      if (attempt === 3) {
        warn(`llm-opencode: models.dev metadata unavailable for ${id} (${error?.message ?? error}); keeping existing metadata`);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  return null;
}

/** 并发受限的 map。 */
async function mapPool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  }));
  return out;
}

/**
 * 从 opencode zen 网关 + models.dev 同步免费模型目录。
 * - 成员资格以网关 /models 为准（id 含 free 的即免费档；big-pickle 这类
 *   不带 free 后缀的免费模型只要上游还在就保留，消失才移除）。
 * - 元数据（name/contextWindow/maxTokens）以 models.dev 为准；已有条目的
 *   手写描述保留，仅修正其中上下文档位数字；models.dev 上没有的新模型
 *   退化为从 id 派生的 128K/128K 默认值。
 * @param currentCatalog - 当前目录（用于保留手写描述与识别新增/下架）。
 * @param options - { baseURL, metaURL, signal, warn }。
 * @returns { models, added, removed, droppedExtras, metadataFixed }；网关请求失败会抛错（调用方兜底）。
 */
async function fetchFreeModelCatalog(currentCatalog = DEFAULT_MODELS, options = {}) {
  const baseURL = (options.baseURL ?? PUBLIC_BASE_URL).replace(/\/+$/, "");
  const metaURL = (options.metaURL ?? MODELS_DEV_URL).replace(/\/+$/, "");
  const signal = options.signal;
  const warn = options.warn ?? (() => {});
  const gatewayTimeout = AbortSignal.timeout(60000);
  const response = await fetch(`${baseURL}/models`, {
    headers: {
      accept: "application/json",
      "User-Agent": "opencode/1.0.0",
      "HTTP-Referer": "https://opencode.ai/",
      "X-Title": "opencode",
      "X-Source": "opencode"
    },
    signal: signal === void 0 ? gatewayTimeout : AbortSignal.any([signal, gatewayTimeout])
  });
  if (!response.ok) throw new Error(`model discovery failed: ${baseURL}/models answered ${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.data)) throw new Error("model discovery failed: unexpected response shape");

  const upstreamIds = new Set(body.data.map((m) => m?.id).filter((id) => typeof id === "string"));
  const freeIds = body.data.filter((m) => typeof m?.id === "string" && /free/i.test(m.id)).map((m) => m.id);

  const isFreeTagged = (id) => /free/i.test(id);
  const existingFree = currentCatalog.filter((m) => isFreeTagged(m.id));
  const existingExtras = currentCatalog.filter((m) => !isFreeTagged(m.id));

  const kept = existingFree.filter((m) => upstreamIds.has(m.id));
  const removed = existingFree.filter((m) => !upstreamIds.has(m.id)).map((m) => m.id);
  const knownIds = new Set(currentCatalog.map((m) => m.id));
  const added = freeIds.filter((id) => !knownIds.has(id));
  const keptExtras = existingExtras.filter((m) => upstreamIds.has(m.id));
  const droppedExtras = existingExtras.filter((m) => !upstreamIds.has(m.id)).map((m) => m.id);

  // 为每个幸存模型（已有 + 新增）从 models.dev 刷新元数据。
  const members = [...kept, ...added, ...keptExtras];
  const metas = await mapPool(members, 4, (m) => fetchModelsDevMeta(typeof m === "string" ? m : m.id, metaURL, signal, warn));

  const metadataFixed = [];
  const models = members.map((member, idx) => {
    const meta = metas[idx];
    if (typeof member === "string") {
      // 新发现的免费模型：优先 models.dev 元数据，缺失才用派生默认值。
      const name = meta?.name ?? displayName(member);
      const contextWindow = meta?.context ?? 128000;
      return {
        id: member,
        name,
        description: `opencode zen 免费模型，${name}，${formatSize(contextWindow)} 上下文。`,
        contextWindow,
        maxTokens: meta?.output ?? 128000,
        ...meta?.supportsImages === void 0 ? {} : { supportsImages: meta.supportsImages }
      };
    }
    // 已有模型：保留手写元数据，但从 models.dev 同步名称与上下文档位。
    const next = { ...member };
    let fixed = false;
    if (meta?.name && meta.name !== next.name) { next.name = meta.name; fixed = true; }
    if (meta?.context && meta.context !== next.contextWindow) {
      next.contextWindow = meta.context;
      next.description = next.description?.replace(/，\d+(?:\.\d+)?[KM] 上下文。$/, `，${formatSize(meta.context)} 上下文。`) ?? next.description;
      fixed = true;
    }
    if (meta?.output && meta.output !== next.maxTokens) { next.maxTokens = meta.output; fixed = true; }
    // 识图声明只在 models.dev 给出明确值且与现值不同时更新；未知(undefined)不覆盖已有声明。
    if (meta?.supportsImages !== void 0 && meta.supportsImages !== next.supportsImages) {
      next.supportsImages = meta.supportsImages;
      fixed = true;
    }
    if (fixed) metadataFixed.push(next.id);
    return next;
  });

  return { models, added, removed, droppedExtras, metadataFixed };
}

/**
 * 校验并归一化裸配置为连接事实。
 * @param config - 插件配置或已解析的设置快照。
 * @returns 校验后的连接事实与凭证引用。
 */
function resolveAdapterOptions(config) {
  if (config.defaultContextWindow !== void 0 && (!Number.isInteger(config.defaultContextWindow) || config.defaultContextWindow <= 0)) {
    throw new Error("llm-opencode: defaultContextWindow must be a positive integer");
  }
  if (config.maxTokens !== void 0 && (!Number.isSafeInteger(config.maxTokens) || config.maxTokens <= 0)) {
    throw new Error("llm-opencode: maxTokens must be a positive safe integer");
  }
  const streamIdleTimeoutMs = config.streamIdleTimeoutMs ?? 3e5;
  if (!Number.isFinite(streamIdleTimeoutMs) || streamIdleTimeoutMs <= 0 || streamIdleTimeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`llm-opencode: streamIdleTimeoutMs must be a positive finite number no greater than ${MAX_TIMER_DELAY_MS}`);
  }
  return {
    apiKeyEnv: credentialRef(config.apiKeyEnv ?? "OPENCODE_API_KEY"),
    baseURL: config.baseURL ?? "https://opencode.ai/zen/v1",
    maxTokens: config.maxTokens ?? 128e3,
    defaultContextWindow: config.defaultContextWindow ?? 1e6,
    models: resolveModels(config.models),
    streamIdleTimeoutMs,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, "llm-opencode: retryPolicy")
  };
}

/** 干净分离模型目录：校验并去掉空白条目。 */
function resolveModels(models) {
  const seen = /* @__PURE__ */ new Set();
  return (models ?? DEFAULT_MODELS).map((model) => {
    if (model.id.length === 0) throw new Error("llm-opencode: catalog model ids must be non-empty");
    if (model.name !== void 0 && model.name.length === 0) throw new Error(`llm-opencode: catalog model "${model.id}" has an empty name`);
    if (model.contextWindow !== void 0 && (!Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
      throw new Error(`llm-opencode: catalog model "${model.id}" contextWindow must be a positive integer`);
    }
    if (model.maxTokens !== void 0 && (!Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
      throw new Error(`llm-opencode: catalog model "${model.id}" maxTokens must be a positive integer`);
    }
    if (seen.has(model.id)) throw new Error(`llm-opencode: duplicate catalog model "${model.id}"`);
    seen.add(model.id);
    return {
      id: model.id,
      ...model.name === void 0 ? {} : { name: model.name },
      ...model.description === void 0 ? {} : { description: model.description },
      ...model.contextWindow === void 0 ? {} : { contextWindow: model.contextWindow },
      ...model.maxTokens === void 0 ? {} : { maxTokens: model.maxTokens },
      ...model.supportsImages === void 0 ? {} : { supportsImages: model.supportsImages === true }
    };
  });
}

/**
 * 插件入口：注册 `opencode-zen` provider route。
 *
 * 0.1.7 契约下的配置注入：loader 把解析后的配置作为第二个参数传入，
 * 顶层声明为 volatile 的 `Config` 让 `config` 成为 volatile 包装，`config.get()`
 * 取回纯对象；配置改动经 `loader/volatile-update` 事件下发到运行中的 fiber，
 * 无需重启即对下一个请求生效。
 *
 * 同时声明 settings 命名空间，使 web 模型设置页能为本插件生成可编辑表单
 * （0.1.7 的命名空间从插件 Config schema 派生，不再需要 installSettingsSection）。
 * @param ctx - cordis 上下文。
 * @param config - volatile 包装后的插件配置。
 */
function apply(ctx, config) {
  // 让本插件在 0.1.7 下拥有可编辑的 settings 页（与 dsh-llm-pi-ai 同款接线）。
  ctx.inject(["settings"], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
  });
  // settingsNs 取本 entry 的 id（cordis.patch.yml 注册的插件行 id 即 llm-opencode）。
  const settingsNs = ctx.fiber.entry?.options.id ?? "llm-opencode";
  let lastRaw;
  let lastGood;
  /** 启动时从网关 + models.dev 同步到的免费模型目录（null = 尚未同步成功）。 */
  let syncedCatalog = null;
  let lastSynced = null;
  const defaultCatalog = resolveModels(DEFAULT_MODELS);
  const options = () => {
    const raw = config.get();
    if (raw === lastRaw && lastGood !== void 0 && lastSynced === syncedCatalog) return lastGood;
    try {
      const next = resolveAdapterOptions(raw);
      // 启动同步成功且用户未在设置里自定义 models 时，用最新同步目录替换内置默认目录。
      if (syncedCatalog !== null && deepEqualJson(next.models, defaultCatalog)) next.models = syncedCatalog;
      lastRaw = raw;
      lastGood = next;
      lastSynced = syncedCatalog;
      return next;
    } catch (error) {
      if (lastGood === void 0) throw error;
      lastRaw = raw;
      ctx.logger.error("llm-opencode: keeping the last good configuration after an invalid settings section");
      ctx.logger.error(error);
      return lastGood;
    }
  };
  options();
  const resolveApiKey = async (connection) => {
    const ref = connection.apiKeyEnv;
    const credentials = ctx.get("credentials");
    if (credentials !== void 0) {
      const hit = await credentials.resolve(ref);
      if (hit !== void 0) return assertUsableApiKey(hit.value, "llm-opencode", ref);
    } else {
      const ambient = ref in process.env ? { value: process.env[ref] } : void 0;
      if (ambient !== void 0 && ambient.value.length > 0) return assertUsableApiKey(ambient.value, "llm-opencode", ref);
    }
    throw new LlmError(
      `llm-opencode: no API key for provider route "${PROVIDER}"; store ${ref} through the credentials service (the web Models page writes it), or export ${ref} in the launching environment`,
      "MISSING_CREDENTIAL"
    );
  };
  const adapter = new OpenCodeAdapter({ options, resolveApiKey });
  // 声明可配置提供方目录条目：web 设置-模型页的数据源（llm.providers 由
  // listConfigurableProviders() 目录 + 活路由合并而成；只在 registerAdapter
  // 里注册的活路由会以 settingsNs:"" 落进兜底行，被页面过滤掉，因此必须
  // 在此声明 settingsNs/settingsPath，opencode-zen 才会出现在设置界面）。
  ctx.llm.registerConfigurableProviders([{
    provider: PROVIDER,
    displayName: "OpenCode Zen",
    settingsNs,
    settingsPath: []
  }]);
  const registration = ctx.llm.registerAdapter([PROVIDER], adapter);
  let registeredPolicy = options().retryPolicy;
  const ensureRegistrationFacts = () => {
    const policy = options().retryPolicy;
    if (deepEqualJson(policy, registeredPolicy)) return;
    registration.replace([PROVIDER]);
    registeredPolicy = policy;
  };
  // 顶层 volatile 配置改动经此事件下发：重新评估注册事实（retryPolicy 变化）。
  ctx.on("loader/volatile-update", () => {
    try {
      ensureRegistrationFacts();
    } catch (error) {
      ctx.logger.error("llm-opencode: configuration conflicts with an existing provider route");
      ctx.logger.error(error);
    }
  });

  // 每次启动时后台自动同步免费模型目录：网关 /models 决定成员，models.dev
  // 提供元数据。不阻塞启动；失败保留内置目录。仅在使用内置默认目录时生效
  // （用户在设置里自定义过 models 则不覆盖），可用 autoSyncModels: false 关闭。
  ctx.effect(() => {
    const connection = options();
    if (connection === void 0 || connection.autoSyncModels === false) return;
    if (!deepEqualJson(connection.models, defaultCatalog)) {
      ctx.logger.info("llm-opencode: custom model catalog configured; skipping startup free-model sync");
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const result = await fetchFreeModelCatalog(connection.models, {
          baseURL: connection.baseURL,
          signal: controller.signal,
          warn: (message) => ctx.logger.warn(message)
        });
        if (controller.signal.aborted || result.models.length === 0) return;
        syncedCatalog = resolveModels(result.models);
        const changes = [
          ...result.added.map((id) => `+${id}`),
          ...result.removed.map((id) => `-${id}`),
          ...result.droppedExtras.map((id) => `-${id}`),
          ...result.metadataFixed.map((id) => `~${id}`)
        ];
        ctx.logger.info(`llm-opencode: free model catalog synced (${syncedCatalog.length} models${changes.length > 0 ? `: ${changes.join(", ")}` : ", already up to date"})`);
      } catch (error) {
        ctx.logger.warn(`llm-opencode: startup free-model sync failed, keeping the built-in catalog (${error?.message ?? error})`);
      }
    })();
    return () => controller.abort();
  });

  /** 从 opencode zen /models 端点获取带 free 的可用模型列表。 */
  ctx.llm.registerModelDiscovery(settingsNs, async (request) => {
    const base = request.baseURL || PUBLIC_BASE_URL;
    const url = base.replace(/\/+$/, "") + "/models";
    const headers = {
      accept: "application/json",
      "User-Agent": "opencode/1.0.0",
      "HTTP-Referer": "https://opencode.ai/",
      "X-Title": "opencode",
      "X-Source": "opencode"
    };
    if (request.apiKey) headers.authorization = `Bearer ${request.apiKey}`;
    const response = await fetch(url, {
      method: "GET",
      headers,
      signal: request.signal
    });
    if (!response.ok) throw new LlmError(`model discovery failed: ${url} answered ${response.status}`, "DISCOVERY_FAILED");
    const body = await response.json();
    const data = body?.data;
    if (!Array.isArray(data)) throw new LlmError(`model discovery failed: unexpected response from ${url}`, "DISCOVERY_FAILED");
    return data
      .filter((m) => typeof m?.id === "string" && /free/i.test(m.id))
      .map((m) => ({
        id: m.id,
        name: m.name || m.id
      }));
  });
}
//#endregion

export {
  Config,
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODELS,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  MODELS_DEV_URL,
  OpenCodeAdapter,
  PUBLIC_BASE_URL,
  apply,
  fetchFreeModelCatalog,
  inject,
  name,
  resolveAdapterOptions
};