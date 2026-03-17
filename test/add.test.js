import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createProgram } from '../src/cli.js';
import { loadIndex } from '../src/store.js';
import { readTipYaml } from '../src/utils.js';
import { fakeEmbedder } from './helpers.js';

async function withTempCliContext(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tips-add-'));
  const tipsDir = path.join(dir, 'tips');
  const indexPath = path.join(dir, 'index.json');

  try {
    await fn({ dir, tipsDir, indexPath });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function captureLogs(fn) {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => {
    logs.push(args.join(' '));
  };

  try {
    await fn();
  } finally {
    console.log = origLog;
  }

  return logs.join('\n');
}

test('tips add with all flags writes yaml and updates index', async () => {
  await withTempCliContext(async ({ tipsDir, indexPath }) => {
    const program = createProgram({
      runtimeContext: { tipsDir, indexPath, embedder: fakeEmbedder }
    });

    await program.parseAsync([
      'add',
      '--content', 'Restart the stuck worker after clearing the lock file',
      '--trigger', 'Worker restarts fail because a stale lock remains',
      '--category', 'recovery',
      '--domain', 'infra',
      '--priority', 'high',
      '--tags', 'Workers,Locks,Recovery',
      '--source-trajectory', 'traj-123'
    ], { from: 'user' });

    const files = await fs.readdir(tipsDir);
    assert.equal(files.length, 1);

    const tip = await readTipYaml(path.join(tipsDir, files[0]));
    assert.match(tip.id, /^tip-\d{8}-[a-f0-9]{6}$/);
    assert.equal(tip.category, 'recovery');
    assert.equal(tip.domain, 'infra');
    assert.equal(tip.priority, 'high');
    assert.equal(tip.content, 'Restart the stuck worker after clearing the lock file');
    assert.equal(tip.trigger, 'Worker restarts fail because a stale lock remains');
    assert.deepEqual(tip.tags, ['workers', 'locks', 'recovery']);
    assert.equal(tip.source.trajectory_id, 'traj-123');

    const index = await loadIndex(indexPath);
    assert.ok(index.tips[tip.id]);
  });
});

test('tips add with only required flags applies defaults', async () => {
  await withTempCliContext(async ({ tipsDir, indexPath }) => {
    const program = createProgram({
      runtimeContext: { tipsDir, indexPath, embedder: fakeEmbedder }
    });

    await program.parseAsync([
      'add',
      '--content', 'Check the process table before retrying deploy',
      '--trigger', 'A deploy appears hung'
    ], { from: 'user' });

    const files = await fs.readdir(tipsDir);
    assert.equal(files.length, 1);

    const tip = await readTipYaml(path.join(tipsDir, files[0]));
    assert.equal(tip.category, 'strategy');
    assert.equal(tip.domain, 'general');
    assert.equal(tip.priority, 'medium');
    assert.deepEqual(tip.tags, []);
    assert.equal(tip.source.trajectory_id, 'manual');
  });
});

test('tips add dry run prints yaml without writing files', async () => {
  await withTempCliContext(async ({ tipsDir, indexPath }) => {
    const program = createProgram({
      runtimeContext: { tipsDir, indexPath, embedder: fakeEmbedder }
    });

    const output = await captureLogs(async () => {
      await program.parseAsync([
        'add',
        '--content', 'Tail the service logs before restarting',
        '--trigger', 'The service crashes immediately after boot',
        '--dry-run'
      ], { from: 'user' });
    });

    assert.match(output, /id: tip-\d{8}-[a-f0-9]{6}/);
    assert.match(output, /content: Tail the service logs before restarting/);
    assert.match(output, /trigger: The service crashes immediately after boot/);

    await assert.rejects(fs.access(tipsDir));
  });
});

test('tips add errors when required flags are missing', async () => {
  await withTempCliContext(async ({ tipsDir, indexPath }) => {
    const program = createProgram({
      runtimeContext: { tipsDir, indexPath, embedder: fakeEmbedder }
    });

    await assert.rejects(
      program.parseAsync([
        'add',
        '--content', 'Only content is provided'
      ], { from: 'user' }),
      /Both --content and --trigger are required unless running with no flags\./
    );
  });
});
