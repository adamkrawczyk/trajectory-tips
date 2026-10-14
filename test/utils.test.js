import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  cosineSimilarity,
  getTipsDir,
  writeTipYaml,
  readTipYaml,
  loadAllTips
} from '../src/utils.js';

test('cosine similarity handles basics', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(Math.round(cosineSimilarity([1, 0], [0, 1]) * 1000) / 1000, 0);
  assert.equal(cosineSimilarity([], []), 0);
});

test('YAML tip serialization/deserialization round trip', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tips-utils-'));
  const file = path.join(dir, 'sample.yaml');
  const tip = {
    id: 'tip-1',
    category: 'strategy',
    priority: 'high',
    domain: 'general',
    content: 'Test content',
    steps: ['a', 'b'],
    effectiveness: { applied_count: 0, success_count: 0, last_applied: null }
  };

  await writeTipYaml(file, tip);
  const parsed = await readTipYaml(file);
  assert.equal(parsed.id, tip.id);
  assert.equal(parsed.content, tip.content);

  const loaded = await loadAllTips(dir);
  assert.equal(loaded.tips.length, 1);
  assert.equal(loaded.tips[0].id, 'tip-1');
});

test('getTipsDir resolves from current cwd at call time when TIPS_DIR is unset', async () => {
  const previousCwd = process.cwd();
  const previousTipsDir = process.env.TIPS_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tips-utils-cwd-'));

  delete process.env.TIPS_DIR;
  process.chdir(dir);

  try {
    assert.equal(getTipsDir(), path.join(dir, 'tips'));
  } finally {
    process.chdir(previousCwd);
    if (previousTipsDir === undefined) {
      delete process.env.TIPS_DIR;
    } else {
      process.env.TIPS_DIR = previousTipsDir;
    }
  }
});
