import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProgram } from '../src/cli.js';
import { fakeEmbedder } from './helpers.js';

test('CLI registers expected commands', () => {
  const program = createProgram();
  const names = program.commands.map((c) => c.name());
  for (const required of ['add', 'extract', 'query', 'inject', 'list', 'consolidate', 'feedback', 'import', 'reindex']) {
    assert.ok(names.includes(required), `missing command ${required}`);
  }
});

test('query command parses arguments', async () => {
  const program = createProgram();
  let called = false;
  const cmd = program.commands.find((c) => c.name() === 'query');
  cmd.action(async () => {
    called = true;
  });

  await program.parseAsync(['query', 'deploy'], { from: 'user' });
  assert.equal(called, true);
});

test('query command uses injected implementation and runtime paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tips-cli-query-'));
  const calls = [];
  const program = createProgram({
    runtimeContext: {
      tipsDir: path.join(dir, 'tips'),
      indexPath: path.join(dir, 'index.json'),
      embedder: fakeEmbedder
    },
    queryTipsImpl: async (description, options) => {
      calls.push({ description, options });
      return { method: 'semantic', warnings: [], results: [] };
    }
  });

  await program.parseAsync(['query', 'deploy issue'], { from: 'user' });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].description, 'deploy issue');
  assert.equal(calls[0].options.tipsDir, path.join(dir, 'tips'));
  assert.equal(calls[0].options.indexPath, path.join(dir, 'index.json'));
  assert.equal(calls[0].options.embedder, fakeEmbedder);
});
