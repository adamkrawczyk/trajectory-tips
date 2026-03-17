import test from 'node:test';
import assert from 'node:assert/strict';
import { createProgram } from '../src/cli.js';

test('CLI registers expected commands', () => {
  const program = createProgram();
  const names = program.commands.map((c) => c.name());
  for (const required of ['extract', 'query', 'inject', 'list', 'consolidate', 'feedback', 'import', 'reindex']) {
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
