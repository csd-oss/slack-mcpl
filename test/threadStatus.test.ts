/**
 * channels/typing shown as a Slack thread status ("is thinking…").
 *
 * Run: node --import tsx --test test/threadStatus.test.ts
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SlackAdapter } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { FULL_GRANT, MENTION_EVENT, connectHost, fakeSlack, harness, initialize, until, type Harness } from './harness.js';

function makeAdapter(sendChannels?: string[]) {
  const calls: string[] = [];
  const socket = { on() {}, async start() {}, async disconnect() {} } as any;
  const web = {
    conversations: {
      info: async ({ channel }: { channel: string }) => ({ channel: {
        id: channel, is_im: channel.startsWith('D'), is_mpim: false,
        is_private: channel.startsWith('G'), is_member: true, user: 'U1',
      } }),
    },
    chat: { postMessage: async () => ({ ts: '9.0' }) },
    reactions: { add: async () => {}, remove: async () => {} },
    assistant: {
      threads: {
        setStatus: async ({ channel_id, thread_ts, status }: any) => {
          calls.push(`${channel_id}:${thread_ts}:${status}`);
        },
      },
    },
  } as any;
  return { adapter: new SlackAdapter(web, socket, 'UBOT', 'acme', undefined, sendChannels,
    undefined, undefined, ['channels:read', 'groups:read', 'im:read', 'mpim:read', 'chat:write']), calls, web };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('set once, not again on the host refresh, cleared on stop', async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.setThreadStatus('C1', '1.0');
  await adapter.setThreadStatus('C1', '1.0');
  await adapter.setThreadStatus('C1', undefined);
  await adapter.setThreadStatus('C1', undefined);
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:']);
});

test('moving to another thread clears the old one first', async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.setThreadStatus('C1', '1.0');
  await adapter.setThreadStatus('C1', '2.0');
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:', 'C1:2.0:is thinking…']);
});

test('nothing outside the write allow-list', async () => {
  const { adapter, calls } = makeAdapter(['C9']);
  await adapter.setThreadStatus('C1', '1.0');
  await adapter.setThreadStatus('C1', undefined);
  assert.deepEqual(calls, []);
});

test('a post makes the next refresh set the status again, then stop clears it', async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.setThreadStatus('C1', '1.0');
  await adapter.sendMessage('C1', 'partial answer', { threadTs: '1.0' });
  await adapter.setThreadStatus('C1', '1.0');
  await adapter.setRecipientThreadStatus('C1', '1.0', true);
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:is thinking…', 'C1:1.0:']);
});

for (const channel of ['C1', 'G1', 'D1']) {
  test(`a post in ${channel} retains ownership for stop without another refresh`, async () => {
    const { adapter, calls } = makeAdapter();
    adapter.configureAccessPolicy({ writeChannels: ['C1', 'G1'], dmUsers: ['U1'], readJoinedChannels: true });
    await adapter.setRecipientThreadStatus(channel, '1.0', false);
    await adapter.sendMessage(channel, 'answer', { threadTs: '1.0' });
    await adapter.setRecipientThreadStatus(channel, '1.0', true);
    await adapter.setRecipientThreadStatus(channel, '1.0', true);
    assert.deepEqual(calls, [`${channel}:1.0:is thinking…`, `${channel}:1.0:`]);
  });
}

test('a delayed stop after a post cannot clear a newer root', async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.setRecipientThreadStatus('C1', '1.0', false);
  await adapter.sendMessage('C1', 'answer', { threadTs: '1.0' });
  await adapter.setRecipientThreadStatus('C1', '2.0', false);
  await adapter.setRecipientThreadStatus('C1', '1.0', true);
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:', 'C1:2.0:is thinking…']);
  await adapter.setRecipientThreadStatus('C1', '2.0', true);
  assert.equal(calls.at(-1), 'C1:2.0:');
});

test('posts to another channel, root or top level leave the current refresh throttled', async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.setRecipientThreadStatus('C1', '1.0', false);
  await adapter.sendMessage('C2', 'answer', { threadTs: '1.0' });
  await adapter.sendMessage('C1', 'answer', { threadTs: '2.0' });
  await adapter.sendMessage('C1', 'answer');
  await adapter.setRecipientThreadStatus('C1', '1.0', false);
  await adapter.setRecipientThreadStatus('C1', '2.0', true);
  assert.deepEqual(calls, ['C1:1.0:is thinking…']);
  await adapter.setRecipientThreadStatus('C1', '1.0', true);
  assert.equal(calls.at(-1), 'C1:1.0:');
});

test('a failed post retains ownership and the existing refresh throttle', async () => {
  const { adapter, calls, web } = makeAdapter();
  web.chat.postMessage = async () => { throw new Error('synthetic post failure'); };
  await adapter.setRecipientThreadStatus('C1', '1.0', false);
  await assert.rejects(adapter.sendMessage('C1', 'answer', { threadTs: '1.0' }), /synthetic post failure/);
  await adapter.setRecipientThreadStatus('C1', '1.0', false);
  await adapter.setRecipientThreadStatus('C1', '1.0', true);
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:']);
});

test('status failures stay best effort and do not prevent later turns', async t => {
  const { adapter, calls, web } = makeAdapter();
  const errors = t.mock.method(console, 'error', () => {});
  const setStatus = web.assistant.threads.setStatus;
  web.assistant.threads.setStatus = async () => { throw new Error('synthetic status failure'); };
  await adapter.setRecipientThreadStatus('C1', '1.0', false);
  await adapter.setRecipientThreadStatus('C1', '1.0', true);
  assert.deepEqual(calls, []);
  web.assistant.threads.setStatus = setStatus;
  await adapter.setRecipientThreadStatus('C1', '1.0', false);
  await adapter.sendMessage('C1', 'answer', { threadTs: '1.0' });
  web.assistant.threads.setStatus = async () => { throw new Error('synthetic clear failure'); };
  await adapter.setRecipientThreadStatus('C1', '1.0', true);
  assert.equal(errors.mock.callCount(), 2, 'the post retained ownership, so stop attempted the failed clear');
  web.assistant.threads.setStatus = setStatus;
  await adapter.setRecipientThreadStatus('C1', '2.0', false);
  await adapter.setRecipientThreadStatus('C1', '2.0', true);
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:2.0:is thinking…', 'C1:2.0:']);
});

test('a stop while a post is pending clears once and the post cannot restore ownership', async () => {
  const { adapter, calls, web } = makeAdapter();
  const entered = deferred(), finish = deferred();
  web.chat.postMessage = async () => { entered.resolve(); await finish.promise; return { ts: '9.0' }; };
  await adapter.setRecipientThreadStatus('C1', '1.0', false);
  const post = adapter.sendMessage('C1', 'answer', { threadTs: '1.0' });
  await entered.promise;
  await adapter.setRecipientThreadStatus('C1', '1.0', true);
  finish.resolve(); await post;
  await adapter.setRecipientThreadStatus('C1', '1.0', true);
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:']);
});

test('completion of an older post cannot expire a newer root', async () => {
  const { adapter, calls, web } = makeAdapter();
  const entered = deferred(), finish = deferred();
  web.chat.postMessage = async () => { entered.resolve(); await finish.promise; return { ts: '9.0' }; };
  await adapter.setRecipientThreadStatus('C1', '1.0', false);
  const post = adapter.sendMessage('C1', 'answer', { threadTs: '1.0' });
  await entered.promise;
  await adapter.setRecipientThreadStatus('C1', '2.0', false);
  finish.resolve(); await post;
  await adapter.setRecipientThreadStatus('C1', '2.0', false);
  await adapter.setRecipientThreadStatus('C1', '1.0', true);
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:', 'C1:2.0:is thinking…']);
  await adapter.setRecipientThreadStatus('C1', '2.0', true);
  assert.equal(calls.at(-1), 'C1:2.0:');
});

test('a post during a pending status request retains ownership until the queued stop', async () => {
  const { adapter, calls, web } = makeAdapter();
  const entered = deferred(), finish = deferred();
  const setStatus = web.assistant.threads.setStatus;
  web.assistant.threads.setStatus = async (args: any) => {
    await setStatus(args);
    if (args.status) { entered.resolve(); await finish.promise; }
  };
  const start = adapter.setRecipientThreadStatus('C1', '1.0', false);
  await entered.promise;
  await adapter.sendMessage('C1', 'answer', { threadTs: '1.0' });
  const stop = adapter.setRecipientThreadStatus('C1', '1.0', true);
  finish.resolve(); await Promise.all([start, stop]);
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:']);
});

test('refresh and stop queued after a post stay ordered', async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.setRecipientThreadStatus('C1', '1.0', false);
  await adapter.sendMessage('C1', 'answer', { threadTs: '1.0' });
  await Promise.all([
    adapter.setRecipientThreadStatus('C1', '1.0', false),
    adapter.setRecipientThreadStatus('C1', '1.0', true),
  ]);
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:is thinking…', 'C1:1.0:']);
});

test('a stale connection stop after a post leaves ownership for the current connection', async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.setRecipientThreadStatus('C1', '1.0', false);
  await adapter.sendMessage('C1', 'answer', { threadTs: '1.0' });
  await adapter.setRecipientThreadStatus('C1', '1.0', true, () => false);
  assert.deepEqual(calls, ['C1:1.0:is thinking…']);
  await adapter.setRecipientThreadStatus('C1', '1.0', true);
  assert.equal(calls.at(-1), 'C1:1.0:');
});

test('a stop after a post in the thread still clears the status', async () => {
  const { adapter, calls } = makeAdapter();
  await adapter.setThreadStatus('C1', '1.0');
  await adapter.sendMessage('C1', 'the answer', { threadTs: '1.0' });
  await adapter.setThreadStatus('C1', undefined);
  assert.deepEqual(calls, ['C1:1.0:is thinking…', 'C1:1.0:']);
});

async function ready(h: Pick<Harness, 'host' | 'hostSaw'>, grant = FULL_GRANT) {
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: grant });
  await until(() => h.hostSaw.some((r) => r.method === method.CHANNELS_REGISTER), 'channels/register');
}

test('host typing lands on the thread of the message that woke the agent', async () => {
  const h = harness();
  await ready(h);
  await h.socket.emitMessage({ ...MENTION_EVENT, ts: '5.0', thread_ts: '4.0' });
  h.host.sendNotification(method.CHANNELS_TYPING, { channelId: 'slack:C1', op: 'start' });
  await until(() => h.statuses.length === 1, 'status set');
  h.host.sendNotification(method.CHANNELS_TYPING, { channelId: 'slack:C1', op: 'stop' });
  await until(() => h.statuses.length === 2, 'status cleared');
  assert.deepEqual(h.statuses, ['C1:4.0:is thinking…', 'C1:4.0:']);
  await h.close();
});

test('typing context belongs to the peer: a new connection starts without one', async () => {
  const { slack, socket, statuses } = fakeSlack();
  const server = new SlackMcplServer(slack);
  const first = connectHost(server);
  await ready(first);
  await socket.emitMessage(MENTION_EVENT);
  await until(() => first.hostSaw.some((r) => r.method === method.PUSH_EVENT), 'push to the first client');
  await first.close();
  const second = connectHost(server);
  await ready(second);
  second.host.sendNotification(method.CHANNELS_TYPING, { channelId: 'slack:C1', op: 'start' });
  // Time for a status to be set, were there a thread to set it on.
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(statuses, [], 'no status on a thread the new peer never saw');
  await socket.emitMessage({ ...MENTION_EVENT, ts: '7.0' });
  await until(() => second.hostSaw.some((r) => r.method === method.PUSH_EVENT), 'push to the second client');
  second.host.sendNotification(method.CHANNELS_TYPING, { channelId: 'slack:C1', op: 'start' });
  await until(() => statuses.length === 1, 'status set');
  assert.deepEqual(statuses, ['C1:7.0:is thinking…']);
  await second.close();
});

test('a top-level message gets the status on its own thread', async () => {
  const h = harness();
  await ready(h);
  await h.socket.emitMessage(MENTION_EVENT);
  h.host.sendNotification(method.CHANNELS_TYPING, { channelId: 'slack:C1' });
  await until(() => h.statuses.length === 1, 'status set');
  assert.deepEqual(h.statuses, [`C1:${MENTION_EVENT.ts}:is thinking…`]);
  await h.close();
});
