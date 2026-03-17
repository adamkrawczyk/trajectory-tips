import path from 'node:path';
import {
  extractStructuredTipsFromTrajectory,
  createOpenAIClient
} from './embeddings.js';
import {
  analyzeTrajectoryIntelligence,
  formatAnalysisForExtraction
} from './analyzer.js';
import {
  extractMarkdownSection,
  readTextInput
} from './utils.js';
import {
  normalizeTipCandidate,
  saveManyTips
} from './store.js';

/**
 * Deduplicate repeated paragraphs/sections in text.
 * Memory files often contain the same event logged multiple times.
 */
function deduplicateText(text) {
  // Split by double newlines into paragraphs
  const paragraphs = text.split(/\n{2,}/);
  const seen = new Set();
  const unique = [];

  for (const para of paragraphs) {
    // Normalize whitespace for comparison
    const key = para.trim().toLowerCase().replace(/\s+/g, ' ');
    if (key.length < 20) {
      // Keep short lines (headers, etc.) always
      unique.push(para);
      continue;
    }
    if (seen.has(key)) continue;

    // Also check for high overlap (>80% same words) with existing paragraphs
    const words = new Set(key.split(' '));
    let isDupe = false;
    for (const existing of seen) {
      const existingWords = new Set(existing.split(' '));
      const intersection = [...words].filter(w => existingWords.has(w));
      const overlap = intersection.length / Math.max(words.size, existingWords.size);
      if (overlap > 0.8) {
        isDupe = true;
        break;
      }
    }

    if (!isDupe) {
      seen.add(key);
      unique.push(para);
    }
  }

  return unique.join('\n\n');
}

function inferTrajectoryId(inputPath) {
  if (!inputPath || inputPath === '-') {
    return `stdin-${new Date().toISOString().slice(0, 10)}`;
  }
  const base = path.basename(inputPath).replace(path.extname(inputPath), '');
  return `${new Date().toISOString().slice(0, 10)}-${base}`;
}

export async function extractTipsFromInput(input, {
  section,
  domain = 'general',
  dryRun = false,
  sourceDescription = '',
  client,
  analyze = true
} = {}) {
  const raw = await readTextInput(input);
  const sectioned = extractMarkdownSection(raw, section);
  const text = deduplicateText(sectioned);

  const activeClient = client || createOpenAIClient();

  let extractionInput = text;
  let analysis = null;

  // Phase 1: Trajectory Intelligence Analysis (when enabled and text is substantial enough)
  if (analyze && text.length > 500) {
    try {
      analysis = await analyzeTrajectoryIntelligence(text, {
        client: activeClient,
        domain
      });
      // Format structured analysis as enriched input for extraction
      extractionInput = formatAnalysisForExtraction(analysis, text);
    } catch (err) {
      // Fall back to raw text if analysis fails
      if (process.env.TIPS_DEBUG) {
        console.error(`Phase 1 analysis failed, falling back to raw extraction: ${err.message}`);
      }
    }
  }

  const extracted = await extractStructuredTipsFromTrajectory(extractionInput, {
    client: activeClient,
    domain
  });

  const trajectoryId = inferTrajectoryId(input);
  const sourceDesc = sourceDescription || `Extracted from ${input}`;

  const tips = extracted.tips
    .filter((t) => t && t.content)
    .map((candidate) => normalizeTipCandidate(candidate, {
      domain,
      sourceTrajectoryId: trajectoryId,
      sourceOutcome: analysis?.outcome || extracted.trajectory_outcome,
      sourceDescription: sourceDesc
    }));

  if (!dryRun) {
    await saveManyTips(tips);
  }

  return {
    trajectory_outcome: analysis?.outcome || extracted.trajectory_outcome,
    decision_attribution: extracted.decision_attribution,
    analysis: analysis ? {
      thought_classification: analysis.thought_classification,
      decision_chain: analysis.decision_chain,
      failure_chains: analysis.failure_chains,
      subtask_phases: analysis.subtask_phases,
      efficiency_issues: analysis.efficiency_issues
    } : null,
    tips,
    saved: !dryRun
  };
}

export async function importTipsFromInputs(inputs, opts = {}) {
  const all = [];
  for (const input of inputs) {
    const result = await extractTipsFromInput(input, opts);
    all.push({ input, ...result });
  }
  return all;
}
