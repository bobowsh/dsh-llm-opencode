/**
 * @file Catalog-cache regression tests.
 *
 * The synced model catalog must survive a restart: an offline boot (or one that
 * has not finished syncing yet) must still advertise the last known upstream
 * catalog instead of falling back to the built-in list.
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { apply, Config } from "../lib/index.js";

/** Free-tagged ids the stubbed gateway advertises in this suite. */
const GATEWAY_FREE = ["alpha-free", "beta-free", "gamma-free"];

/**
 * Faithful stand-in for the loader-provided volatile config: the plugin receives
 * the wrapper and reads the resolved plain object through `get()`. Calling the
 * schema directly returns that wrapper, not the resolved values.
 */
function configDouble(overrides = {}) {
  return { get: () => Config(overrides).get() };
}

/** Minimal Cordis surface the plugin touches, recording adapter replacements. */
function makeContext() {
  const llm = {
    adapter: undefined,
    replaced: 0,
    registerAdapter(_routes, adapter) {
      this.adapter = adapter;
      const handle = () => {};
      handle.replace = () => {
        this.replaced += 1;
      };
      return handle;
    },
    registerConfigurableProviders() {
      return () => {};
    },
    registerModelDiscovery() {}
  };
  const settingsChild = { effect: () => {}, settings: { configure: () => {} } };
  const ctx = {
    fiber: { entry: { options: { id: "llm-opencode" } } },
    on: () => {},
    inject: (services, callback) => {
      if (services.includes("settings")) callback(settingsChild);
    },
    effect: (callback) => {
      const dispose = callback();
      return typeof dispose === "function" ? dispose : () => {};
    },
    get: (name) => (name === "credentials" ? { resolve: async () => ({ value: "test-key" }) } : undefined),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    llm
  };
  return { ctx, llm };
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return predicate();
}

describe("model catalog cache", () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-llm-opencode-cache-"));
  const cacheFile = join(home, "cache", "llm-opencode", "model-catalog.json");
  const previousHome = process.env.DSH_HOME;
  const realFetch = globalThis.fetch;
  process.env.DSH_HOME = home;

  after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    globalThis.fetch = realFetch;
    rmSync(home, { recursive: true, force: true });
  });

  it("persists the synced catalog and restores it on the next load", async () => {
    // First load: the gateway advertises GATEWAY_FREE, models.dev answers 404 so
    // the derived-default metadata path is used.
    globalThis.fetch = async (url) => {
      if (String(url).includes("opencode.ai")) {
        return { ok: true, json: async () => ({ data: GATEWAY_FREE.map((id) => ({ id })) }) };
      }
      return { ok: false, status: 404 };
    };
    const first = makeContext();
    apply(first.ctx, configDouble());
    assert.ok(await waitFor(() => existsSync(cacheFile)), "a successful sync must persist the catalog");

    const persisted = JSON.parse(readFileSync(cacheFile, "utf8"));
    assert.deepEqual(
      persisted.models.map((model) => model.id).sort(),
      [...GATEWAY_FREE].sort(),
      "the cache must hold exactly the synced free members"
    );

    // Second load with the network fully unavailable. The sync fails, yet the
    // catalog must come from the cache instead of the built-in list.
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const second = makeContext();
    apply(second.ctx, configDouble());
    // Deliberately no waiting: the cache is read synchronously during activation,
    // so the very first listModels() call must already see it.
    const ids = (await second.llm.adapter.listModels("opencode-zen")).map((model) => model.id);
    assert.deepEqual(ids.sort(), [...GATEWAY_FREE].sort(), "the cached catalog must be live on the first query");
    assert.ok(second.llm.replaced >= 1, "restoring a different catalog must publish llm/adapters-updated");
  });

  it("ignores a cache written for a different gateway", async () => {
    // The cached entry belongs to the default gateway, so pointing the plugin at
    // another baseURL must invalidate it and fall back to the built-in catalog.
    globalThis.fetch = async () => {
      throw new TypeError("fetch failed");
    };
    const scoped = makeContext();
    apply(scoped.ctx, configDouble({ baseURL: "https://other.example/v1" }));
    const ids = (await scoped.llm.adapter.listModels("opencode-zen")).map((model) => model.id);
    assert.ok(!ids.includes(GATEWAY_FREE[0]), "a cache from another gateway must not be reused");
  });
});
