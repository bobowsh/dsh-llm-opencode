/**
 * dsh-llm-opencode — TypeScript type declarations.
 *
 * These declarations mirror the runtime exports so that consumers
 * importing the package in a TypeScript Cordis plugin get accurate
 * types for the Config schema and the adapter internals.
 */

import type { z } from "@deepseek-ai/schemastery";
import type { LlmAdapter, RetryPolicySchema } from "@deepseek-ai/dsh-llm";

/** Public gateway endpoint for OpenCode Zen. */
export declare const PUBLIC_BASE_URL: "https://opencode.ai/zen/v1";

/** models.dev metadata source (per-model TOML files). */
export declare const MODELS_DEV_URL: "https://raw.githubusercontent.com/sst/models.dev/dev/providers/opencode/models";

/** Default maximum output tokens per request. */
export declare const DEFAULT_MAX_TOKENS: 128000;

/** Default context-window fallback for unknown models. */
export declare const DEFAULT_CONTEXT_WINDOW: 1000000;

/** Default stream idle timeout in milliseconds. */
export declare const DEFAULT_STREAM_IDLE_TIMEOUT_MS: 300000;

/** Shape of a single model entry in the built-in catalog. */
export interface CatalogModel {
  id: string;
  name: string;
  description: string;
  contextWindow: number;
  maxTokens: number;
}

/** Built-in free-model catalog (verified 2026-08). */
export declare const DEFAULT_MODELS: CatalogModel[];

/** Plugin configuration schema (also the `llm-opencode` settings section). */
export declare const Config: z.ZodObject<{
  apiKeyEnv: z.ZodDefault<z.ZodString>;
  baseURL: z.ZodString;
  maxTokens: z.ZodDefault<z.ZodNumber>;
  defaultContextWindow: z.ZodDefault<z.ZodNumber>;
  models: z.ZodDefault<z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodString;
    contextWindow: z.ZodNumber;
    maxTokens: z.ZodNumber;
  }>>>;
  streamIdleTimeoutMs: z.ZodDefault<z.ZodNumber>;
  autoSyncModels: z.ZodDefault<z.ZodBoolean>;
  retryPolicy: z.ZodType<z.infer<typeof RetryPolicySchema>>;
}>;

export type ConfigType = z.infer<typeof Config>;

/** Resolved connection facts passed to the adapter at runtime. */
export interface ResolvedOptions {
  apiKeyEnv: { kind: "credential-ref"; ref: string };
  baseURL: string;
  maxTokens: number;
  defaultContextWindow: number;
  models: CatalogModel[];
  streamIdleTimeoutMs: number;
  retryPolicy: z.infer<typeof RetryPolicySchema>;
}

/** Normalize raw config into resolved connection facts. */
export declare function resolveAdapterOptions(config: Partial<ConfigType>): ResolvedOptions;

/** Result of a free-model catalog sync. */
export interface CatalogSyncResult {
  models: CatalogModel[];
  added: string[];
  removed: string[];
  droppedExtras: string[];
  metadataFixed: string[];
}

/** Sync the free-model catalog from the gateway (membership) + models.dev (metadata). */
export declare function fetchFreeModelCatalog(
  currentCatalog?: CatalogModel[],
  options?: {
    baseURL?: string;
    metaURL?: string;
    signal?: AbortSignal;
    warn?: (message: string) => void;
  }
): Promise<CatalogSyncResult>;

/** OpenCode Zen adapter implementing the DSH LlmAdapter interface. */
export declare class OpenCodeAdapter extends LlmAdapter {
  constructor(deps: {
    options: () => ResolvedOptions;
    resolveApiKey: (connection: ResolvedOptions) => Promise<string>;
  });
}

/** Cordis plugin name. */
export declare const name: "llm-opencode";

/** Cordis dependency injection list. */
export declare const inject: ["llm"];

/** Cordis plugin entry point. */
export declare function apply(ctx: any, config: Partial<ConfigType>): void;
