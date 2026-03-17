import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTipsForInjection } from '../src/inject.js';

test('prompt injection formatting', () => {
  const prompt = formatTipsForInjection([
    {
      score: 0.91,
      tip: {
        priority: 'high',
        category: 'recovery',
        content: 'Use ExecStartPre to clear stale port',
        trigger: 'systemd service deploy',
        steps: ['Add ExecStartPre', 'Restart service'],
        negative_example: 'Do not ignore stale binds',
        domain: 'infra'
      }
    }
  ], { maxTokens: 500 });

  assert.match(prompt, /Relevant Learnings from Past Executions/);
  assert.match(prompt, /\[PRIORITY: HIGH\] Recovery Tip/);
  assert.match(prompt, /Avoid: Do not ignore stale binds/);
});
