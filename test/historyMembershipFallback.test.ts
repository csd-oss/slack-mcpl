import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter } from '../src/slack-adapter.js';
import { SlackAccessPolicy, HISTORY_MEMBERSHIP_PROOF } from '../src/access-policy.js';

const PIN = 'CPINNED', OWNER = 'UOWNER';
const scopes = ['channels:history', 'chat:write', 'im:read', 'im:history', 'im:write', 'users:read', 'reactions:write'];
function fixture(options: { scopes?: string[]; dmUsers?: string[]; fallback?: string[] } = {}) {
  const calls: Array<{ method: string; args: any }> = [];
  const granted = [...(options.scopes ?? scopes)];
  let history: any = { ok: true, messages: [] }, failure: Error | undefined;
  let info: any = { id: 'D1', is_im: true, user: OWNER };
  let listed: any[] = [];
  let handler: any;
  const record = (method: string, result = {}) => async (args: any) => { calls.push({ method, args }); return result; };
  const web = {
    conversations: {
      history: async (args: any) => { calls.push({ method: 'history', args }); if (failure) throw failure; return history; },
      info: async (args: any) => { calls.push({ method: 'info', args }); return { channel: info }; },
      list: async (args: any) => { calls.push({ method: 'list', args }); return { channels: listed }; },
      replies: record('replies', { messages: [] }), open: record('open', { channel: { id: 'D1' } }),
    },
    chat: { postMessage: record('post', { ts: '1.0' }), update: record('edit'), delete: record('delete') },
    reactions: { add: record('reaction'), remove: record('remove') },
    users: { info: record('userInfo', { user: { name: 'owner' } }), list: record('users', { members: [{ id: OWNER, name: 'owner' }] }) },
    files: { info: record('fileInfo', { file: { id: 'F1' } }), delete: record('fileDelete') },
    filesUploadV2: record('upload', { files: [{ files: [{ id: 'F1' }] }] }),
    assistant: { threads: { setStatus: record('status') } },
  } as any;
  const adapter = new SlackAdapter(web, { on(_event, callback) { handler = callback; }, async start() {}, async disconnect() {} }, 'UBOT', 'workspace', undefined, undefined, false, 'eyes', granted);
  adapter.configureAccessPolicy({ writeChannels: [PIN], dmUsers: options.dmUsers ?? [], readJoinedChannels: true,
    historyMembershipFallbackChannels: options.fallback ?? [PIN] });
  return { adapter, calls, granted,
    fail(error?: Error) { failure = error; }, history(value: any) { history = value; }, info(value: any) { info = value; }, list(value: any[]) { listed = value; },
    async emit() { handler({ event: { type: 'message', channel: PIN, channel_type: 'channel', user: OWNER, ts: '1.0', text: '<@UBOT> hi' }, ack: async () => {} }); await new Promise((resolve) => setTimeout(resolve, 0)); },
  };
}

test('pinned metadata and writes use fresh bot history without info or listing scope calls', async () => {
  const h = fixture();
  assert.deepEqual(await h.adapter.getConversationMeta(PIN), { id: PIN, kind: 'channel', name: PIN, topic: undefined, isMember: true, numMembers: undefined });
  await h.adapter.sendMessage(PIN, 'hello');
  await h.adapter.editMessage(PIN, '1.0', 'edit');
  await h.adapter.deleteMessage(PIN, '1.0');
  await h.adapter.addReaction(PIN, '1.0', 'eyes');
  assert.equal(h.adapter.canWrite(PIN), true);
  assert.equal(h.calls.filter((call) => call.method === 'history').length, 5);
  assert.ok(h.calls.filter((call) => call.method === 'history').every((call) => call.args.channel === PIN && call.args.limit === 1));
  assert.equal(h.calls.filter((call) => ['info', 'list'].includes(call.method)).length, 0);
  assert.deepEqual(h.granted, scopes);
  assert.equal((h.adapter as any).scopes.includes('channels:read'), false);
});

test('only pinned metadata is listed when no metadata listing scopes are available', async () => {
  const h = fixture({ scopes: ['channels:history', 'chat:write'] });
  assert.deepEqual((await h.adapter.listConversations(true)).map((item) => item.id), [PIN]);
  assert.deepEqual(h.calls.map((call) => call.method), ['history']);
});

test('allowed DM listing remains separate and never requests public/private types without their scopes', async () => {
  const h = fixture({ dmUsers: [OWNER] }); h.list([{ id: 'D1', is_im: true, user: OWNER }]);
  assert.deepEqual((await h.adapter.listConversations(true)).map((item) => item.id), [PIN, 'D1']);
  assert.equal(h.calls.find((call) => call.method === 'list')?.args.types, 'im');
  await h.adapter.sendDM(OWNER, 'hello');
  assert.equal(h.calls.filter((call) => call.method === 'open').length, 1);
});

for (const error of ['not_in_channel', 'missing_scope', 'ratelimited', 'network failure']) {
  test(`fresh membership refusal fails future reads and writes closed: ${error}`, async () => {
    const h = fixture(); await h.adapter.sendMessage(PIN, 'before removal');
    h.fail(new Error(error));
    await assert.rejects(h.adapter.requireReadableConversation(PIN), new RegExp(error));
    await assert.rejects(h.adapter.sendMessage(PIN, 'after removal'), new RegExp(error));
    assert.equal(h.calls.filter((call) => call.method === 'post').length, 1);
    assert.equal(h.calls.filter((call) => call.method === 'info').length, 0);
  });
}

for (const response of [{}, { ok: false, messages: [] }, { ok: 'true', messages: [] }, { ok: null }]) {
  test(`malformed or unsuccessful history is never membership proof: ${JSON.stringify(response)}`, async () => {
    const h = fixture(); h.history(response);
    await assert.rejects(h.adapter.sendMessage(PIN, 'hello'), /freshly confirm/);
    assert.equal(h.calls.filter((call) => call.method === 'post').length, 0);
  });
}

test('affirmative history success proves membership without inspecting message content', async () => {
  const h = fixture(); h.history({ ok: true });
  await h.adapter.requireReadableConversation(PIN);
  assert.deepEqual(h.calls.map((call) => call.method), ['history']);
});

test('other public IDs, private channels and DMs cannot borrow the pinned proof', async () => {
  const h = fixture();
  for (const id of ['COTHER', 'GPRIVATE', 'D1']) {
    h.info({ id, is_im: id === 'D1', is_mpim: false, is_private: id === 'GPRIVATE', is_member: true, user: 'UOTHER' });
    await assert.rejects(h.adapter.requireReadableConversation(id));
  }
  assert.equal(h.calls.filter((call) => call.method === 'history').length, 0);
});

test('fallback configuration is restricted to explicit public write pins', () => {
  for (const fallback of [['COTHER'], ['GPRIVATE'], ['D1'], ['UOWNER']]) {
    assert.throws(() => new SlackAccessPolicy({ writeChannels: [PIN, 'GPRIVATE'], dmUsers: [], readJoinedChannels: true, historyMembershipFallbackChannels: fallback }), /pinned public write channels/);
  }
});

test('JSON cannot forge proof and private/DM metadata cannot use the symbol', () => {
  const policy = new SlackAccessPolicy({ writeChannels: [PIN], dmUsers: [], readJoinedChannels: true, historyMembershipFallbackChannels: [PIN] });
  const proven = { id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: true, [HISTORY_MEMBERSHIP_PROOF]: true as const };
  assert.equal(policy.requireReadable(PIN, proven, scopes), 'channel');
  const json = JSON.parse(JSON.stringify({ ...proven, HISTORY_MEMBERSHIP_PROOF: true, 'Slack bot history membership': true }));
  assert.throws(() => policy.requireReadable(PIN, json, scopes), /channels:read/);
  assert.throws(() => policy.requireReadable(PIN, { ...proven, is_private: true }, scopes), /groups:read/);
  assert.throws(() => policy.requireReadable('D1', { ...proven, id: 'D1', is_im: true, user: 'UOTHER' }, scopes), /not allowed/);
});

test('normal metadata scope path never uses fallback, even after info refusal', async () => {
  const h = fixture({ scopes: [...scopes, 'channels:read'] });
  h.info({ id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: true });
  await h.adapter.sendMessage(PIN, 'hello');
  h.info({ id: PIN, is_im: false, is_mpim: false, is_private: false, is_member: false });
  await assert.rejects(h.adapter.sendMessage(PIN, 'no longer a member'), /not a confirmed joined/);
  assert.equal(h.calls.filter((call) => call.method === 'history').length, 0);
});

test('fallback needs channels:history and does not invent file or directory scopes', async () => {
  const h = fixture({ scopes: ['chat:write'] });
  await assert.rejects(h.adapter.requireReadableConversation(PIN), /channels:history/);
  await assert.rejects(h.adapter.getFileInfo('F1'), /files:read/);
  await assert.rejects(h.adapter.findUsers('owner'), /users:read/);
  assert.equal(h.calls.length, 0);
  const readable = fixture();
  await assert.rejects(readable.adapter.uploadFile(PIN, { filename: 'x', data: Buffer.from('x') }), /files:write/);
  await assert.rejects(readable.adapter.deleteUploadedFile(PIN, 'F1'), /files:write/);
  assert.equal(readable.calls.filter((call) => ['upload', 'fileDelete'].includes(call.method)).length, 0);
  assert.deepEqual((await readable.adapter.findUsers('owner')).map((user) => user.userId), [OWNER]);
});

test('incoming, ACK and status also recheck the pinned membership proof', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = fixture(); let received = 0; h.adapter.onMessage(() => received++);
  await h.emit(); await h.adapter.acknowledge(PIN, '1.0'); await h.adapter.setThreadStatus(PIN, '1.0');
  assert.equal(received, 1);
  h.fail(new Error('not_in_channel'));
  await h.emit(); await h.adapter.acknowledge(PIN, '2.0'); await h.adapter.clearAck(PIN); await h.adapter.setThreadStatus(PIN, '2.0');
  assert.equal(received, 1);
  assert.equal(h.calls.filter((call) => call.method === 'reaction').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'status').length, 1);
  assert.equal(h.calls.filter((call) => call.method === 'remove').length, 0);
  await h.adapter.stop();
});
