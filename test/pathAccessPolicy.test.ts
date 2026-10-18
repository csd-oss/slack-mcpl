import test from 'node:test';
import assert from 'node:assert/strict';
import {SlackAdapter} from '../src/slack-adapter.js';
import {SlackMcplServer} from '../src/server.js';
import {MAX_ATTACHMENT_BYTES} from '../src/content.js';
import {connectHost, initialize} from './harness.js';

async function fixture(t: any, options: {scopes?: readonly string[]; member?: boolean; sdk?: boolean; disabled?: boolean} = {}) {
  let member = options.member ?? true, peer = 'UHUMAN', reads = 0, uploads = 0, infos = 0;
  const web: any = {
    conversations: {async info({channel}: {channel: string}) {
      infos++;
      return {channel: channel.startsWith('D') ? {id: channel, is_im: true, user: peer}
        : {id: channel, is_im: false, is_mpim: false, is_private: false, is_member: member}};
    }},
    ...(options.sdk === false ? {} : {async filesUploadV2() {uploads++; return {files: [{files: [{id: 'FFILE'}]}]};}}),
  };
  const adapter = new SlackAdapter(web, {on() {}} as any, 'UBOT', 'fixture', undefined, undefined, false, undefined,
    [...(options.scopes ?? ['channels:read', 'files:write', 'im:read'])]);
  adapter.configureAccessPolicy({writeChannels: ['CWRITE'], dmUsers: ['UHUMAN'], readJoinedChannels: true});
  const server = new SlackMcplServer(adapter, {pathUploads: {mode: 'unrestricted'},
    disabledTools: options.disabled ? ['upload_file'] : []});
  const h = connectHost(server);
  t.after(async () => {await h.close(); server.close();});
  await initialize(h, false);
  const reader = (server as any).pathReader;
  reader.read = async () => {reads++; return Buffer.from('fixture');};
  return {adapter, server, reader,
    get reads() {return reads;}, get uploads() {return uploads;}, get infos() {return infos;},
    member(value: boolean) {member = value;}, peer(value: string) {peer = value;},
    call: (args: Record<string, unknown> = {}) => h.host.sendRequest('tools/call', {name: 'upload_file',
      arguments: {channelId: 'CWRITE', path: '/fixture/file.txt', ...args}}) as Promise<any>,
  };
}

for (const [name, options, args] of [
  ['missing upload scope', {scopes: ['channels:read']}, {}],
  ['revoked membership', {member: false}, {}],
  ['read-only destination', {}, {channelId: 'CREAD'}],
  ['unavailable SDK method', {sdk: false}, {}],
  ['disabled upload tool', {disabled: true}, {}],
] as const) {
  test(`explicit access policy refuses ${name} before local file reads`, async t => {
    const h = await fixture(t, options);
    assert.equal((await h.call(args)).isError, true);
    assert.equal(h.reads, 0); assert.equal(h.uploads, 0);
  });
}

test('explicit policy refuses an unapproved DM counterpart before local file reads', async t => {
  const h = await fixture(t); h.peer('UOTHER');
  assert.equal((await h.call({channelId: 'DCHAT'})).isError, true);
  assert.equal(h.reads, 0); assert.equal(h.uploads, 0);
});

test('path arguments are validated before destination preflight or local reads', async t => {
  const h = await fixture(t);
  for (const args of [{path: '/fixture/a', content: 'inline'}, {path: 12}, {filename: ''}]) {
    assert.equal((await h.call(args)).isError, true);
  }
  assert.equal(h.infos, 0); assert.equal(h.reads, 0); assert.equal(h.uploads, 0);
});

test('membership is freshly revalidated after reading before the Slack upload', async t => {
  const h = await fixture(t);
  h.reader.read = async () => {h.member(false); return Buffer.from('fixture');};
  assert.equal((await h.call()).isError, true);
  assert.equal(h.infos, 2); assert.equal(h.uploads, 0);
});

test('a path reader cannot bypass the adapter byte cap', async t => {
  const h = await fixture(t);
  h.reader.read = async () => Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
  assert.equal((await h.call()).isError, true);
  assert.equal(h.uploads, 0);
});

test('embedded boolean draft option is refused instead of enabling filesystem access', () => {
  assert.throws(() => new SlackMcplServer({} as any, {allowFilePaths: true} as any), /was removed.*pathUploads/);
});
