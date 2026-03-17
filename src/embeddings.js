import OpenAI from 'openai';

// Model defaults adapt to provider
function getDefaultExtractionModel() {
  if (process.env.TIPS_MODEL) return process.env.TIPS_MODEL;
  if (process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY) return 'google/gemini-2.0-flash-001';
  if (process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) return 'gemini-2.0-flash';
  return 'gpt-4o-mini';
}

function getDefaultEmbeddingModel() {
  if (process.env.TIPS_EMBEDDING_MODEL) return process.env.TIPS_EMBEDDING_MODEL;
  if (process.env.OPENROUTER_API_KEY && !process.env.OPENAI_API_KEY) return 'openai/text-embedding-3-small';
  if (process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) return 'text-embedding-004';
  return 'text-embedding-3-small';
}

export const DEFAULT_EXTRACTION_MODEL = getDefaultExtractionModel();
export const DEFAULT_EMBEDDING_MODEL = getDefaultEmbeddingModel();

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableError(err) {
  if (!err) {
    return false;
  }
  const status = err.status ?? err.statusCode;
  if (typeof status === 'number' && [408, 409, 429, 500, 502, 503, 504].includes(status)) {
    return true;
  }
  const msg = String(err.message || '').toLowerCase();
  return msg.includes('timeout') || msg.includes('network') || msg.includes('econnreset') || msg.includes('rate limit');
}

export async function withRetry(fn, { attempts = 5, baseDelayMs = 2000 } = {}) {
  let lastErr;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i === attempts - 1 || !isRetryableError(err)) {
        throw err;
      }
      const delay = baseDelayMs * (2 ** i);
      await sleep(delay);
    }
  }
  throw lastErr;
}

export function requireApiKey() {
  if (!process.env.OPENAI_API_KEY && !process.env.GEMINI_API_KEY && !process.env.OPENROUTER_API_KEY) {
    throw new Error('OPENAI_API_KEY, OPENROUTER_API_KEY, or GEMINI_API_KEY is required.');
  }
}

export function createOpenAIClient() {
  requireApiKey();
  // Priority: OpenAI > OpenRouter > Gemini
  if (process.env.OPENAI_API_KEY) {
    return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  if (process.env.OPENROUTER_API_KEY) {
    return new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1'
    });
  }
  return new OpenAI({
    apiKey: process.env.GEMINI_API_KEY,
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/'
  });
}

export async function generateEmbedding(text, { client, model = DEFAULT_EMBEDDING_MODEL } = {}) {
  const activeClient = client || createOpenAIClient();
  const response = await withRetry(() =>
    activeClient.embeddings.create({
      model,
      input: text
    })
  );

  const embedding = response?.data?.[0]?.embedding;
  if (!Array.isArray(embedding)) {
    throw new Error('Embedding response missing vector data.');
  }
  return embedding;
}

export async function extractStructuredTipsFromTrajectory(trajectoryText, {
  client,
  model = DEFAULT_EXTRACTION_MODEL,
  domain = 'general'
} = {}) {
  const activeClient = client || createOpenAIClient();
  const system = [
    'You extract SPECIFIC, ACTIONABLE memory tips from agent execution trajectories or documentation.',
    '',
    'INPUT FORMAT:',
    'The input may be either:',
    '(a) A structured analysis with classified thoughts, decision chains, failure chains, subtask phases, and efficiency issues — followed by condensed original text, OR',
    '(b) Raw trajectory text without pre-analysis.',
    'When structured analysis is provided, use it to produce HIGHER QUALITY tips by:',
    '- Tracing failure chains to ROOT CAUSES (not just symptoms)',
    '- Extracting tips at the subtask/phase level for cross-task transfer',
    '- Using the decision chain to understand which specific decisions matter',
    '- Referencing specific commands/paths/errors from the original text for concrete tips',
    '',
    'CRITICAL RULES:',
    '- MAXIMUM 5 tips per extraction. Quality over quantity.',
    '- DEDUPLICATE aggressively: if two insights are about the same tool/config/pattern, merge them into ONE tip.',
    '- Extract CONCRETE details: exact commands, paths, API names, error messages, config values.',
    '- NEVER generate vague advice like "follow best practices" or "maintain documentation".',
    '- Each tip must contain enough detail that an agent can act on it WITHOUT reading the source.',
    '- Include exact commands, file paths, parameter names, error strings when present.',
    '',
    'TIP GRANULARITY:',
    '- Prefer SUBTASK-LEVEL tips over task-level tips when possible.',
    '- A subtask tip should be generic enough to apply across different tasks sharing the same phase.',
    '- Example: "When configuring Cloudflare tunnels..." is subtask-level (transfers to any CF deployment).',
    '- Example: "When deploying a staging web app on March 15..." is task-level (too specific to transfer).',
    '',
    'PRIORITY ORDER (extract these first):',
    '1. Recovery tips — debugging steps that fixed a non-obvious problem (highest value)',
    '2. Gotcha tips — things that look like they should work but don\'t, with the correct approach',
    '3. Configuration tips — specific settings/paths/flags that prevent wasted time',
    '4. Strategy tips — workflow patterns that proved effective (lowest priority, skip if >5 tips)',
    '',
    'SKIP THESE (low value):',
    '- Obvious observations ("add schema markup to improve SEO")',
    '- Generic best practices without specific commands',
    '- Tips that just restate what happened without actionable insight',
    '- Multiple tips about the same concept (merge into one)',
    '',
    'If the source text contains repeated/duplicate sections, treat it as ONE narrative and extract unique tips only.',
    '',
    'Process:',
    '1) Use the trajectory outcome from analysis (or classify if not provided): clean_success | inefficient_success | recovery | failure',
    '2) Use failure chains for decision attribution with SPECIFIC root causes (not symptoms)',
    '3) Generate ≤5 tips with: category (strategy|recovery|optimization), priority, domain, content, purpose, trigger, steps (array), negative_example, tags',
    '',
    'GOOD tip: "Use /opt/tools/codex (v0.98.0), NOT /usr/bin/codex (outdated v0.91.0). Prefix PATH or use full path."',
    'BAD tip: "Always specify full paths for binaries to avoid version conflicts."',
    '',
    'Return strict JSON with keys: trajectory_outcome, decision_attribution, tips.',
    'Each tip: category, priority, domain, content, purpose, trigger, steps (array of concrete actions), negative_example, tags.'
  ].join('\n');

  const user = [
    `Target domain: ${domain}`,
    'Trajectory text:',
    trajectoryText
  ].join('\n\n');

  const response = await withRetry(() => activeClient.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.2
  }));

  const content = response?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Extraction model returned empty content.');
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(`Extraction model returned invalid JSON: ${err.message}`);
  }

  if (!Array.isArray(parsed?.tips)) {
    throw new Error('Extraction output missing tips array.');
  }

  return {
    trajectory_outcome: parsed.trajectory_outcome || 'failure',
    decision_attribution: parsed.decision_attribution || '',
    tips: parsed.tips
  };
}

export async function mergeTipsWithLLM(tips, { client, model = DEFAULT_EXTRACTION_MODEL } = {}) {
  const activeClient = client || createOpenAIClient();
  const system = 'Merge these overlapping tips into ONE canonical tip that preserves ALL specific details (commands, paths, error messages). The merged content field MUST be non-empty and contain the most specific/actionable version. Return strict JSON with all tip fields: category, priority, domain, content, trigger, purpose, steps, negative_example, tags.';
  const user = JSON.stringify({ tips }, null, 2);

  const response = await withRetry(() => activeClient.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.1
  }));

  const content = response?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Merge model returned empty content.');
  }

  return JSON.parse(content);
}
