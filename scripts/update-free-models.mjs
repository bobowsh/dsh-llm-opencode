#!/usr/bin/env node
/**
 * Sync the free-model catalog (DEFAULT_MODELS in lib/index.js) with the
 * OpenCode Zen public gateway, using models.dev as the metadata source.
 * The sync logic itself lives in lib/index.js (fetchFreeModelCatalog) and is
 * shared with the plugin's startup auto-sync; this script only rewrites the
 * committed catalog file when membership or metadata changed.
 *
 * Always exits 0 on a successful gateway fetch; prints the change summary.
 * The CI workflow commits and pushes when the file was modified.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = join(root, "lib", "index.js");

const { DEFAULT_MODELS, PUBLIC_BASE_URL, fetchFreeModelCatalog } = await import(pathToFileURL(indexPath).href);

const baseURL = (process.env.OPENCODE_ZEN_URL || PUBLIC_BASE_URL).replace(/\/+$/, "");
const result = await fetchFreeModelCatalog(DEFAULT_MODELS, {
  baseURL,
  metaURL: process.env.MODELS_DEV_URL,
  warn: (message) => console.warn(message)
});

const changed = result.added.length > 0 || result.removed.length > 0 || result.droppedExtras.length > 0 || result.metadataFixed.length > 0;
if (!changed) {
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
const block = `const DEFAULT_MODELS = [\n${result.models.map(serialize).join(",\n")}\n];`;

const today = new Date().toISOString().slice(0, 10);
const comment = `/** 实测可用的 opencode zen 免费模型目录（${today} 自动更新，来源：GET ${baseURL}/models + models.dev 元数据，共 ${result.models.length} 个免费模型）。 */`;

let content = readFileSync(indexPath, "utf8");
if (!/const DEFAULT_MODELS = \[[\s\S]*?\n\];/.test(content)) throw new Error("could not locate DEFAULT_MODELS block");
content = content.replace(/const DEFAULT_MODELS = \[[\s\S]*?\n\];/, block);
content = content.replace(/\/\*\* 实测可用的 opencode zen 免费模型目录（[^）]*）。 \*\//, comment);
writeFileSync(indexPath, content, "utf8");

for (const id of result.removed) console.log(`removed: ${id}`);
for (const id of result.added) console.log(`added:   ${id}`);
for (const id of result.droppedExtras) console.log(`removed (extra, gone upstream): ${id}`);
for (const id of result.metadataFixed) console.log(`metadata synced from models.dev: ${id}`);
console.log(`catalog updated: ${DEFAULT_MODELS.length} -> ${result.models.length} models`);
