import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeTipYaml } from '../src/utils.js';
import { queryTips } from '../src/retrieve.js';

function constantEmbedder() {
  return Promise.resolve([1, 0, 0]);
}

async function setupTips() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tips-retrieve-'));
  const tipsDir = path.join(dir, 'tips');
  const indexPath = path.join(dir, 'index.json');
  await fs.mkdir(tipsDir, { recursive: true });

  const tips = [
    {
      id: 'tip-1', category: 'recovery', priority: 'high', domain: 'devops', content: 'Fix systemd port conflict',
      trigger: 'deploy', purpose: 'avoid failure', steps: ['step'], tags: ['systemd'],
      effectiveness: { applied_count: 0, success_count: 0, last_applied: null }, created: new Date().toISOString(), updated: new Date().toISOString()
    },
    {
      id: 'tip-2', category: 'strategy', priority: 'low', domain: 'seo', content: 'Write clear metadata',
      trigger: 'publishing', purpose: 'ranking', steps: ['step'], tags: ['seo'],
      effectiveness: { applied_count: 0, success_count: 0, last_applied: null }, created: new Date().toISOString(), updated: new Date().toISOString()
    }
  ];

  for (const tip of tips) {
    await writeTipYaml(path.join(tipsDir, `${tip.id}.yaml`), tip);
  }

  await fs.writeFile(indexPath, JSON.stringify({
    model: 'text-embedding-3-small',
    tips: {
      'tip-1': { embedding: [1, 0, 0], text: '', updated: new Date().toISOString() },
      'tip-2': { embedding: [0, 1, 0], text: '', updated: new Date().toISOString() }
    }
  }), 'utf8');

  return { tipsDir, indexPath };
}

test('query filtering by domain/category/priority', async () => {
  const { tipsDir, indexPath } = await setupTips();
  const result = await queryTips('systemd deploy', {
    tipsDir,
    indexPath,
    domain: 'devops',
    category: 'recovery',
    priority: 'high',
    embedder: constantEmbedder
  });

  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].tip.id, 'tip-1');
});
