import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
  createRecipientHostBridge, freezeRecipientReply, recipientCapability,
  recipientPublishParams, recipientTypingMetadata, requireRecipientCapability,
} from '../src/host-compatibility.js';

const policy = {readJoinedChannels: true, writeChannels: ['CWRITE'], dmUsers: ['UOWNER']};
function metadata(patch: Record<string, unknown> = {}) {
  return {serverId: 'chat-connector', channelId: 'slack:CWRITE', messageId: '100.2', botUserId: 'USELF', routingVersion: 1,
    wakeAllowed: true, replyRoot: '100.1', mentionIds: ['USELF'], senderKind: 'human', isBot: false,
    authorId: 'UPERSON', authority: 'human-source', isDM: false, routingReason: 'human-mention',
    supportAccess: {version: 1, channelId: 'CWRITE', kind: 'channel', readable: true, joined: true}, ...patch};
}
const bridge = () => createRecipientHostBridge({serverId: 'chat-connector', ownUserId: 'USELF', accessPolicy: policy});

test('recipient extension requires the complete same-identity host promise', () => {
  const full = recipientCapability('USELF');
  assert.deepEqual(requireRecipientCapability(full, 'USELF'), full);
  for (const value of [undefined, {}, {...full, botUserId: 'UOTHER'}, {...full, version: 2},
    {...full, contextOnly: false}, {...full, frozenReply: false}, {...full, frozenStatus: false}, {...full, provenance: false}]) {
    assert.throws(() => requireRecipientCapability(value, 'USELF'));
  }
});

for (const lane of ['channels/incoming', 'push/event'] as const) {
  test(`${lane}: independently admits addressed events and stores ambient context without a turn`, () => {
    const host = bridge();
    assert.deepEqual(host.accept(lane, metadata()), {store: true, triggerInference: true,
      recipientReply: {channelId: 'slack:CWRITE', threadId: '100.1'}});
    const ambient = metadata({mentionIds: ['UOTHER'], wakeAllowed: false, routingReason: 'context-only'});
    assert.deepEqual(host.accept(lane, ambient), {store: true, triggerInference: false});
    for (const senderKind of ['bot', 'unknown']) {
      assert.equal(host.accept(lane, metadata({senderKind, isBot: true, routingReason: 'peer-mention',
        authority: 'peer-not-owner'})).triggerInference, true);
    }
  });

  test(`${lane}: fabricated authority, mismatched admission and conflicting wake decisions fail closed`, () => {
    const host = bridge();
    const patches = [
      {serverId: 'other'}, {botUserId: 'UOTHER'}, {routingVersion: 2}, {supportAccess: undefined},
      {supportAccess: {version: 1, channelId: 'COTHER', readable: true, kind: 'channel', joined: true}},
      {supportAccess: {version: 1, channelId: 'CWRITE', readable: true, kind: 'channel', joined: false}},
      {replyRoot: 'bad'}, {messageId: undefined}, {authorId: 'USELF'}, {authorId: undefined}, {isBot: true},
      {senderKind: 'owner'}, {authority: 'owner'}, {wakeAllowed: false}, {mentionIds: []},
      {isDM: true}, {routingReason: 'context-only'},
    ];
    for (const patch of patches) assert.deepEqual(host.accept(lane, metadata(patch)),
      {store: false, triggerInference: false}, JSON.stringify(patch));
    assert.deepEqual(host.accept(lane, null as any), {store: false, triggerInference: false});
  });

  test(`${lane}: human DM address is a verified counterpart signal, not a synthetic mention`, () => {
    const dm = metadata({channelId: 'DPEER', isDM: true, mentionIds: [], authorId: 'UOWNER',
      dmAuthorizedPeer: 'UOWNER', routingReason: 'authorized-human-dm',
      supportAccess: {version: 1, channelId: 'DPEER', kind: 'dm', readable: true, dmPeer: 'UOWNER'}});
    assert.equal(bridge().accept(lane, dm).triggerInference, true);
    // Read admission is identity-based. Only a verified human counterpart
    // supplies an independent DM wake signal; a bot peer can be context only.
    assert.deepEqual(bridge().accept(lane, {...dm, senderKind: 'bot', isBot: true, authority: 'peer-not-owner',
      wakeAllowed: false, routingReason: 'context-only', dmAuthorizedPeer: undefined}), {store: true, triggerInference: false});
    for (const patch of [{authorId: 'UOTHER'}, {dmAuthorizedPeer: 'UOTHER'}, {senderKind: 'bot', isBot: true},
      {supportAccess: {...dm.supportAccess, dmPeer: 'UOTHER'}}]) {
      assert.equal(bridge().accept(lane, {...dm, ...patch}).triggerInference, false);
    }
  });
}

test('host bridge snapshots policy and does not widen after caller mutation', () => {
  const mutable = {readJoinedChannels: false, writeChannels: ['CWRITE'], dmUsers: [] as string[]};
  const host = createRecipientHostBridge({serverId: 'chat-connector', ownUserId: 'USELF', accessPolicy: mutable});
  mutable.readJoinedChannels = true;
  mutable.dmUsers.push('UOWNER');
  assert.equal(host.accept('push/event', metadata()).store, false);
  assert.equal(host.accept('push/event', metadata({channelId: 'DPEER', isDM: true, mentionIds: [],
    authorId: 'UOWNER', dmAuthorizedPeer: 'UOWNER', routingReason: 'authorized-human-dm',
    supportAccess: {version: 1, channelId: 'DPEER', kind: 'dm', readable: true, dmPeer: 'UOWNER'}})).store, false);
});

test('example host lifecycle keeps a frozen turn target through tools, queues, retries and budget restarts', () => {
  const host = bridge();
  const stored: Record<string, unknown>[] = [];
  const scheduled: ReturnType<typeof freezeRecipientReply>[] = [];
  // These are the host hooks an embedding must implement. Merely accepting
  // metadata or setting environment markers does not install them.
  const ingest = (event: Record<string, unknown>) => {
    const decision = host.accept('push/event', event);
    if (decision.store) stored.push(event);
    if (decision.triggerInference) scheduled.push(decision.recipientReply!);
  };
  ingest(metadata());
  const active = {recipientReply: scheduled.shift()!, replySuppressed: true};
  ingest(metadata({replyRoot: '999.9', mentionIds: [], wakeAllowed: false, routingReason: 'context-only'}));
  assert.equal(stored.length, 2);
  assert.equal(scheduled.length, 0);
  assert.equal(active.replySuppressed, true);
  const toolContinuation = {...active};
  const queued = JSON.parse(JSON.stringify(toolContinuation));
  const budgetRestart = {...queued, recipientReply: freezeRecipientReply(queued.recipientReply)};
  const retry = {...budgetRestart};
  assert.deepEqual(recipientPublishParams(retry.recipientReply), {channelId: 'slack:CWRITE', threadId: '100.1'});
  assert.deepEqual(recipientTypingMetadata(retry.recipientReply), {supportRecipientReplyRoot: '100.1'});
  assert.ok(Object.isFrozen(retry.recipientReply));
  assert.throws(() => freezeRecipientReply({channelId: 'CWRITE', threadId: '100.1'}));
  assert.throws(() => freezeRecipientReply({channelId: 'slack:CWRITE', threadId: undefined}));
});
