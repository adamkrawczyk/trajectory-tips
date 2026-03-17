import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  saveTip,
  loadIndex,
  reindexAllTips,
  findDuplicates,
  normalizeTipCandidate
} from '../src/store.js';

function fakeEmbedder(text) {
  const codePointSum = [...text].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return Promise.resolve([text.length, codePointSum, 1]);
}

function mkTip(id, content) {
  return normalizeTipCandidate({
    id,
    category: 'recovery',
    priority: 'high',
    domain: 'infra',
    content,
    purpose: 'p',
    trigger: 't',
    steps: ['s1'],
    negative_example: 'n',
    tags: ['x']
  }, {
    domain: 'infra',
    sourceTrajectoryId: 'traj-1',
    sourceOutcome: 'recovery',
    sourceDescription: 'desc'
  });
}

test('index management add and rebuild', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tips-store-'));
  const tipsDir = path.join(dir, 'tips');
  const indexPath = path.join(dir, 'index.json');

  await saveTip(mkTip('tip-a', 'first content'), { tipsDir, indexPath, embedder: fakeEmbedder, dedupThreshold: 1.01 });
  await saveTip(mkTip('tip-b', 'second content'), { tipsDir, indexPath, embedder: fakeEmbedder, dedupThreshold: 1.01 });

  const idx = await loadIndex(indexPath);
  assert.ok(idx.tips['tip-a']);
  assert.ok(idx.tips['tip-b']);

  process.env.OPENAI_API_KEY = 'test-key';
  const rebuilt = await reindexAllTips({ tipsDir, indexPath, embedder: fakeEmbedder });
  assert.equal(rebuilt.count, 2);
  const idx2 = await loadIndex(indexPath);
  assert.equal(Object.keys(idx2.tips).length, 2);
});

test('deduplication logic groups similar tips', () => {
  const tips = [
    mkTip('tip-1', 'restart service with fuser precheck'),
    mkTip('tip-2', 'restart service with fuser precheck'),
    mkTip('tip-3', 'different strategy for seo content')
  ];

  const index = {
    tips: {
      'tip-1': { embedding: [1, 0, 0] },
      'tip-2': { embedding: [0.99, 0.01, 0] },
      'tip-3': { embedding: [0, 1, 0] }
    }
  };

  const groups = findDuplicates(tips, index, 0.95);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 2);
});
