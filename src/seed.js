import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, getTipsDir, readTipYaml, writeTipYaml, toEmbeddingText } from './utils.js';
import { loadIndex, saveIndex } from './store.js';
import { generateEmbedding } from './embeddings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_BASE_DIR = path.resolve(__dirname, '..', 'examples');

export async function seedBaseTips({
  baseDir = DEFAULT_BASE_DIR,
  tipsDir = getTipsDir(),
  skipEmbeddings = false
} = {}) {
  await ensureDir(tipsDir);

  const entries = await fs.readdir(baseDir, { withFileTypes: true });
  const yamlFiles = entries.filter(e => e.isFile() && e.name.endsWith('.yaml'));

  let count = 0;
  let skipped = 0;

  for (const entry of yamlFiles) {
    const srcPath = path.join(baseDir, entry.name);
    const destPath = path.join(tipsDir, entry.name);

    // Skip if already exists (don't overwrite client customizations)
    try {
      await fs.access(destPath);
      skipped++;
      continue;
    } catch {
      // File doesn't exist — good, proceed
    }

    const tip = await readTipYaml(srcPath);
    await writeTipYaml(destPath, tip);

    if (!skipEmbeddings) {
      try {
        const indexPath = path.resolve(process.cwd(), 'index.json');
        const index = await loadIndex(indexPath);
        const text = toEmbeddingText(tip);
        const embedding = await generateEmbedding(text);
        index.tips[tip.id] = { text, embedding, updated: tip.updated };
        await saveIndex(index, indexPath);
      } catch (err) {
        // Embeddings optional during seed — can reindex later
        console.error(`Warning: embedding failed for ${tip.id}: ${err.message}`);
      }
    }

    count++;
  }

  return { count, skipped };
}
