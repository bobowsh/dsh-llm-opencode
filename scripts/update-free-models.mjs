#!/usr/bin/env node
/**
 * Sync the free-model catalog (DEFAULT_MODELS in lib/index.js) with the
 * OpenCode Zen public gateway.
 *
 * Rules:
 * - Free models are discovered from GET ${BASE_URL}/models (ids matching /free/i).
 * - Existing entries keep their hand-written metadata (name, description,
 *   contextWindow, maxTokens); only membership changes are applied.
 * - New free models get derived defaults (title-cased name, 128K/128K).
 * - Freebies without a "-free" suffix in the id (e.g. big-pickle) are kept
 *   while they still exist upstream, dropped once removed.
 *
 * Always exits 0 on a successful fetch; prints whether the catalog changed.
 * The CI workflow commits and pushes when the file was modified.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, "lib", "index.js");
const BASE_URL = (process.env.OPENCODE_ZEN_URL || "https://opencode.ai/zen/v1").replace(/\/+$/, "");

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

/** Derive a display name for a newly discovered free model ("hy3-free" -> "Hy3 Free"). */
function displayName(id) {
  const bare = id.replace(/-free$/i, "");
  const words = bare.split("-").filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1));
  return [...words, "Free"].join(" ");
}

function defaultEntry(id) {
  const name = displayName(id);
  return {
    id,
    name,
    description: `opencode zen 免费模型，${name}，128K 上下文。`,
    contextWindow: 128000,
    maxTokens: 128000
  };
}

const isFreeTagged = (id) => /free/i.test(id);
const existingFree = DEFAULT_MODELS.filter((m) => isFreeTagged(m.id));
const existingExtras = DEFAULT_MODELS.filter((m) => !isFreeTagged(m.id));

const kept = existingFree.filter((m) => upstreamIds.has(m.id));
const removed = existingFree.filter((m) => !upstreamIds.has(m.id));
const knownIds = new Set(DEFAULT_MODELS.map((m) => m.id));
const added = freeIds.filter((id) => !knownIds.has(id)).map(defaultEntry);
const keptExtras = existingExtras.filter((m) => upstreamIds.has(m.id));
const droppedExtras = existingExtras.filter((m) => !upstreamIds.has(m.id));

if (removed.length === 0 && added.length === 0 && droppedExtras.length === 0) {
  console.log(`free model catalog already up to date (${DEFAULT_MODELS.length} models)`);
  process.exit(0);
}

const next = [...kept, ...added, ...keptExtras];
const serialize = (m) => [
  "  {",
  `    id: ${JSON.stringify(m.id)},`,
  `    name: ${JSON.stringify(m.name)},`,
  `    description: ${JSON.stringify(m.description)},`,
  `    contextWindow: ${m.contextWindow},`,
  `    maxTokens: ${m.maxTokens}`,
  "  }"
].join("\n");
const block = `const DEFAULT_MODELS = [\n${next.map(serialize).join(",\n")}\n];`;

const today = new Date().toISOString().slice(0, 10);
const comment = `/** 实测可用的 opencode zen 免费模型目录（${today} 自动更新，来源：GET ${BASE_URL}/models，共 ${next.length} 个免费模型）。 */`;

let content = readFileSync(indexPath, "utf8");
if (!/const DEFAULT_MODELS = \[[\s\S]*?\n\];/.test(content)) throw new Error("could not locate DEFAULT_MODELS block");
content = content.replace(/const DEFAULT_MODELS = \[[\s\S]*?\n\];/, block);
content = content.replace(/\/\*\* 实测可用的 opencode zen 免费模型目录（[^）]*）。 \*\//, comment);
writeFileSync(indexPath, content, "utf8");

for (const m of removed) console.log(`removed: ${m.id}`);
for (const m of added) console.log(`added:   ${m.id}`);
for (const m of droppedExtras) console.log(`removed (extra, gone upstream): ${m.id}`);
console.log(`catalog updated: ${DEFAULT_MODELS.length} -> ${next.length} models`);
