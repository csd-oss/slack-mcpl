import test from 'node:test';
import assert from 'node:assert/strict';
import { SlackAdapter } from '../src/slack-adapter.js';
import { uploadEndpoint } from './harness.js';
import { associatedFileUrl } from '../src/file-access.js';
import { SlackAccessPolicy } from '../src/access-policy.js';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCOPES = ['channels:read', 'groups:read', 'im:read', 'channels:history', 'groups:history', 'im:history',
  'chat:write', 'im:write', 'reactions:write', 'files:read', 'files:write', 'users:read'];
const channel = (id: string, member = true, privateChannel = false) => ({ id, name: id, is_im: false, is_mpim: false, is_private: privateChannel, is_member: member });
const dm = (user = 'UALLOWED') => ({ id: 'D1', is_im: true, is_mpim: false, user });
const groupDm = (id: string, member = true) => ({ id, name: `mpdm-${id}`, is_im: false, is_mpim: true, is_private: true, is_member: member });
const MPIM_SCOPES = [...SCOPES, 'mpim:read', 'mpim:history'];

function fixture(opts: { dmUsers?: string[]; scopes?: string[] | null; ack?: string; legacy?: boolean; groupDms?: string[]; writeChannels?: string[] } = {}) {
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
    files: {
      getUploadURLExternal: async (args: any) => { calls.push({ method: 'upload', args }); return { upload_url: `${(await uploadEndpoint()).url}/F1`, file_id: 'F1' }; },
      completeUploadExternal: async () => ({ files: [{ id: 'F1' }] }),
      delete: record('fileDelete'), info: async (args: any) => { calls.push({ method: 'fileInfo', args }); return { file }; } },
    assistant: { threads: { setStatus: record('status') } },
    users: { info: record('userInfo', { user: { name: 'peer' } }), list: record('users', { members: [{ id: 'UELSEWHERE', name: 'someone' }] }) },
  } as any;
  const socket = { on(_name: string, callback: any) { handler = callback; }, async start() {}, async disconnect() {} };
  const scopes = opts.scopes === null ? undefined : opts.scopes ?? SCOPES;
  const adapter = new SlackAdapter(web, socket, 'UBOT', 'workspace', undefined, undefined, false, opts.ack, scopes);
  if (!opts.legacy) adapter.configureAccessPolicy({ writeChannels: opts.writeChannels ?? ['CWRITE'], dmUsers: opts.dmUsers ?? [], readJoinedChannels: true,
    ...(opts.groupDms ? { groupDms: opts.groupDms } : {}) });
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
  await h.adapter.readThread('GPRIVATE', '1.0', {});
  await assert.rejects(h.adapter.fetchHistory('COUT'), /not a confirmed joined channel/);
  assert.deepEqual(h.calls.filter((c) => ['history', 'replies'].includes(c.method)).map((c) => c.args.channel), ['CREAD', 'GPRIVATE']);
});

test('listing never exposes unjoined channels or denied DMs even with includeNonMember', async () => {
  const h = fixture();
  h.conversations.set('GDM', { id: 'GDM', is_im: false, is_mpim: true, is_member: true });
  h.setListed([...h.conversations.values()]);
  const result = await h.adapter.listConversations(true);
  assert.deepEqual(result.conversations.map((c) => c.id), ['CWRITE', 'CREAD', 'GPRIVATE']);
  assert.equal(h.calls.find((c) => c.method === 'list')?.args.types, 'public_channel,private_channel');
});

test('listing checks afresh only the channels the list says the bot is in', async () => {
  const h = fixture();
  const others = Array.from({ length: 200 }, (_, i) => channel(`CPUB${i}`, false));
  h.setListed([...others, channel('CWRITE'), channel('CREAD')]);
  const result = await h.adapter.listConversations();
  assert.deepEqual(result.conversations.map((c) => c.id), ['CWRITE', 'CREAD']);
  assert.deepEqual(h.calls.filter((c) => c.method === 'info').map((c) => c.args.channel), ['CWRITE', 'CREAD']);
});

test('listing revalidates membership and describes fresh info rather than stale list metadata', async () => {
  const h = fixture();
  h.setListed([channel('CREAD'), channel('COUT', true)]);
  h.conversations.set('CREAD', { ...channel('CREAD'), name: 'fresh' });
  assert.deepEqual((await h.adapter.listConversations(true)).conversations.map((c) => [c.id, c.name]), [['CREAD', 'fresh']]);
});

test('membership revocation invalidates prior metadata and reads immediately', async () => {
  const h = fixture();
  await h.adapter.getConversationMeta('CREAD');
  await h.adapter.fetchHistory('CREAD');
  h.conversations.set('CREAD', channel('CREAD', false));
  await assert.rejects(h.adapter.readThread('CREAD', '1.0', {}), /not a confirmed joined channel/);
  assert.equal(h.calls.filter((c) => c.method === 'replies').length, 0);
  assert.equal(h.calls.filter((c) => c.method === 'info').length, 3);
});

const writes = [
  ['send', (a: SlackAdapter, id: string) => a.sendMessage(id, 'hello')],
  ['edit', (a: SlackAdapter, id: string) => a.editMessage(id, '1.0', 'hello')],
  ['delete', (a: SlackAdapter, id: string) => a.deleteMessage(id, '1.0')],
  ['reaction', (a: SlackAdapter, id: string) => a.addReaction(id, '1.0', 'eyes')],
  ['upload', (a: SlackAdapter, id: string) => a.uploadFile(id, { filename: 'test.txt', data: Buffer.from('hello') })],
  ['file rollback', (a: SlackAdapter, id: string) => a.deleteFile(id, 'F1')],
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
  assert.deepEqual((await unknown.adapter.listConversations(true)).conversations, []);
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
  await assert.rejects(h.adapter.deleteFile('CWRITE', 'F1'), /files:write/);
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

// ── Group DMs (groupDms) ──

/** CGROUP is an allowed, joined group DM; COTHERGROUP is joined but not allowed. */
function groupFixture(opts: { scopes?: string[]; writable?: boolean } = {}) {
  const h = fixture({ groupDms: ['CGROUP'], scopes: opts.scopes ?? MPIM_SCOPES,
    writeChannels: opts.writable ? ['CWRITE', 'CGROUP'] : ['CWRITE'] });
  h.conversations.set('CGROUP', groupDm('CGROUP'));
  h.conversations.set('COTHERGROUP', groupDm('COTHERGROUP'));
  return h;
}

test('group DM lists are validated like the other policy lists', () => {
  const base = { writeChannels: [], dmUsers: [], readJoinedChannels: true };
  for (const groupDms of [['D1'], ['UPEER'], ['cgroup'], [''], [7], 'CGROUP']) {
    assert.throws(() => new SlackAccessPolicy({ ...base, groupDms } as any), /Group DMs/);
  }
  new SlackAccessPolicy({ ...base, groupDms: [] });
  new SlackAccessPolicy({ ...base, groupDms: ['CGROUPDM', 'GLEGACY'] });
});

test('a joined group DM named in groupDms is readable with mpim:read and mpim:history', async () => {
  const h = groupFixture();
  await h.adapter.fetchHistory('CGROUP');
  await h.adapter.readThread('CGROUP', '1.0', {});
  assert.equal((await h.adapter.getConversationMeta('CGROUP'))?.kind, 'group_dm');
  assert.deepEqual(h.calls.filter((c) => ['history', 'replies'].includes(c.method)).map((c) => c.args.channel), ['CGROUP', 'CGROUP']);
});

test('an allowed group DM is refused without mpim:read, and its history without mpim:history', async () => {
  const noRead = groupFixture({ scopes: MPIM_SCOPES.filter((s) => s !== 'mpim:read') });
  await assert.rejects(noRead.adapter.fetchHistory('CGROUP'), /mpim:read/);
  await assert.rejects(noRead.adapter.requireReadableConversation('CGROUP'), /mpim:read/);
  const noHistory = groupFixture({ scopes: MPIM_SCOPES.filter((s) => s !== 'mpim:history') });
  await noHistory.adapter.requireReadableConversation('CGROUP');
  await assert.rejects(noHistory.adapter.fetchHistory('CGROUP'), /mpim:history/);
  await assert.rejects(noHistory.adapter.readThread('CGROUP', '1.0', {}), /mpim:history/);
  assert.equal([...noRead.calls, ...noHistory.calls].filter((c) => ['history', 'replies'].includes(c.method)).length, 0);
});

test('a group DM not in groupDms, or no longer joined, is refused as before', async () => {
  const h = groupFixture({ writable: true });
  await assert.rejects(h.adapter.fetchHistory('COTHERGROUP'), /unsupported.*groupDms/);
  await assert.rejects(h.adapter.sendMessage('COTHERGROUP', 'hello'), /unsupported/);
  h.conversations.set('CGROUP', groupDm('CGROUP', false));
  await assert.rejects(h.adapter.fetchHistory('CGROUP'), /unsupported/);
  await assert.rejects(h.adapter.sendMessage('CGROUP', 'hello'), /unsupported/);
  h.conversations.set('CGROUP', { id: 'CGROUP', is_mpim: true, is_member: true, is_im: true, user: 'UALLOWED' });
  await assert.rejects(h.adapter.fetchHistory('CGROUP'), /unsupported/);
  h.conversations.set('CGROUP', { ...groupDm('CGROUP'), id: 'CELSEWHERE' });
  await assert.rejects(h.adapter.fetchHistory('CGROUP'), /unsupported/);
  assert.equal(h.calls.filter((c) => !['info', 'userInfo'].includes(c.method)).length, 0);
});

test('a joined group DM is refused when no groupDms list is configured', async () => {
  const h = fixture({ scopes: MPIM_SCOPES, writeChannels: ['CWRITE', 'CGROUP'] });
  h.conversations.set('CGROUP', groupDm('CGROUP'));
  await assert.rejects(h.adapter.fetchHistory('CGROUP'), /unsupported/);
  await assert.rejects(h.adapter.sendMessage('CGROUP', 'hello'), /unsupported/);
  h.setListed([...h.conversations.values()]);
  assert.equal((await h.adapter.listConversations()).conversations.some((c) => c.id === 'CGROUP'), false);
  assert.equal(h.calls.find((c) => c.method === 'list')?.args.types, 'public_channel,private_channel');
});

for (const [name, write] of writes) {
  test(`${name} in an allowed group DM needs it in writeChannels too`, async () => {
    const readOnly = groupFixture();
    await assert.rejects(write(readOnly.adapter, 'CGROUP'), /not allowed/);
    assert.equal(readOnly.calls.filter((c) => !['info', 'userInfo'].includes(c.method)).length, 0);
    const writable = groupFixture({ writable: true });
    await write(writable.adapter, 'CGROUP');
    await assert.rejects(write(writable.adapter, 'COTHERGROUP'), /unsupported/);
    assert.equal(writable.calls.filter((c) => !['info', 'userInfo'].includes(c.method)).length, 1);
  });
}

test('replies in a writable group DM post into the thread', async () => {
  const h = groupFixture({ writable: true });
  await h.adapter.sendMessage('CGROUP', 'hello', { threadTs: '1.0' });
  assert.deepEqual(h.calls.filter((c) => c.method === 'post').map((c) => [c.args.channel, c.args.thread_ts]), [['CGROUP', '1.0']]);
});

test('attachments are fetched only from an allowed group DM the file is shared in', async () => {
  const h = groupFixture();
  h.setFile({ id: 'F1', shares: { private: { CGROUP: [{ ts: '1.0' }] } }, url_private: 'https://files.slack.com/files-pri/T1-F1/report.txt' });
  await h.adapter.requireReadableConversation('CGROUP');
  assert.equal(associatedFileUrl(await h.adapter.getFileInfo('F1'), 'CGROUP').hostname, 'files.slack.com');
  await assert.rejects(h.adapter.requireReadableConversation('COTHERGROUP'), /unsupported/);
});

test('listing shows allowed group DMs only, and marks them writable only when writeChannels names them', async () => {
  for (const writable of [false, true]) {
    const h = groupFixture({ writable });
    h.setListed([channel('CREAD'), groupDm('CGROUP'), groupDm('COTHERGROUP')]);
    const listed = (await h.adapter.listConversations(true)).conversations;
    assert.deepEqual(listed.map((c) => [c.id, c.kind]), [['CREAD', 'channel'], ['CGROUP', 'group_dm']]);
    assert.equal(h.adapter.canWrite('CGROUP'), writable);
    assert.equal(h.adapter.canWrite('COTHERGROUP'), false);
    assert.equal(h.calls.find((c) => c.method === 'list')?.args.types, 'public_channel,private_channel,mpim');
  }
});

test('listing leaves group DMs out, and says so, when the token lacks mpim:read', async () => {
  const h = groupFixture({ scopes: SCOPES });
  h.setListed([channel('CREAD')]);
  const result = await h.adapter.listConversations();
  assert.deepEqual(result.leftOut, ['mpim']);
  assert.equal(h.calls.find((c) => c.method === 'list')?.args.types, 'public_channel,private_channel');
});

test('incoming group DM messages are delivered as channel messages only from allowed group DMs', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = groupFixture(); const received: Array<[string, boolean]> = [];
  h.adapter.onMessage((message) => received.push([message.channelId, message.isDM]));
  const event = { type: 'message', channel_type: 'mpim', user: 'UHUMAN', text: 'hello' };
  await h.emit({ ...event, channel: 'CGROUP', ts: '1.0' });
  await h.emit({ ...event, channel: 'COTHERGROUP', ts: '2.0' });
  h.conversations.set('CGROUP', groupDm('CGROUP', false));
  await h.emit({ ...event, channel: 'CGROUP', ts: '3.0' });
  assert.deepEqual(received, [['CGROUP', false]]);
});

test('incoming group DM messages are dropped without groupDms, as before', async (t) => {
  t.mock.method(console, 'error', () => {});
  const h = fixture({ scopes: MPIM_SCOPES }); const received: string[] = [];
  h.conversations.set('CGROUP', groupDm('CGROUP'));
  h.adapter.onMessage((message) => received.push(message.channelId));
  await h.emit({ type: 'message', channel: 'CGROUP', channel_type: 'mpim', user: 'UHUMAN', ts: '1.0', text: 'hello' });
  assert.deepEqual(received, []);
});

const routingTest = Number(process.versions.node.split('.')[0]) >= 24 ? test : test.skip;
routingTest('recipient routing tags an allowed group DM as a joined private channel: ambient, or addressed by mention', async (t) => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'group-dm-routing-')));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const h = groupFixture();
  h.adapter.configureRecipientRouting({ stateFile: join(directory, 'receipts.sqlite'), namespace: 'test' });
  const received: any[] = [];
  h.adapter.onMessage((message) => received.push(message.routing));
  const event = { type: 'message', channel: 'CGROUP', channel_type: 'mpim', user: 'UHUMAN' };
  await h.emit({ ...event, ts: '1.0', text: 'hello' });
  await h.emit({ ...event, ts: '2.0', text: 'hello <@UBOT>' });
  assert.deepEqual(received.map((r) => [r.supportAccess.kind, r.supportAccess.joined, r.wakeAllowed]),
    [['private_channel', true, false], ['private_channel', true, true]]);
});
