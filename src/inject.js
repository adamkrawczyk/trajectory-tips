import { estimateTokens } from './utils.js';
import { queryTips } from './retrieve.js';

function formatSingleTip(item) {
  const { tip } = item;
  const steps = (tip.steps || []).map((s, idx) => `${idx + 1}. ${s}`).join('\n');

  // Show effectiveness badge if tip has feedback data
  const eff = tip.effectiveness || {};
  const applied = Number(eff.applied_count || 0);
  let effBadge = '';
  if (applied >= 3) {
    const rate = Number(eff.success_count || 0) / applied;
    effBadge = rate >= 0.8 ? ' ✅ proven' : rate < 0.3 ? ' ⚠️ unreliable' : '';
  }

  return [
    `[PRIORITY: ${String(tip.priority || 'medium').toUpperCase()}${effBadge}] ${capitalize(tip.category)} Tip:`,
    `${tip.content}`,
    `Apply when: ${tip.trigger || 'Context matches this scenario'}`,
    steps ? `Steps:\n${steps}` : null,
    tip.negative_example ? `Avoid: ${tip.negative_example}` : null,
    `Domain: ${tip.domain}`,
    `Similarity: ${item.score.toFixed(3)}`
  ].filter(Boolean).join('\n');
}

function formatWarning(item) {
  return `⚠️ AVOID: ${item.warning} (from: ${item.tip.content.slice(0, 80)}...)`;
}

function capitalize(value = '') {
  if (!value) return '';
  return value[0].toUpperCase() + value.slice(1);
}

export function formatTipsForInjection(results, { maxTokens = 2000, negativeResults = [] } = {}) {
  const header = '## Relevant Learnings from Past Executions';
  const blocks = [];
  let total = estimateTokens(header);

  // Inject warnings FIRST — anti-patterns are highest priority
  if (negativeResults.length > 0) {
    const warningHeader = '\n### ⚠️ Known Anti-Patterns (DO NOT repeat these mistakes)';
    total += estimateTokens(warningHeader);
    blocks.push(warningHeader);

    for (const item of negativeResults) {
      const block = formatWarning(item);
      const next = total + estimateTokens(block);
      if (next > maxTokens * 0.3) break; // Cap warnings at 30% of budget
      blocks.push(block);
      total = next;
    }
    blocks.push(''); // spacer
  }

  // Then positive tips
  if (results.length > 0) {
    blocks.push('### Recommended Approaches');
  }

  for (const item of results) {
    const block = formatSingleTip(item);
    const next = total + estimateTokens(block);
    if (next > maxTokens && blocks.length > 2) {
      break;
    }
    blocks.push(block);
    total = next;
  }

  return [header, '', ...blocks].join('\n');
}

export async function injectTips(description, {
  focus,
  maxTokens = 2000,
  domain,
  top = 5,
  tipsDir,
  indexPath,
  embedder,
  queryTipsImpl = queryTips
} = {}) {
  const query = await queryTipsImpl(description, {
    category: focus,
    domain,
    top,
    includeNegative: true,
    tipsDir,
    indexPath,
    embedder
  });

  const prompt = formatTipsForInjection(query.results, {
    maxTokens: Number(maxTokens) || 2000,
    negativeResults: query.negativeResults || []
  });

  return {
    ...query,
    prompt
  };
}
