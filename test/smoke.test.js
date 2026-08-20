/**
 * @file Smoke tests for the OpenCode Zen adapter.
 *
 * These are lightweight unit tests that verify serialization helpers
 * and config resolution without needing network access.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  DEFAULT_MODELS,
  PUBLIC_BASE_URL,
  resolveAdapterOptions
} from "../lib/index.js";

describe("config resolution", () => {
  it("uses defaults when given an empty object", () => {
    const opts = resolveAdapterOptions({});
    assert.equal(opts.baseURL, PUBLIC_BASE_URL);
    assert.equal(opts.maxTokens, 128000);
    assert.equal(opts.defaultContextWindow, 1000000);
    assert.equal(opts.models.length, DEFAULT_MODELS.length);
  });

  it("overrides defaults with explicit values", () => {
    const opts = resolveAdapterOptions({
      baseURL: "https://custom.opencode.ai/v1",
      maxTokens: 64000,
      defaultContextWindow: 200000
    });
    assert.equal(opts.baseURL, "https://custom.opencode.ai/v1");
    assert.equal(opts.maxTokens, 64000);
    assert.equal(opts.defaultContextWindow, 200000);
  });

  it("rejects non-positive contextWindow", () => {
    assert.throws(
      () => resolveAdapterOptions({ defaultContextWindow: 0 }),
      /defaultContextWindow must be a positive integer/
    );
  });

  it("rejects out-of-range streamIdleTimeoutMs", () => {
    assert.throws(
      () => resolveAdapterOptions({ streamIdleTimeoutMs: -1 }),
      /streamIdleTimeoutMs must be a positive finite number/
    );
  });
});

describe("model catalog", () => {
  it("contains the four verified free models", () => {
    const ids = DEFAULT_MODELS.map((m) => m.id);
    assert.ok(ids.includes("deepseek-v4-flash-free"));
    assert.ok(ids.includes("nemotron-3-ultra-free"));
    assert.ok(ids.includes("mimo-v2.5-free"));
    assert.ok(ids.includes("big-pickle"));
  });

  it("has positive contextWindow and maxTokens for every model", () => {
    for (const m of DEFAULT_MODELS) {
      assert.ok(m.contextWindow > 0, `${m.id} contextWindow`);
      assert.ok(m.maxTokens > 0, `${m.id} maxTokens`);
    }
  });
});
