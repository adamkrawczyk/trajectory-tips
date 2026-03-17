/**
 * Contrastive Trajectory Analysis
 *
 * Compares multiple trajectories for the same or similar tasks,
 * identifies strategy differences, and extracts tips from the delta.
 *
 * Use case: nightly batch — analyze today's agent sessions,
 * find where one agent solved something efficiently that another struggled with.
 */

import { analyzeTrajectoryIntelligence } from './analyzer.js';
import { createOpenAIClient, withRetry, DEFAULT_EXTRACTION_MODEL } from './embeddings.js';
import { normalizeTipCandidate, saveManyTips } from './store.js';

/**
 * Compare two analyzed trajectories and extract contrastive tips.
 * Returns tips that capture what the better trajectory did differently.
 */
async function contrastiveExtraction(analysisA, analysisB, textA, textB, {
  client,
  model,
  domain = 'general',
  labelA = 'Trajectory A',
  labelB = 'Trajectory B'
} = {}) {
  const activeClient = client || createOpenAIClient();
  const activeModel = model || DEFAULT_EXTRACTION_MODEL;

  // Build comparison summary
  const summaryA = formatAnalysisSummary(analysisA, labelA);
  const summaryB = formatAnalysisSummary(analysisB, labelB);

  const systemPrompt = `You are a contrastive trajectory analyzer. You compare two agent execution trajectories and extract tips from their DIFFERENCES.

Focus on:
1. Where one agent succeeded and the other failed — what specific decision differed?
2. Where one was efficient and the other wasteful — what approach was better?
3. Recovery patterns in one that the other lacked
4. Strategy differences that led to different outcomes

Output JSON:
{
  "comparison_outcome": "A_better | B_better | mixed | equivalent",
  "key_differences": [
    {
      "aspect": "<what differs>",
      "trajectory_a": "<what A did>",
      "trajectory_b": "<what B did>",
      "winner": "A | B | tie",
      "insight": "<why the winner's approach is better>"
    }
  ],
  "contrastive_tips": [
    {
      "category": "strategy | recovery | optimization",
      "priority": "high | medium | low",
      "content": "<specific actionable tip derived from the comparison>",
      "trigger": "<when to apply>",
      "negative_example": "<what the worse trajectory did>",
      "tags": ["tag1", "tag2"]
    }
  ]
}

RULES:
- Max 3 contrastive tips (only the most valuable differences)
- Tips must reference SPECIFIC details (commands, paths, approaches) from the trajectories
- Skip trivial differences (formatting, ordering) — focus on decision quality
- If trajectories are essentially equivalent, return empty tips array`;

  const userPrompt = [
    `Domain: ${domain}`,
    '',
    `=== ${labelA} ===`,
    summaryA,
    '',
    `=== ${labelB} ===`,
    summaryB,
    '',
    `=== ${labelA} Raw (condensed) ===`,
    textA.length > 2000 ? textA.slice(0, 1500) + '\n[...]\n' + textA.slice(-500) : textA,
    '',
    `=== ${labelB} Raw (condensed) ===`,
    textB.length > 2000 ? textB.slice(0, 1500) + '\n[...]\n' + textB.slice(-500) : textB
  ].join('\n');

  const response = await withRetry(() => activeClient.chat.completions.create({
    model: activeModel,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.2
  }));

  const content = response?.choices?.[0]?.message?.content;
  if (!content) return { comparison_outcome: 'unknown', key_differences: [], contrastive_tips: [] };

  try {
    return JSON.parse(content);
  } catch {
    return { comparison_outcome: 'unknown', key_differences: [], contrastive_tips: [] };
  }
}

function formatAnalysisSummary(analysis, label) {
  const parts = [`${label}: outcome=${analysis.outcome || 'unknown'}`];

  if (analysis.decision_chain?.length > 0) {
    parts.push('Decision chain:');
    for (const d of analysis.decision_chain.slice(0, 5)) {
      parts.push(`  [${d.causal_role}] ${d.decision} → ${d.consequence}`);
    }
  }

  if (analysis.failure_chains?.length > 0) {
    parts.push('Failures:');
    for (const f of analysis.failure_chains) {
      parts.push(`  Root: ${f.root_cause}${f.recovery_method ? ` → Recovery: ${f.recovery_method}` : ''}`);
    }
  }

  if (analysis.efficiency_issues?.length > 0) {
    parts.push('Inefficiencies:');
    for (const e of analysis.efficiency_issues) {
      parts.push(`  ${e.issue} → ${e.better_approach}`);
    }
  }

  if (analysis.subtask_phases?.length > 0) {
    parts.push('Phases:');
    for (const p of analysis.subtask_phases) {
      parts.push(`  ${p.phase} (${p.outcome}): ${p.transferable_pattern}`);
    }
  }

  return parts.join('\n');
}

/**
 * Run contrastive analysis on pairs of trajectory files.
 * Designed for nightly batch: pass an array of { path, text, label } objects.
 */
async function batchContrastiveAnalysis(trajectories, {
  client,
  domain = 'general',
  dryRun = false
} = {}) {
  const activeClient = client || createOpenAIClient();
  const results = [];

  // Phase 1: Analyze all trajectories
  const analyses = [];
  for (const traj of trajectories) {
    const analysis = await analyzeTrajectoryIntelligence(traj.text, {
      client: activeClient,
      domain
    });
    analyses.push({ ...traj, analysis });
  }

  // Phase 2: Compare pairs (adjacent trajectories, or best vs worst)
  // Sort by outcome quality: clean_success > recovery > inefficient_success > failure
  const outcomeOrder = { clean_success: 0, recovery: 1, inefficient_success: 2, failure: 3, unknown: 4 };
  analyses.sort((a, b) =>
    (outcomeOrder[a.analysis.outcome] ?? 4) - (outcomeOrder[b.analysis.outcome] ?? 4)
  );

  // Compare best vs worst if we have different outcomes
  if (analyses.length >= 2) {
    const best = analyses[0];
    const worst = analyses[analyses.length - 1];

    if (best.analysis.outcome !== worst.analysis.outcome) {
      const contrastive = await contrastiveExtraction(
        best.analysis, worst.analysis,
        best.text, worst.text,
        {
          client: activeClient,
          domain,
          labelA: best.label || 'Best',
          labelB: worst.label || 'Worst'
        }
      );

      const tips = (contrastive.contrastive_tips || [])
        .filter(t => t && t.content)
        .map(t => normalizeTipCandidate({
          ...t,
          purpose: `Contrastive: ${contrastive.comparison_outcome}`,
          domain
        }, {
          domain,
          sourceTrajectoryId: `contrastive-${best.label}-vs-${worst.label}`,
          sourceOutcome: contrastive.comparison_outcome,
          sourceDescription: `Contrastive analysis: ${best.label} vs ${worst.label}`
        }));

      if (!dryRun && tips.length > 0) {
        await saveManyTips(tips);
      }

      results.push({
        comparison: `${best.label} vs ${worst.label}`,
        outcome: contrastive.comparison_outcome,
        differences: contrastive.key_differences,
        tips,
        saved: !dryRun
      });
    }
  }

  // Also compare adjacent pairs if >2 trajectories
  if (analyses.length > 2) {
    for (let i = 0; i < analyses.length - 1 && i < 3; i++) {
      const a = analyses[i];
      const b = analyses[i + 1];
      if (a.analysis.outcome === b.analysis.outcome) continue; // skip same-outcome pairs

      const contrastive = await contrastiveExtraction(
        a.analysis, b.analysis,
        a.text, b.text,
        {
          client: activeClient,
          domain,
          labelA: a.label,
          labelB: b.label
        }
      );

      if (contrastive.contrastive_tips?.length > 0) {
        const tips = contrastive.contrastive_tips
          .filter(t => t && t.content)
          .map(t => normalizeTipCandidate({ ...t, domain }, {
            domain,
            sourceTrajectoryId: `contrastive-${a.label}-vs-${b.label}`,
            sourceOutcome: contrastive.comparison_outcome,
            sourceDescription: `Contrastive: ${a.label} vs ${b.label}`
          }));

        if (!dryRun && tips.length > 0) {
          await saveManyTips(tips);
        }

        results.push({
          comparison: `${a.label} vs ${b.label}`,
          outcome: contrastive.comparison_outcome,
          differences: contrastive.key_differences,
          tips,
          saved: !dryRun
        });
      }
    }
  }

  return results;
}

export {
  contrastiveExtraction,
  batchContrastiveAnalysis,
  formatAnalysisSummary
};
