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
  it("contains the long-standing verified free models", () => {
    const ids = DEFAULT_MODELS.map((m) => m.id);
    assert.ok(ids.includes("deepseek-v4-flash-free"));
    assert.ok(ids.includes("nemotron-3-ultra-free"));
    assert.ok(ids.includes("mimo-v2.5-free"));
  });

  it("reflects the 2026-09-27 gateway refresh", () => {
    const ids = DEFAULT_MODELS.map((m) => m.id);
    // 网关新出现的免费成员必须在内置兜底目录里。
    for (const id of [
      "jev-1.13-free",
      "muse-spark-1.3-contributor-free",
      "mimo-v2.6-flash-free",
      "space-bunny-free",
      "longcat-2.5-preview-free"
    ]) {
      assert.ok(ids.includes(id), `${id} should be present after the refresh`);
    }
    // 上游已下架的成员不得留在兜底目录里。
    assert.ok(!ids.includes("hy3-free"), "hy3-free was removed upstream");
    assert.ok(!ids.includes("laguna-s-2.1-free"), "laguna-s-2.1-free was removed upstream");
    assert.equal(ids.length, 11);
    assert.equal(new Set(ids).size, ids.length, "model ids must be unique");
  });

  it("keeps only free-tagged models", () => {
    for (const m of DEFAULT_MODELS) {
      assert.match(m.id, /free/i, `${m.id} is not a free-tagged model`);
    }
    assert.ok(!DEFAULT_MODELS.some((m) => m.id === "big-pickle"), "big-pickle is not free-tagged");
  });

  it("has positive contextWindow and maxTokens for every model", () => {
    for (const m of DEFAULT_MODELS) {
      assert.ok(m.contextWindow > 0, `${m.id} contextWindow`);
      assert.ok(m.maxTokens > 0, `${m.id} maxTokens`);
    }
  });
});
