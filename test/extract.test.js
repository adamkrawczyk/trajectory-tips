import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractTipsFromInput } from '../src/extract.js';

function mockClientFromFixture(payload) {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(payload) } }]
        })
      }
    }
  };
}

test('mock LLM extraction uses structured fixture', async () => {
  const fixture = JSON.parse(await fs.readFile(path.resolve('fixtures/extraction-response.json'), 'utf8'));
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'tips-extract-'));
  const inputPath = path.join(tmp, 'trajectory.md');
  await fs.writeFile(inputPath, '# Run\nService restart failed then recovered', 'utf8');

  const result = await extractTipsFromInput(inputPath, {
    dryRun: true,
    domain: 'infra',
    client: mockClientFromFixture(fixture)
  });

  assert.equal(result.trajectory_outcome, 'recovery');
  assert.equal(result.tips.length, 1);
  assert.equal(result.tips[0].category, 'recovery');
  assert.equal(result.saved, false);
});
