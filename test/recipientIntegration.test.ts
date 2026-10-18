import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, realpathSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {method} from '@animalabs/mcpl-core';
import {SlackAdapter} from '../src/slack-adapter.js';
import {SlackMcplServer} from '../src/server.js';
import {RECIPIENT_CAPABILITY, createRecipientHostBridge, recipientCapability} from '../src/host-compatibility.js';
import {connectHost, FULL_GRANT, until} from './harness.js';

const advanced = Number(process.versions.node.split('.')[0]) >= 24 ? test : test.skip;
const policy = {readJoinedChannels: true, writeChannels: ['CWRITE'], dmUsers: ['UOWNER']};
function fixture(t: {after(fn: () => unknown): void}) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'recipient-integration-')));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  let listener: any;
  const posts: any[] = [], statuses: any[] = [], reactions: any[] = [];
  const socket = {on(_event: string, handler: any) {listener = handler;}, async start() {}, async disconnect() {}};
  let member = true;
  let parentThread: string | undefined;
  let repliesGate: Promise<void> | undefined;
  let repliesWaiting = false;
  const web = {
    conversations: {
      async list() { return {channels: ['CWRITE', 'CREAD'].map(id => ({id, name: id, is_member: member,
        is_private: false, is_im: false, is_mpim: false}))}; },
      async info({channel}: any) {return {channel: {id: channel, name: channel, is_member: member,
        is_im: channel.startsWith('D'), is_mpim: false, is_private: false, user: 'UOWNER'}};},
      async open() {return {channel: {id: 'DPEER'}};},
      async history() {return {messages: []};},
      async replies({ts}: any) {
        if (repliesGate) {repliesWaiting = true; await repliesGate;}
        return {messages: [{ts, thread_ts: parentThread ?? ts, user: 'UOWNER', text: 'root'}]};
      },
    },
    chat: {async postMessage(args: any) {posts.push(args); return {ts: '999.1'};}, async update() {}, async delete() {}},
    reactions: {async add(args: any) {reactions.push(args);}, async remove() {}},
    assistant: {threads: {async setStatus(args: any) {statuses.push(args);}}},
    users: {async info({user}: any) {return {user: {is_bot: user === 'UPEER', name: user}};}, async list() {return {members: []};}},
  };
  const slack = new SlackAdapter(web as any, socket, 'USELF', 'test', undefined, undefined, false, 'eyes',
    ['channels:read', 'channels:history', 'im:read', 'im:history', 'users:read', 'chat:write', 'reactions:write']);
  slack.configureAccessPolicy(policy);
  slack.configureRecipientRouting({stateFile: join(directory, 'receipts.sqlite'), namespace: 'test', expectedBotUserId: 'USELF'});
  const server = new SlackMcplServer(slack, {subscribeMemberChannels: true, disabledTools: ['subscribe_channel', 'unsubscribe_channel']});
  const host = connectHost(server);
  t.after(async () => {await host.close(); await slack.stop();});
  return {...host, slack, posts, statuses, reactions,
    revoke() {member = false;},
    useChildAsParent() {parentThread = '50.1';},
    holdReplies() {
      let release!: () => void;
      repliesGate = new Promise<void>(resolve => {release = resolve;});
      return {release, pending: () => repliesWaiting};
    },
    async emit(patch: Record<string, unknown> = {}) {
      await listener({event: {type: 'message', channel: 'CWRITE', user: 'UOWNER', ts: '100.2',
        text: '<@USELF> hello', ...patch}, ack: async () => {}});
      await new Promise(resolve => setTimeout(resolve, 25));
    },
  };
}
async function ready(h: ReturnType<typeof fixture>) {
  const initialized = await h.host.sendRequest(method.INITIALIZE, {capabilities: {experimental: {
    mcpl: {version: '0.5'}, [RECIPIENT_CAPABILITY]: recipientCapability('USELF'),
  }}}) as any;
  assert.deepEqual(initialized.capabilities.experimental[RECIPIENT_CAPABILITY], recipientCapability('USELF'));
  h.host.sendNotification('notifications/initialized');
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {effectiveCapabilities: [...FULL_GRANT, 'channels.typing']});
  await until(() => h.hostSaw.some(request => request.method === method.CHANNELS_REGISTER), 'registration');
}

advanced('recipient mode refuses absent, partial, other-recipient and non-MCPL host promises before registration', async t => {
  for (const experimental of [{}, {mcpl: {version: '0.5'}},
    {mcpl: {version: '0.5'}, [RECIPIENT_CAPABILITY]: {...recipientCapability('USELF'), contextOnly: false}},
    {mcpl: {version: '0.5'}, [RECIPIENT_CAPABILITY]: recipientCapability('UOTHER')}]) {
    const h = fixture(t);
    await assert.rejects(h.host.sendRequest(method.INITIALIZE, {capabilities: {experimental}}));
    await h.served;
    assert.equal(h.hostSaw.length, 0);
    assert.deepEqual(h.posts, []);
  }
});

for (const lane of ['push/event', 'channels/incoming'] as const) {
  advanced(`${lane}: actual connector envelopes preserve provenance and do not repin an active reply`, async t => {
    const h = fixture(t); await ready(h);
    if (lane === 'channels/incoming') await h.host.sendRequest(method.CHANNELS_OPEN, {channelId: 'slack:CWRITE'});
    const bridge = createRecipientHostBridge({serverId: 'test', ownUserId: 'USELF', accessPolicy: policy});
    await h.emit({thread_ts: '100.1'});
    const first = h.hostSaw.find(request => request.method === lane)!;
    const envelope = lane === 'push/event' ? (first.params as any).origin : (first.params as any).messages[0].metadata;
    const decision = bridge.accept(lane, {...envelope, serverId: 'test'});
    assert.equal(decision.triggerInference, true);
    assert.equal(envelope.authority, 'human-source');
    assert.equal(envelope.messageId, '100.2');
    await h.emit({ts: '200.2', thread_ts: '200.1', user: 'UPEER', bot_id: 'BPEER', text: 'ambient'});
    const deliveries = h.hostSaw.filter(request => request.method === lane);
    assert.equal(deliveries.length, 2);
    const ambient = lane === 'push/event' ? (deliveries[1].params as any).origin : (deliveries[1].params as any).messages[0].metadata;
    assert.deepEqual(bridge.accept(lane, {...ambient, serverId: 'test'}), {store: true, triggerInference: false});
    assert.equal(ambient.senderKind, 'bot');
    assert.equal(ambient.authority, 'peer-not-owner');
    assert.equal(h.reactions.length, 1);
    const result = await h.host.sendRequest(method.CHANNELS_PUBLISH, {...decision.recipientReply,
      content: [{type: 'text', text: 'answer'}]}) as any;
    assert.equal(result.delivered, true);
    assert.equal(h.posts[0].thread_ts, '100.1');
    await h.host.sendRequest(method.CHANNELS_PUBLISH, {channelId: 'slack:CWRITE', content: [{type: 'text', text: 'missing root'}]});
    assert.equal(h.posts.length, 1);
    await h.emit({ts: '200.2', thread_ts: '200.1', user: 'UPEER', bot_id: 'BPEER', text: 'ambient'});
    assert.equal(h.hostSaw.filter(request => request.method === lane).length, 2);
  });
}

advanced('frozen typing requires a root; delayed stop cannot clear a different turn; read-only effects stay denied', async t => {
  const h = fixture(t); await ready(h);
  h.host.sendNotification(method.CHANNELS_TYPING, {channelId: 'slack:CWRITE', op: 'start'});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(h.statuses.length, 0);
  const typing = (root: string, op: string) => h.host.sendNotification(method.CHANNELS_TYPING,
    {channelId: 'slack:CWRITE', op, metadata: {supportRecipientReplyRoot: root}});
  typing('100.1', 'start'); await until(() => h.statuses.length === 1, 'first status');
  typing('200.1', 'start'); await until(() => h.statuses.length === 3, 'second status');
  typing('100.1', 'stop'); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(h.statuses.length, 3);
  typing('200.1', 'stop'); await until(() => h.statuses.length === 4, 'same turn stop');
  assert.equal(h.statuses[3].thread_ts, '200.1');
  await h.emit({channel: 'CREAD', ts: '300.1'});
  const read = h.hostSaw.filter(request => request.method === method.PUSH_EVENT).at(-1) as any;
  assert.equal(read.params.origin.wakeAllowed, true);
  await assert.rejects(h.host.sendRequest(method.CHANNELS_PUBLISH, {channelId: 'slack:CREAD', threadId: '300.1',
    content: [{type: 'text', text: 'denied'}]}));
  assert.equal(h.posts.length, 0);
  h.revoke();
  await assert.rejects(h.host.sendRequest(method.CHANNELS_PUBLISH, {channelId: 'slack:CWRITE', threadId: '100.1',
    content: [{type: 'text', text: 'revoked'}]}));
});

advanced('disabled tools are hidden and direct invocation is denied; settings snapshot is stable', async t => {
  const h = fixture(t); await ready(h);
  const listed = await h.host.sendRequest('tools/list', {}) as any;
  assert.equal(listed.tools.some((tool: any) => tool.name === 'subscribe_channel'), false);
  const result = await h.host.sendRequest('tools/call', {name: 'subscribe_channel', arguments: {channelId: 'CWRITE'}}) as any;
  assert.equal(result.isError, true);
  assert.throws(() => h.slack.configureRecipientRouting({stateFile: '/irrelevant/db', namespace: 'other'}));
  assert.throws(() => new SlackMcplServer(h.slack, {disabledTools: ['misspelled']}));
});

advanced('Slack-shaped equal-root parents are accepted but a child cannot be used as the frozen root', async t => {
  const h = fixture(t); await ready(h);
  const publish = () => h.host.sendRequest(method.CHANNELS_PUBLISH, {channelId: 'slack:CWRITE', threadId: '100.1',
    content: [{type: 'text', text: 'answer'}]}) as Promise<any>;
  assert.equal((await publish()).delivered, true);
  h.useChildAsParent();
  assert.equal((await publish()).delivered, false);
  h.host.sendNotification(method.CHANNELS_TYPING, {channelId: 'slack:CWRITE', op: 'start',
    metadata: {supportRecipientReplyRoot: '100.1'}});
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(h.statuses.length, 0);
  assert.equal(h.posts.length, 1);
});

for (const interruption of ['policy-replaced', 'disconnected'] as const) {
  advanced(`delayed typing cannot survive ${interruption}`, async t => {
    const h = fixture(t); await ready(h);
    const blocked = h.holdReplies();
    h.host.sendNotification(method.CHANNELS_TYPING, {channelId: 'slack:CWRITE', op: 'start',
      metadata: {supportRecipientReplyRoot: '100.1'}});
    await until(blocked.pending, 'pending parent lookup');
    if (interruption === 'policy-replaced') {
      await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {effectiveCapabilities: []});
      // Even a restored grant is a new policy era, not permission to resume
      // effects abandoned by the previous one.
      await h.host.sendRequest(method.FEATURE_SETS_UPDATE, {effectiveCapabilities: [...FULL_GRANT, 'channels.typing']});
    } else await h.close();
    blocked.release();
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(h.statuses.length, 0);
  });
}
