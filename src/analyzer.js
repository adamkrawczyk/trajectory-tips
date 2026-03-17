/**
 * Phase 1: Trajectory Intelligence Analyzer
 *
 * Implements the paper's Trajectory Intelligence Extractor + Decision Attribution Analyzer.
 * Parses raw agent logs into structured intermediate representation before tip extraction.
 *
 * Reference: "Trajectory-Informed Memory Generation for Self-Improving Agent Systems"
 * (Fang et al., IBM Research, 2026) — arxiv.org/html/2603.10600v1
 */

import { createOpenAIClient, withRetry, DEFAULT_EXTRACTION_MODEL } from './embeddings.js';

/**
 * Step 1: Parse raw trajectory into structured steps.
 * Identifies agent actions, tool calls, outputs, and thought patterns.
 */
function parseTrajectorySteps(text) {
  const steps = [];
  // Common patterns in agent logs:
  // - Codex/Claude Code: "Thinking...", "Running: <command>", "Output: ...", "Error: ..."
  // - OpenClaw sessions: tool calls, responses, user messages
  // - Memory files: narrative descriptions of what happened

  const lines = text.split('\n');
  let currentStep = null;
  let stepIndex = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Detect step boundaries
    const isAction = /^(Running|Executing|Command|Tool|Action|Step \d|>\s)[:>]/i.test(trimmed);
    const isThought = /^(Thinking|Planning|Reasoning|Considering|I (need|should|will|think|notice|realize)|Let me|First,|Next,|Now )/i.test(trimmed);
    const isError = /^(Error|Failed|Exception|Traceback|FAIL|✗|❌|panic)/i.test(trimmed);
    const isOutput = /^(Output|Result|Response|Return|✓|✅|Success)/i.test(trimmed);
    const isReflection = /^(Actually|Wait|Hmm|On second thought|I was wrong|Let me reconsider|The issue|The problem|This (isn't|doesn't|won't))/i.test(trimmed);
    const isRecovery = /^(Fix|Retry|Instead|Workaround|The correct|The solution|To fix|Resolved)/i.test(trimmed);

    if (isAction || isThought || isError || isReflection || isRecovery) {
      // Close previous step
      if (currentStep) {
        steps.push(currentStep);
      }

      stepIndex++;
      currentStep = {
        index: stepIndex,
        type: isError ? 'error' : isReflection ? 'reflection' : isRecovery ? 'recovery' :
              isAction ? 'action' : 'thought',
        content: trimmed,
        lines: [trimmed]
      };
    } else if (currentStep) {
      currentStep.lines.push(trimmed);
      currentStep.content += '\n' + trimmed;
    } else {
      // Context before first recognized step
      stepIndex++;
      currentStep = {
        index: stepIndex,
        type: isOutput ? 'output' : 'context',
        content: trimmed,
        lines: [trimmed]
      };
    }
  }

  if (currentStep) {
    steps.push(currentStep);
  }

  return steps;
}

/**
 * Step 2: Use LLM to classify thoughts and build causal chains.
 * This is the key Phase 1 addition from the paper.
 */
async function analyzeTrajectoryIntelligence(text, { client, model, domain = 'general' } = {}) {
  const activeClient = client || createOpenAIClient();
  const activeModel = model || DEFAULT_EXTRACTION_MODEL;

  // Parse basic structure first (cheap, no LLM)
  const steps = parseTrajectorySteps(text);

  // Truncate to avoid token limits — keep first 6000 chars + last 2000 chars
  let analysisText = text;
  if (text.length > 10000) {
    analysisText = text.slice(0, 6000) + '\n\n[... middle truncated ...]\n\n' + text.slice(-2000);
  }

  const systemPrompt = `You are a trajectory intelligence analyzer for AI agent execution logs.

Your job is to produce a STRUCTURED INTERMEDIATE REPRESENTATION of an agent's execution, NOT tips.

Analyze the trajectory and output JSON with these fields:

{
  "outcome": "clean_success | inefficient_success | recovery | failure",
  "thought_classification": [
    {
      "step": <number>,
      "type": "analytical | planning | validation | reflection | self_correction | error_recognition",
      "summary": "<1-line summary of this thought>",
      "quality": "positive | negative | neutral"
    }
  ],
  "decision_chain": [
    {
      "step": <number>,
      "decision": "<what the agent decided>",
      "consequence": "<what resulted>",
      "causal_role": "root_cause | proximate_cause | contributing_factor | successful_decision | recovery_decision"
    }
  ],
  "subtask_phases": [
    {
      "phase": "<name: e.g. 'authentication', 'data_retrieval', 'configuration', 'deployment', 'debugging'>",
      "steps": [<step numbers>],
      "outcome": "success | partial | failure",
      "transferable_pattern": "<generic description of what worked/failed, abstracted from specifics>"
    }
  ],
  "failure_chains": [
    {
      "symptom_step": <step where failure manifested>,
      "root_cause_step": <step where bad decision was made>,
      "root_cause": "<specific description of the root cause>",
      "recovery_step": <step where recovery happened, or null>,
      "recovery_method": "<how it was fixed, or null>"
    }
  ],
  "efficiency_issues": [
    {
      "steps": [<step numbers involved>],
      "issue": "<what was inefficient>",
      "better_approach": "<what should have been done>"
    }
  ]
}

RULES:
- Be SPECIFIC: reference actual commands, files, errors from the text
- thought_classification should cover the 5-8 most important reasoning moments, not every line
- decision_chain should trace the critical path (max 6-8 entries)
- failure_chains: trace symptoms back to ROOT CAUSES (which may be many steps earlier)
- subtask_phases: abstract the phase names so they transfer across different tasks
- If the trajectory is a memory/narrative file rather than raw agent log, still identify decisions and their consequences
- Output ONLY valid JSON`;

  const response = await withRetry(() => activeClient.chat.completions.create({
    model: activeModel,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Domain: ${domain}\n\nAgent execution trajectory:\n${analysisText}` }
    ],
    temperature: 0.1
  }));

  const content = response?.choices?.[0]?.message?.content;
  if (!content) {
    // Fall back to basic structure if LLM fails
    return {
      outcome: 'unknown',
      thought_classification: [],
      decision_chain: [],
      subtask_phases: [],
      failure_chains: [],
      efficiency_issues: [],
      raw_steps: steps
    };
  }

  try {
    const analysis = JSON.parse(content);
    analysis.raw_steps = steps;
    return analysis;
  } catch {
    return {
      outcome: 'unknown',
      thought_classification: [],
      decision_chain: [],
      subtask_phases: [],
      failure_chains: [],
      efficiency_issues: [],
      raw_steps: steps
    };
  }
}

/**
 * Step 3: Format the structured analysis as context for the tip extraction prompt.
 * This replaces raw text with a semantically-rich intermediate representation.
 */
function formatAnalysisForExtraction(analysis, originalText) {
  const sections = [];

  sections.push(`## Trajectory Outcome: ${analysis.outcome || 'unknown'}`);

  if (analysis.thought_classification?.length > 0) {
    sections.push('\n## Agent Reasoning Classification');
    for (const t of analysis.thought_classification) {
      sections.push(`- Step ${t.step} [${t.type}] (${t.quality}): ${t.summary}`);
    }
  }

  if (analysis.decision_chain?.length > 0) {
    sections.push('\n## Critical Decision Chain');
    for (const d of analysis.decision_chain) {
      sections.push(`- Step ${d.step} [${d.causal_role}]: ${d.decision} → ${d.consequence}`);
    }
  }

  if (analysis.failure_chains?.length > 0) {
    sections.push('\n## Failure Analysis (Root Cause Chains)');
    for (const f of analysis.failure_chains) {
      sections.push(`- Symptom at step ${f.symptom_step}, root cause at step ${f.root_cause_step}: ${f.root_cause}`);
      if (f.recovery_step) {
        sections.push(`  Recovery at step ${f.recovery_step}: ${f.recovery_method}`);
      }
    }
  }

  if (analysis.efficiency_issues?.length > 0) {
    sections.push('\n## Efficiency Issues');
    for (const e of analysis.efficiency_issues) {
      sections.push(`- Steps ${e.steps?.join(',')}: ${e.issue} → Better: ${e.better_approach}`);
    }
  }

  if (analysis.subtask_phases?.length > 0) {
    sections.push('\n## Subtask Phases (for cross-task transfer)');
    for (const p of analysis.subtask_phases) {
      sections.push(`- ${p.phase} (${p.outcome}): ${p.transferable_pattern}`);
    }
  }

  // Include condensed original text for specific details the analysis might reference
  const condensed = originalText.length > 4000
    ? originalText.slice(0, 3000) + '\n[...truncated...]\n' + originalText.slice(-1000)
    : originalText;

  sections.push('\n## Original Trajectory (condensed)');
  sections.push(condensed);

  return sections.join('\n');
}

export {
  parseTrajectorySteps,
  analyzeTrajectoryIntelligence,
  formatAnalysisForExtraction
};
