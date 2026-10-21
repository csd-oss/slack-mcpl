import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { FULL_GRANT, MENTION_EVENT, harness, initialize, until } from './harness.js';

test('a message event\'s action_token is kept for its conversation, and never reaches the host', async () => {
  const h = harness();
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'channels/register');

  assert.equal(h.slack.actionToken('C1'), undefined);
  await h.socket.emitMessage({ ...MENTION_EVENT, action_token: 'tok-1' });
  await until(() => h.hostSaw.some((r) => r.method === method.PUSH_EVENT), 'push/event');
  assert.equal(h.slack.actionToken('C1')?.token, 'tok-1');
  assert.ok(Date.now() - h.slack.actionToken('C1')!.at < 5000);

  // A later mention replaces it; one under assistant_thread counts too.
  await h.socket.emitMessage({ ...MENTION_EVENT, ts: '112.1', assistant_thread: { action_token: 'tok-2' } });
  assert.equal(h.slack.actionToken('C1')?.token, 'tok-2');
  // A message without one leaves the newest in place.
  await h.socket.emitMessage({ ...MENTION_EVENT, ts: '113.1' });
  assert.equal(h.slack.actionToken('C1')?.token, 'tok-2');
  assert.equal(h.slack.actionToken('C2'), undefined);

  assert.ok(!JSON.stringify(h.hostSaw).includes('tok-'), 'the token is not in anything sent to the host');
  await h.close();
});
