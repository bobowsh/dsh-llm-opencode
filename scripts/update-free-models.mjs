#!/usr/bin/env node
/**
 * Sync the free-model catalog (DEFAULT_MODELS in lib/index.js) with the
 * OpenCode Zen public gateway, using models.dev as the metadata source.
 *
 * Rules:
 * - Membership: GET ${BASE_URL}/models decides which models exist; ids
 *   matching /free/i are the free tier. Freebies without a "-free" suffix
 *   (e.g. big-pickle) are kept while they still exist upstream.
 * - Metadata: for every catalog model the script fetches
 *   https://raw.githubusercontent.com/sst/models.dev/dev/providers/opencode/models/<id>.toml
 *   and takes name / limit.context / limit.output from it (models.dev is
 *   opencode's own model metadata source). Hand-written descriptions are
 *   kept, with the trailing "NNK 上下文" figure corrected when the real
 *   context window differs. Models missing on models.dev keep their current
 *   metadata; brand-new ones fall back to derived 128K/128K defaults.
 *
 * Always exits 0 on a successful gateway fetch; prints the change summary.
 * The CI workflow commits and pushes when the file was modified.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, "lib", "index.js");
const BASE_URL = (process.env.OPENCODE_ZEN_URL || "https://opencode.ai/zen/v1").replace(/\/+$/, "");
const META_URL = (process.env.MODELS_DEV_URL || "https://raw.githubusercontent.com/sst/models.dev/dev/providers/opencode/models").replace(/\/+$/, "");

const response = await fetch(`${BASE_URL}/models`, {
  headers: {
    accept: "application/json",
    "User-Agent": "opencode/1.0.0",
    "HTTP-Referer": "https://opencode.ai/",
    "X-Title": "opencode",
    "X-Source": "opencode"
  },
  signal: AbortSignal.timeout(60000)
});
if (!response.ok) throw new Error(`model discovery failed: ${BASE_URL}/models answered ${response.status}`);
const body = await response.json();
if (!Array.isArray(body?.data)) throw new Error("model discovery failed: unexpected response shape");

const upstreamIds = new Set(body.data.map((m) => m?.id).filter((id) => typeof id === "string"));
const freeIds = body.data.filter((m) => typeof m?.id === "string" && /free/i.test(m.id)).map((m) => m.id);

const { DEFAULT_MODELS } = await import(pathToFileURL(indexPath).href);

/** Parse the few fields we need from a models.dev TOML file (regex-based, zero deps). */
function parseTomlMeta(text) {
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1];
  // 注意：区块截断的 $ 不能用 /m（多行模式下 \s*$ 会匹配任意行尾，导致区块恒为空）
  const limitBlock = /\[limit\]\s*\n([\s\S]*?)(?=\n\s*\[|$)/.exec(text)?.[1] ?? "";
  const num = (key) => {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*([\\d_]+)`, "m").exec(limitBlock);
    return m ? Number(m[1].replaceAll("_", "")) : undefined;
  };
  return { name, context: num("context"), output: num("output") };
}

/** Fetch models.dev metadata for one model id; null when unavailable (with retries + warning). */
async function fetchMeta(id) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(`${META_URL}/${encodeURIComponent(id)}.toml`, {
        headers: { "User-Agent": "dsh-llm-opencode-catalog-sync" },
        signal: AbortSignal.timeout(30000)
      });
      if (!r.ok) {
        if (r.status === 404) return null; // not on models.dev — legitimate miss, no retry
        throw new Error(`HTTP ${r.status}`);
      }
      return parseTomlMeta(await r.text());
    } catch (error) {
      if (attempt === 3) {
        console.warn(`warn: models.dev metadata unavailable for ${id} (${error.message}); keeping existing metadata`);
        return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  return null;
}

/** Pool map with bounded concurrency. */
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

/** Derive a display name for a model id when models.dev has no entry ("hy3-free" -> "Hy3 Free"). */
function displayName(id) {
  const bare = id.replace(/-free$/i, "");
  const words = bare.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1));
  return [...words, "Free"].join(" ");
}

/** Format a context size like the hand-written catalog entries: 200000 -> "200K", 1000000 -> "1M". */
function formatSize(n) {
  return n >= 1000000 && n % 1000000 === 0 ? `${n / 1000000}M` : `${Math.round(n / 1000)}K`;
}

const isFreeTagged = (id) => /free/i.test(id);
const existingFree = DEFAULT_MODELS.filter((m) => isFreeTagged(m.id));
const existingExtras = DEFAULT_MODELS.filter((m) => !isFreeTagged(m.id));

const kept = existingFree.filter((m) => upstreamIds.has(m.id));
const removed = existingFree.filter((m) => !upstreamIds.has(m.id));
const knownIds = new Set(DEFAULT_MODELS.map((m) => m.id));
const addedIds = freeIds.filter((id) => !knownIds.has(id));
const keptExtras = existingExtras.filter((m) => upstreamIds.has(m.id));
const droppedExtras = existingExtras.filter((m) => !upstreamIds.has(m.id));

// Refresh metadata from models.dev for every surviving model (existing + new).
const members = [...kept, ...addedIds, ...keptExtras];
const metas = await mapPool(members, 4, (m) => fetchMeta(typeof m === "string" ? m : m.id));

const updated = [];
const metadataFixed = [];
members.forEach((member, idx) => {
  const meta = metas[idx];
  if (typeof member === "string") {
    // Newly discovered free model: models.dev metadata, else derived defaults.
    const name = meta?.name ?? displayName(member);
    const contextWindow = meta?.context ?? 128000;
    updated.push({
      id: member,
      name,
      description: `opencode zen 免费模型，${name}，${formatSize(contextWindow)} 上下文。`,
      contextWindow,
      maxTokens: meta?.output ?? 128000
    });
    return;
  }
  // Existing model: keep hand-written metadata, but sync name/limits from models.dev.
  const next = { ...member };
  let fixed = false;
  if (meta?.name && meta.name !== next.name) { next.name = meta.name; fixed = true; }
  if (meta?.context && meta.context !== next.contextWindow) {
    next.contextWindow = meta.context;
    next.description = next.description?.replace(/，\d+(?:\.\d+)?[KM] 上下文。$/, `，${formatSize(meta.context)} 上下文。`) ?? next.description;
    fixed = true;
  }
  if (meta?.output && meta.output !== next.maxTokens) { next.maxTokens = meta.output; fixed = true; }
  if (fixed) metadataFixed.push(next.id);
  updated.push(next);
});

if (removed.length === 0 && addedIds.length === 0 && droppedExtras.length === 0 && metadataFixed.length === 0) {
  console.log(`free model catalog already up to date (${DEFAULT_MODELS.length} models)`);
  process.exit(0);
}

const serialize = (m) => [
  "  {",
  `    id: ${JSON.stringify(m.id)},`,
  `    name: ${JSON.stringify(m.name)},`,
  `    description: ${JSON.stringify(m.description)},`,
  `    contextWindow: ${m.contextWindow},`,
  `    maxTokens: ${m.maxTokens}`,
  "  }"
].join("\n");
const block = `const DEFAULT_MODELS = [\n${updated.map(serialize).join(",\n")}\n];`;

const today = new Date().toISOString().slice(0, 10);
const comment = `/** 实测可用的 opencode zen 免费模型目录（${today} 自动更新，来源：GET ${BASE_URL}/models + models.dev 元数据，共 ${updated.length} 个免费模型）。 */`;

let content = readFileSync(indexPath, "utf8");
if (!/const DEFAULT_MODELS = \[[\s\S]*?\n\];/.test(content)) throw new Error("could not locate DEFAULT_MODELS block");
content = content.replace(/const DEFAULT_MODELS = \[[\s\S]*?\n\];/, block);
content = content.replace(/\/\*\* 实测可用的 opencode zen 免费模型目录（[^）]*）。 \*\//, comment);
writeFileSync(indexPath, content, "utf8");

for (const m of removed) console.log(`removed: ${m.id}`);
for (const id of addedIds) console.log(`added:   ${id}`);
for (const m of droppedExtras) console.log(`removed (extra, gone upstream): ${m.id}`);
for (const id of metadataFixed) console.log(`metadata synced from models.dev: ${id}`);
console.log(`catalog updated: ${DEFAULT_MODELS.length} -> ${updated.length} models`);
