import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

export const DEFAULT_TIPS_DIR = process.env.TIPS_DIR
  ? path.resolve(process.env.TIPS_DIR)
  : path.resolve(process.cwd(), 'tips');

export const DEFAULT_INDEX_PATH = path.resolve(process.cwd(), 'index.json');

export const CATEGORY_VALUES = ['strategy', 'recovery', 'optimization'];
export const PRIORITY_VALUES = ['critical', 'high', 'medium', 'low'];

export function getTipsDir() {
  return process.env.TIPS_DIR
    ? path.resolve(process.env.TIPS_DIR)
    : DEFAULT_TIPS_DIR;
}

export function getIndexPath() {
  return DEFAULT_INDEX_PATH;
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export function nowIso() {
  return new Date().toISOString();
}

export function generateTipId(date = new Date()) {
  const y = String(date.getUTCFullYear());
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const rand = Math.random().toString(16).slice(2, 8);
  return `tip-${y}${m}${d}-${rand}`;
}

export function safeFileBase(name) {
  return name.toLowerCase().replace(/[^a-z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
}

export function buildTipFilePath(tipsDir, tipId) {
  return path.join(tipsDir, `${safeFileBase(tipId)}.yaml`);
}

export function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const av = Number(a[i]) || 0;
    const bv = Number(b[i]) || 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export async function readTextInput(input) {
  if (input === '-') {
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    return Buffer.concat(chunks.map((c) => Buffer.isBuffer(c) ? c : Buffer.from(String(c)))).toString('utf8');
  }
  return fs.readFile(path.resolve(input), 'utf8');
}

export function extractMarkdownSection(markdown, sectionName) {
  if (!sectionName) {
    return markdown;
  }
  const lines = markdown.split(/\r?\n/);
  const escaped = sectionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const headingPattern = new RegExp(`^#{1,6}\\s+${escaped}\\s*$`, 'i');

  let start = -1;
  let headingLevel = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (headingPattern.test(lines[i])) {
      start = i + 1;
      headingLevel = (lines[i].match(/^#+/)?.[0].length) || 1;
      break;
    }
  }

  if (start === -1) {
    return markdown;
  }

  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    const match = lines[i].match(/^(#{1,6})\s+/);
    if (match && match[1].length <= headingLevel) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trim();
}

export async function writeTipYaml(filePath, tip) {
  const content = YAML.stringify(tip, { indent: 2 });
  await fs.writeFile(filePath, content, 'utf8');
}

export async function readTipYaml(filePath) {
  const raw = await fs.readFile(filePath, 'utf8');
  return YAML.parse(raw);
}

export async function loadAllTips(tipsDir) {
  await ensureDir(tipsDir);
  const entries = await fs.readdir(tipsDir, { withFileTypes: true });
  const tips = [];
  const warnings = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.yaml')) {
      continue;
    }
    const tipPath = path.join(tipsDir, entry.name);
    try {
      const parsed = await readTipYaml(tipPath);
      if (!parsed?.id || !parsed?.content) {
        warnings.push(`Skipping ${entry.name}: missing required fields`);
        continue;
      }
      tips.push({ ...parsed, _filePath: tipPath });
    } catch (err) {
      warnings.push(`Skipping ${entry.name}: ${err.message}`);
    }
  }
  return { tips, warnings };
}

export function normalizeListOption(optionValue) {
  if (!optionValue) {
    return null;
  }
  const arr = String(optionValue)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return arr.length > 0 ? arr : null;
}

export function toEmbeddingText(tip) {
  const steps = Array.isArray(tip.steps) ? tip.steps.join(' ') : '';
  const tags = Array.isArray(tip.tags) ? tip.tags.join(' ') : '';
  return [tip.content, tip.trigger, tip.domain, tip.category, tip.purpose, steps, tags]
    .filter(Boolean)
    .join(' | ');
}

export function estimateTokens(text) {
  if (!text) {
    return 0;
  }
  return Math.ceil(text.length / 4);
}

export function priorityRank(priority) {
  const idx = PRIORITY_VALUES.indexOf(priority);
  return idx === -1 ? PRIORITY_VALUES.length : idx;
}

export function compactTip(tip) {
  return {
    id: tip.id,
    category: tip.category,
    priority: tip.priority,
    domain: tip.domain,
    content: tip.content,
    trigger: tip.trigger,
    purpose: tip.purpose,
    tags: tip.tags,
    created: tip.created,
    updated: tip.updated,
    effectiveness: tip.effectiveness
  };
}

export function normalizeOutcome(outcome) {
  if (!outcome) {
    return 'failure';
  }
  const lc = String(outcome).toLowerCase();
  if (lc === 'success' || lc === 'failure' || lc === 'irrelevant') {
    return lc;
  }
  return 'failure';
}
