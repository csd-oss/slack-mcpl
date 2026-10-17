import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter } from '../src/slack-adapter.js';

const SCOPES = ['channels:read', 'groups:read', 'im:read', 'channels:history', 'groups:history', 'im:history',
  'chat:write', 'im:write', 'reactions:write', 'files:read', 'files:write', 'users:read'];
const channel = (id: string, member = true, privateChannel = false) => ({ id, name: id, is_im: false, is_mpim: false, is_private: privateChannel, is_member: member });
const dm = (user = 'UALLOWED') => ({ id: 'D1', is_im: true, is_mpim: false, user });

function fixture(opts: { dmUsers?: string[]; scopes?: string[] | null; ack?: string; legacy?: boolean } = {}) {
  const calls: Array<{ method: string; args: any }> = [];
  const conversations = new Map<string, any>([['CWRITE', channel('CWRITE')], ['CREAD', channel('CREAD')], ['COUT', channel('COUT', false)], ['GPRIVATE', channel('GPRIVATE', true, true)], ['D1', dm()]]);
  let listed: any[] = [...conversations.values()];
  let file: Record<string, unknown> | undefined = { id: 'F1', channels: ['CREAD'] };
  let opened = 'D1';
  let handler: any;
  const record = (method: string, result: any = {}) => async (args: any) => { calls.push({ method, args }); return result; };
  const web = {
    conversations: {
      list: async (args: any) => { calls.push({ method: 'list', args }); return { channels: listed }; },
      info: async (args: any) => { calls.push({ method: 'info', args }); return { channel: conversations.get(args.channel) }; },
      open: async (args: any) => { calls.push({ method: 'open', args }); return { channel: { id: opened } }; },
      history: record('history', { messages: [] }), replies: record('replies', { messages: [] }),
    },
    chat: { postMessage: record('post', { ts: '1.0' }), update: record('edit'), delete: record('delete') },
    reactions: { add: record('react'), remove: record('unreact') },
    filesUploadV2: record('upload', { files: [{ files: [{ id: 'F1' }] }] }),
    files: { delete: record('fileDelete'), info: async (args: any) => { calls.push({ method: 'fileInfo', args }); return { file }; } },
    assistant: { threads: { setStatus: record('status') } },
    users: { info: record('userInfo', { user: { name: 'peer' } }), list: record('users', { members: [{ id: 'UELSEWHERE', name: 'someone' }] }) },
  } as any;
  const socket = { on(_name: string, callback: any) { handler = callback; }, async start() {}, async disconnect() {} };
  const scopes = opts.scopes === null ? undefined : opts.scopes ?? SCOPES;
  const adapter = new SlackAdapter(web, socket, 'UBOT', 'workspace', undefined, undefined, false, opts.ack, scopes);
  if (!opts.legacy) adapter.configureAccessPolicy({ writeChannels: ['CWRITE'], dmUsers: opts.dmUsers ?? [], readJoinedChannels: true });
  return {
    adapter, calls, conversations,
    setListed(value: any[]) { listed = value; }, setFile(value: Record<string, unknown> | undefined) { file = value; },
    setOpened(value: string) { opened = value; },
    async emit(event: any) { handler({ event, ack: async () => {} }); await new Promise((resolve) => setTimeout(resolve, 0)); },
  };
}

test('joined public/private channels are readable, but unjoined public channels are not', async () => {
  const h = fixture();
  await h.adapter.fetchHistory('CREAD');
  await h.adapter.fetchThread('GPRIVATE', '1.0');
  await assert.rejects(h.adapter.fetchHistory('COUT'), /not a confirmed joined channel/);
  assert.deepEqual(h.calls.filter((c) => ['history', 'replies'].includes(c.method)).map((c) => c.args.channel), ['CREAD', 'GPRIVATE']);
});

test('listing never exposes unjoined channels or denied DMs even with includeNonMember', async () => {
  const h = fixture();
  h.conversations.set('GDM', { id: 'GDM', is_im: false, is_mpim: true, is_member: true });
  h.setListed([...h.conversations.values()]);
  const result = await h.adapter.listConversations(true);
  assert.deepEqual(result.map((c) => c.id), ['CWRITE', 'CREAD', 'GPRIVATE']);
  assert.equal(h.calls.find((c) => c.method === 'list')?.args.types, 'public_channel,private_channel');
});

test('listing revalidates membership and describes fresh info rather than stale list metadata', async () => {
  const h = fixture();
  h.setListed([channel('CREAD'), channel('COUT', true)]);
  h.conversations.set('CREAD', { ...channel('CREAD'), name: 'fresh' });
  assert.deepEqual((await h.adapter.listConversations(true)).map((c) => [c.id, c.name]), [['CREAD', 'fresh']]);
});

test('membership revocation invalidates prior metadata and reads immediately', async () => {
  const h = fixture();
  await h.adapter.getConversationMeta('CREAD');
  await h.adapter.fetchHistory('CREAD');
  h.conversations.set('CREAD', channel('CREAD', false));
  await assert.rejects(h.adapter.fetchThread('CREAD', '1.0'), /not a confirmed joined channel/);
  assert.equal(h.calls.filter((c) => c.method === 'replies').length, 0);
  assert.equal(h.calls.filter((c) => c.method === 'info').length, 3);
});

const writes = [
  ['send', (a: SlackAdapter, id: string) => a.sendMessage(id, 'hello')],
  ['edit', (a: SlackAdapter, id: string) => a.editMessage(id, '1.0', 'hello')],
  ['delete', (a: SlackAdapter, id: string) => a.deleteMessage(id, '1.0')],
  ['reaction', (a: SlackAdapter, id: string) => a.addReaction(id, '1.0', 'eyes')],
  ['upload', (a: SlackAdapter, id: string) => a.uploadFile(id, { filename: 'test.txt', data: Buffer.from('hello') })],
  ['file rollback', (a: SlackAdapter, id: string) => a.deleteUploadedFile(id, 'F1')],
] as const;
for (const [name, write] of writes) {
  test(`${name} rechecks joined membership and limits writes to configured channel`, async () => {
    const h = fixture();
    await assert.rejects(write(h.adapter, 'CREAD'), /not allowed/);
    await assert.rejects(write(h.adapter, 'COUT'), /not a confirmed joined channel/);
    await write(h.adapter, 'CWRITE');
    h.conversations.set('CWRITE', channel('CWRITE', false));
    await assert.rejects(write(h.adapter, 'CWRITE'), /not a confirmed joined channel/);
    assert.equal(h.calls.filter((c) => !['info', 'userInfo'].includes(c.method)).length, 1);
  });
}

test('status and acknowledgement effects are refused in read-only channels and after revocation', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = fixture({ ack: 'eyes' });
  await h.adapter.setThreadStatus('CREAD', '1.0');
  await h.adapter.acknowledge('CREAD', '1.0');
  await h.adapter.acknowledge('CWRITE', '1.0');
  h.conversations.set('CWRITE', channel('CWRITE', false));
  await h.adapter.clearAck('CWRITE');
  await h.adapter.setThreadStatus('CWRITE', '2.0');
  assert.deepEqual(h.calls.filter((c) => ['status', 'react', 'unreact'].includes(c.method)).map((c) => c.method), ['react']);
  await h.adapter.stop();
});

for (const metadata of [undefined, { id: 'COTHER' }, { ...channel('CREAD'), is_im: undefined }, { ...channel('CREAD'), is_mpim: undefined }, { ...channel('CREAD'), is_private: undefined }, { ...channel('CREAD'), is_member: undefined }]) {
  test(`missing or ambiguous membership metadata fails closed: ${JSON.stringify(metadata)}`, async () => {
    const h = fixture(); h.conversations.set('CREAD', metadata);
    await assert.rejects(h.adapter.fetchHistory('CREAD'));
    assert.equal(h.calls.filter((c) => c.method === 'history').length, 0);
  });
}

test('unknown scopes and missing per-operation scopes fail closed', async () => {
  const unknown = fixture({ scopes: null });
  assert.deepEqual(await unknown.adapter.listConversations(true), []);
  await assert.rejects(unknown.adapter.fetchHistory('CREAD'), /scope metadata/);
  assert.equal(unknown.calls.length, 0);
  const readOnlyScope = fixture({ scopes: ['channels:read'] });
  await readOnlyScope.adapter.requireReadableConversation('CREAD');
  await assert.rejects(readOnlyScope.adapter.fetchHistory('CREAD'), /channels:history/);
  await assert.rejects(readOnlyScope.adapter.sendMessage('CWRITE', 'hello'), /chat:write/);
  await assert.rejects(readOnlyScope.adapter.fetchHistory('GPRIVATE'), /groups:read/);
  assert.equal(readOnlyScope.calls.filter((c) => ['history', 'post'].includes(c.method)).length, 0);
});

test('empty DM allowlist denies reads, writes and DM opening', async () => {
  const h = fixture();
  assert.equal(h.adapter.dmsWritable, false); assert.equal(h.adapter.dmsDisabled, true);
  await assert.rejects(h.adapter.fetchHistory('D1'), /not allowed/);
  await assert.rejects(h.adapter.sendMessage('D1', 'hello'), /not allowed/);
  await assert.rejects(h.adapter.sendDM('UALLOWED', 'hello'), /not allowed/);
  assert.equal(h.calls.filter((c) => ['open', 'history', 'post'].includes(c.method)).length, 0);
});

test('an allowlisted one-to-one peer can be read and written, while wrong peers are denied before open', async () => {
  const h = fixture({ dmUsers: ['UALLOWED'] });
  assert.equal(h.adapter.dmsWritable, true);
  await h.adapter.fetchHistory('D1');
  await h.adapter.sendDM('UALLOWED', 'hello');
  await assert.rejects(h.adapter.sendDM('UOTHER', 'hello'), /not allowed/);
  assert.equal(h.calls.filter((c) => c.method === 'open').length, 1);
  h.conversations.set('D1', dm('UOTHER'));
  await assert.rejects(h.adapter.fetchHistory('D1'), /not allowed/);
  await assert.rejects(h.adapter.sendMessage('D1', 'hello'), /not allowed/);
});

test('opened DM must name the requested peer, not another allowed peer', async () => {
  const h = fixture({ dmUsers: ['UALLOWED', 'UOTHER'] });
  h.conversations.set('D1', dm('UOTHER'));
  await assert.rejects(h.adapter.sendDM('UALLOWED', 'hello'), /does not match/);
  assert.equal(h.calls.filter((c) => c.method === 'post').length, 0);
});

test('missing DM counterpart and group DMs fail closed', async () => {
  const h = fixture({ dmUsers: ['UALLOWED'] });
  h.conversations.set('D1', { ...dm(), user: undefined });
  await assert.rejects(h.adapter.fetchHistory('D1'), /invalid DM metadata/);
  h.conversations.set('GDM', { id: 'GDM', is_im: false, is_mpim: true, is_member: true });
  await assert.rejects(h.adapter.fetchHistory('GDM'), /unsupported/);
  await assert.rejects(h.adapter.sendMessage('GDM', 'hello'), /unsupported/);
});

test('explicit one-to-one metadata does not require unrelated channel fields', async () => {
  const h = fixture({ dmUsers: ['UALLOWED'] });
  h.conversations.set('D1', { id: 'D1', is_im: true, user: 'UALLOWED' });
  await h.adapter.fetchHistory('D1');
  await h.adapter.sendDM('UALLOWED', 'hello');
});

test('missing reaction, upload, deletion and DM-opening scopes prevent their effects', async () => {
  const h = fixture({ scopes: ['channels:read', 'im:read'], dmUsers: ['UALLOWED'] });
  await assert.rejects(h.adapter.addReaction('CWRITE', '1.0', 'eyes'), /reactions:write/);
  await assert.rejects(h.adapter.uploadFile('CWRITE', { filename: 'x', data: Buffer.from('x') }), /files:write/);
  await assert.rejects(h.adapter.deleteUploadedFile('CWRITE', 'F1'), /files:write/);
  await assert.rejects(h.adapter.sendDM('UALLOWED', 'hello'), /im:write/);
  assert.equal(h.calls.filter((c) => c.method !== 'info').length, 0);
});

test('incoming one-to-one sender must match the authorized counterpart', async () => {
  const h = fixture({ dmUsers: ['UALLOWED'] }); const received: string[] = [];
  h.adapter.onMessage((message) => received.push(message.authorId));
  await h.emit({ type: 'message', channel: 'D1', channel_type: 'im', user: 'UOTHER', ts: '1.0', text: 'hello' });
  await h.emit({ type: 'message', channel: 'D1', channel_type: 'im', user: 'UALLOWED', ts: '2.0', text: 'hello' });
  assert.deepEqual(received, ['UALLOWED']);
});

test('incoming events revalidate membership before resolving senders or delivery', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = fixture(); const received: string[] = [];
  h.adapter.onMessage((message) => received.push(message.channelId));
  const event = { type: 'message', channel: 'CREAD', channel_type: 'channel', user: 'UHUMAN', ts: '1.0', text: 'hello' };
  await h.emit(event);
  h.conversations.set('CREAD', channel('CREAD', false));
  await h.emit({ ...event, ts: '2.0' });
  await h.emit({ ...event, channel: 'D1', channel_type: 'im', ts: '3.0' });
  assert.deepEqual(received, ['CREAD']);
});

test('directory discovery is global metadata-only and requires users:read', async () => {
  const h = fixture();
  assert.deepEqual((await h.adapter.findUsers('someone')).map((u) => u.userId), ['UELSEWHERE']);
  assert.deepEqual(h.calls.map((c) => c.method), ['users']);
  const denied = fixture({ scopes: ['channels:read'] });
  await assert.rejects(denied.adapter.findUsers('someone'), /users:read/);
  assert.equal(denied.calls.length, 0);
});

test('file metadata requires scope, exact file identity and available API', async () => {
  const h = fixture();
  assert.deepEqual(await h.adapter.getFileInfo('F1'), { id: 'F1', channels: ['CREAD'] });
  h.setFile({ id: 'FOTHER' }); await assert.rejects(h.adapter.getFileInfo('F1'), /mismatched/);
  h.setFile(undefined); await assert.rejects(h.adapter.getFileInfo('F1'), /missing/);
  const denied = fixture({ scopes: ['channels:read'] });
  await assert.rejects(denied.adapter.getFileInfo('F1'), /files:read/);
  assert.equal(denied.calls.length, 0);
});

test('policy is opt-in, copied at configuration and immutable after start', async () => {
  const h = fixture({ legacy: true });
  assert.equal(h.adapter.hasExplicitAccessPolicy, false);
  await h.adapter.fetchHistory('COUT'); // unchanged legacy behavior
  const config = { writeChannels: ['CWRITE'], dmUsers: [] as string[], readJoinedChannels: true };
  h.adapter.configureAccessPolicy(config);
  assert.equal(h.adapter.hasExplicitAccessPolicy, true);
  config.writeChannels.push('CREAD'); config.dmUsers.push('UALLOWED');
  await assert.rejects(h.adapter.sendMessage('CREAD', 'hello'), /not allowed/);
  await assert.rejects(h.adapter.sendDM('UALLOWED', 'hello'), /not allowed/);
  await h.adapter.start();
  assert.throws(() => h.adapter.configureAccessPolicy(config), /once before start/);
});
