import fs from 'node:fs/promises';
import path from 'node:path';
import {
  buildTipFilePath,
  compactTip,
  cosineSimilarity,
  ensureDir,
  generateTipId,
  getIndexPath,
  getTipsDir,
  loadAllTips,
  nowIso,
  priorityRank,
  toEmbeddingText,
  writeTipYaml
} from './utils.js';
import { generateEmbedding, mergeTipsWithLLM, requireApiKey } from './embeddings.js';

export async function loadIndex(indexPath = getIndexPath()) {
  try {
    const raw = await fs.readFile(indexPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.tips) {
      return { model: process.env.TIPS_EMBEDDING_MODEL || 'text-embedding-3-small', tips: {} };
    }
    return parsed;
  } catch {
    return { model: process.env.TIPS_EMBEDDING_MODEL || 'text-embedding-3-small', tips: {} };
  }
}

export async function saveIndex(index, indexPath = getIndexPath()) {
  const payload = JSON.stringify(index, null, 2);
  await fs.writeFile(indexPath, payload, 'utf8');
}

export function normalizeTipCandidate(candidate, {
  domain = 'general',
  sourceTrajectoryId,
  sourceOutcome = 'failure',
  sourceDescription = ''
} = {}) {
  const timestamp = nowIso();
  const id = candidate.id || generateTipId();
  const steps = Array.isArray(candidate.steps) ? candidate.steps.filter(Boolean).map(String) : [];
  const tags = Array.isArray(candidate.tags) ? candidate.tags.filter(Boolean).map((t) => String(t).toLowerCase()) : [];

  return {
    id,
    category: candidate.category || 'strategy',
    priority: candidate.priority || 'medium',
    domain: candidate.domain || domain,
    content: candidate.content || '',
    purpose: candidate.purpose || '',
    trigger: candidate.trigger || '',
    steps,
    negative_example: candidate.negative_example || '',
    source: {
      trajectory_id: sourceTrajectoryId || 'unknown-trajectory',
      outcome: sourceOutcome,
      description: sourceDescription || ''
    },
    tags,
    created: candidate.created || timestamp,
    updated: timestamp,
    effectiveness: candidate.effectiveness || {
      applied_count: 0,
      success_count: 0,
      last_applied: null
    }
  };
}

export async function saveTip(tip, {
  tipsDir = getTipsDir(),
  indexPath = getIndexPath(),
  embedder = generateEmbedding,
  dedupThreshold = 0.80
} = {}) {
  await ensureDir(tipsDir);

  // Skip tips with empty content
  if (!tip.content || tip.content.trim().length === 0) {
    return { tip, filePath: null, skipped: true, reason: 'empty content' };
  }

  const text = toEmbeddingText(tip);
  const embedding = await embedder(text);

  // Dedup check: compare against existing tips in the index
  const index = await loadIndex(indexPath);
  for (const [existingId, entry] of Object.entries(index.tips || {})) {
    if (existingId === tip.id) continue;
    const sim = cosineSimilarity(embedding, entry.embedding);
    if (sim >= dedupThreshold) {
      return { tip, filePath: null, skipped: true, reason: `duplicate of ${existingId} (sim=${sim.toFixed(3)})` };
    }
  }

  const filePath = buildTipFilePath(tipsDir, tip.id);
  await writeTipYaml(filePath, tip);

  index.tips[tip.id] = {
    text,
    embedding,
    updated: tip.updated
  };
  await saveIndex(index, indexPath);

  return { tip, filePath };
}

export async function saveManyTips(tips, opts = {}) {
  const saved = [];
  let skipped = 0;
  for (const tip of tips) {
    // Sequential on purpose to keep writes deterministic and avoid race conditions on index.json.
    const result = await saveTip(tip, opts);
    if (result.skipped) {
      skipped += 1;
    }
    saved.push(result);
  }
  if (skipped > 0) {
    console.error(`Dedup: skipped ${skipped}/${tips.length} duplicate/empty tip(s)`);
  }
  return saved;
}

export function findDuplicates(tips, index, threshold = 0.85) {
  const groups = [];
  const seen = new Set();
  const byId = new Map(tips.map((t) => [t.id, t]));

  for (let i = 0; i < tips.length; i += 1) {
    const tipA = tips[i];
    if (seen.has(tipA.id)) {
      continue;
    }
    const cluster = [tipA.id];
    const vecA = index.tips?.[tipA.id]?.embedding;

    for (let j = i + 1; j < tips.length; j += 1) {
      const tipB = tips[j];
      if (seen.has(tipB.id)) {
        continue;
      }
      const vecB = index.tips?.[tipB.id]?.embedding;
      const sim = cosineSimilarity(vecA, vecB);
      const exactText = tipA.content.trim().toLowerCase() === tipB.content.trim().toLowerCase();
      if (exactText || sim >= threshold) {
        cluster.push(tipB.id);
      }
    }

    if (cluster.length > 1) {
      for (const id of cluster) {
        seen.add(id);
      }
      groups.push(cluster.map((id) => byId.get(id)).filter(Boolean));
    }
  }

  return groups;
}

function pickCanonicalWithoutLLM(cluster) {
  const sorted = [...cluster].sort((a, b) => {
    const p = priorityRank(a.priority) - priorityRank(b.priority);
    if (p !== 0) {
      return p;
    }
    return (a.created || '').localeCompare(b.created || '');
  });
  const best = structuredClone(sorted[0]);
  best.updated = nowIso();
  best.tags = [...new Set(sorted.flatMap((t) => t.tags || []))];
  return best;
}

export async function consolidateTips({
  tipsDir = getTipsDir(),
  indexPath = getIndexPath(),
  threshold = 0.85,
  dryRun = false,
  useLlm = true
} = {}) {
  const { tips, warnings } = await loadAllTips(tipsDir);
  const index = await loadIndex(indexPath);
  const clusters = findDuplicates(tips, index, threshold);

  if (clusters.length === 0) {
    return { merged: 0, archived: 0, warnings, clusters: [] };
  }

  const archiveDir = path.join(tipsDir, '.archive');
  if (!dryRun) {
    await ensureDir(archiveDir);
  }

  let merged = 0;
  let archived = 0;
  const summaries = [];

  for (const cluster of clusters) {
    let canonical;
    if (useLlm) {
      try {
        requireApiKey();
        const mergedTip = await mergeTipsWithLLM(cluster.map(compactTip));
        canonical = normalizeTipCandidate(mergedTip, {
          domain: cluster[0].domain,
          sourceTrajectoryId: cluster[0].source?.trajectory_id,
          sourceOutcome: cluster[0].source?.outcome,
          sourceDescription: `Consolidated from ${cluster.length} tips`
        });
        // Validate: if LLM returned empty content, fall back to non-LLM pick
        if (!canonical.content || canonical.content.trim().length === 0) {
          canonical = pickCanonicalWithoutLLM(cluster);
        }
      } catch {
        canonical = pickCanonicalWithoutLLM(cluster);
      }
    } else {
      canonical = pickCanonicalWithoutLLM(cluster);
    }

    // Final safety check: never save empty canonical tips
    if (!canonical.content || canonical.content.trim().length === 0) {
      summaries.push({
        canonical: null,
        merged_ids: cluster.map((t) => t.id),
        error: 'All tips in cluster have empty content, skipping'
      });
      continue;
    }

    if (dryRun) {
      summaries.push({
        canonical: canonical.id,
        merged_ids: cluster.map((t) => t.id)
      });
      continue;
    }

    // Use the first cluster member's ID as canonical ID
    canonical.id = cluster[0].id;

    // Save canonical with dedup disabled (it's replacing existing tips)
    await saveTip(canonical, { tipsDir, indexPath, dedupThreshold: 1.0 });

    for (const member of cluster) {
      if (member.id === canonical.id) {
        continue;
      }
      const oldPath = member._filePath;
      const target = path.join(archiveDir, path.basename(oldPath));
      await fs.rename(oldPath, target);
      const idx = await loadIndex(indexPath);
      delete idx.tips[member.id];
      await saveIndex(idx, indexPath);
      archived += 1;
    }

    merged += 1;
    summaries.push({
      canonical: canonical.id,
      merged_ids: cluster.map((t) => t.id)
    });
  }

  return {
    merged,
    archived,
    warnings,
    clusters: summaries
  };
}

export async function reindexAllTips({
  tipsDir = getTipsDir(),
  indexPath = getIndexPath(),
  embedder = generateEmbedding
} = {}) {
  requireApiKey();
  const { tips, warnings } = await loadAllTips(tipsDir);
  const index = {
    model: process.env.TIPS_EMBEDDING_MODEL || 'text-embedding-3-small',
    tips: {}
  };

  for (const tip of tips) {
    const text = toEmbeddingText(tip);
    const embedding = await embedder(text);
    index.tips[tip.id] = {
      text,
      embedding,
      updated: tip.updated || nowIso()
    };
  }

  await saveIndex(index, indexPath);
  return { count: tips.length, warnings };
}

export async function recordFeedback(tipId, outcome, { tipsDir = getTipsDir() } = {}) {
  const { tips } = await loadAllTips(tipsDir);
  const tip = tips.find((t) => t.id === tipId);
  if (!tip) {
    throw new Error(`Tip not found: ${tipId}`);
  }

  const eff = tip.effectiveness || { applied_count: 0, success_count: 0, last_applied: null };
  eff.applied_count = Number(eff.applied_count || 0) + 1;
  if (outcome === 'success') {
    eff.success_count = Number(eff.success_count || 0) + 1;
  }
  eff.last_applied = nowIso();
  tip.effectiveness = eff;
  tip.updated = nowIso();

  await writeTipYaml(tip._filePath, tip);
  return tip;
}
