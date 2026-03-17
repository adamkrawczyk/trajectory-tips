import {
  cosineSimilarity,
  getIndexPath,
  getTipsDir,
  loadAllTips,
  normalizeListOption,
  priorityRank,
  toEmbeddingText
} from './utils.js';
import { generateEmbedding } from './embeddings.js';
import { loadIndex } from './store.js';

function tokenize(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 2)
  );
}

function lexicalScore(query, tip) {
  const q = tokenize(query);
  if (q.size === 0) {
    return 0;
  }
  const t = tokenize(toEmbeddingText(tip));
  let overlap = 0;
  for (const token of q) {
    if (t.has(token)) {
      overlap += 1;
    }
  }
  return overlap / q.size;
}

/**
 * Compute effectiveness multiplier for a tip based on feedback history.
 *
 * - New tips (no feedback): neutral 1.0
 * - Tips with high success rate: boosted up to 1.3x
 * - Tips with low success rate (applied ≥3 times, <30% success): demoted to 0.5x
 * - Tips not applied in >60 days: slight decay (0.9x)
 */
function effectivenessMultiplier(tip) {
  const eff = tip.effectiveness || {};
  const applied = Number(eff.applied_count || 0);
  const successes = Number(eff.success_count || 0);

  // New tip — no data yet, neutral
  if (applied === 0) return 1.0;

  const rate = successes / applied;

  // Demote tips that keep failing (need enough samples to be confident)
  if (applied >= 3 && rate < 0.3) return 0.5;

  // Slight demotion for low-sample poor performance
  if (applied >= 2 && rate < 0.4) return 0.7;

  // Boost proven tips
  if (applied >= 2 && rate >= 0.8) return 1.3;
  if (applied >= 1 && rate >= 0.6) return 1.15;

  // Age decay: tips not applied in 60+ days get slight demotion
  if (eff.last_applied) {
    const daysSince = (Date.now() - new Date(eff.last_applied).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSince > 60) return 0.9;
  }

  return 1.0;
}

/**
 * Priority boost: high-priority tips get a small score bump.
 */
function priorityBoost(tip) {
  const rank = priorityRank(tip.priority);
  // rank: 1=critical, 2=high, 3=medium, 4=low
  if (rank <= 1) return 0.05;
  if (rank <= 2) return 0.02;
  return 0;
}

function passesFilters(tip, filters) {
  if (filters.domain && tip.domain !== filters.domain) {
    return false;
  }
  if (filters.category && tip.category !== filters.category) {
    return false;
  }
  if (filters.priority && !filters.priority.includes(tip.priority)) {
    return false;
  }
  return true;
}

export async function queryTips(description, {
  domain,
  category,
  priority,
  top = 5,
  tipsDir = getTipsDir(),
  indexPath = getIndexPath(),
  embedder = generateEmbedding,
  includeNegative = true
} = {}) {
  const filters = {
    domain: domain || null,
    category: category || null,
    priority: normalizeListOption(priority)
  };

  const { tips, warnings } = await loadAllTips(tipsDir);
  const filteredTips = tips.filter((tip) => passesFilters(tip, filters));
  if (filteredTips.length === 0) {
    return { method: 'none', results: [], negativeResults: [], warnings };
  }

  const index = await loadIndex(indexPath);
  let queryEmbedding = null;
  try {
    queryEmbedding = await embedder(description);
  } catch {
    queryEmbedding = null;
  }

  const scored = filteredTips.map((tip) => {
    const embedding = index.tips?.[tip.id]?.embedding;
    const semantic = queryEmbedding && embedding ? cosineSimilarity(queryEmbedding, embedding) : null;
    const lexical = lexicalScore(description, tip);
    const baseSimilarity = semantic !== null ? semantic : lexical;

    // Apply effectiveness multiplier + priority boost
    const effMult = effectivenessMultiplier(tip);
    const prioBoost = priorityBoost(tip);
    const score = (baseSimilarity * effMult) + prioBoost;

    return {
      tip,
      score,
      baseSimilarity,
      effectivenessMultiplier: effMult,
      method: semantic !== null ? 'semantic' : 'lexical',
      hasNegativeExample: !!(tip.negative_example && tip.negative_example.trim().length > 10)
    };
  });

  scored.sort((a, b) => b.score - a.score);

  const topItems = scored.slice(0, Number(top) || 5);
  const method = topItems.some((i) => i.method === 'semantic') ? 'semantic' : 'lexical';

  // Extract negative examples from top-scoring tips that have them
  // These become the WARNINGS section in injection
  let negativeResults = [];
  if (includeNegative) {
    negativeResults = scored
      .filter((item) => item.hasNegativeExample && item.baseSimilarity > 0.4)
      .slice(0, 3)
      .map((item) => ({
        tip: item.tip,
        score: item.score,
        warning: item.tip.negative_example
      }));
  }

  return {
    method,
    warnings,
    results: topItems,
    negativeResults
  };
}
