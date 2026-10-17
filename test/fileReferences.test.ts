import test from 'node:test';
import assert from 'node:assert/strict';
import { method } from '@animalabs/mcpl-core';
import { SlackAdapter } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { connectHost, initialize, FULL_GRANT, until } from './harness.js';

async function fixture(t: any, explicit = true) {
  let messageHandler: any;
  const fileInfo: string[] = [];
  const downloads: string[] = [];
  const conversation = { id: 'C1', name: 'general', is_member: true, is_im: false, is_mpim: false, is_private: false };
  const history = [{ ts: '100.1', user: 'U2', text: 'history with files', files: [
    { id: 'FHISTORY', name: 'history.txt', mimetype: 'text/plain', url_private: 'https://files.slack.com/untrusted-message-history-url' },
    { name: 'FINVENTED.txt', mimetype: 'text/plain', url_private: 'https://files.slack.com/no-file-id' },
  ] }];
  const adapter = new SlackAdapter({
    conversations: {
      list: async () => ({ channels: [conversation] }),
      info: async () => ({ channel: conversation }),
      history: async () => ({ messages: history }), replies: async () => ({ messages: history }),
    },
    users: { info: async ({ user }: { user: string }) => ({ user: { name: user } }) },
    files: { info: async ({ file }: { file: string }) => {
      fileInfo.push(file);
      return { file: { id: file, channels: ['C1'], url_private: `https://files.slack.com/files-pri/T1-${file}/canonical.txt` } };
    } },
  } as any, { on(event: string, handler: any) { if (event === 'message') messageHandler = handler; } } as any,
  'UBOT', 'acme', undefined, undefined, false, undefined, ['channels:read', 'channels:history', 'files:read']);
  if (explicit) adapter.configureAccessPolicy({ writeChannels: ['C1'], dmUsers: [], readJoinedChannels: true });
  const h = connectHost(new SlackMcplServer(adapter));
  t.after(() => h.close());
  await initialize(h, true);
  await h.host.sendRequest(method.FEATURE_SETS_UPDATE, { effectiveCapabilities: FULL_GRANT });
  await until(() => h.hostSaw.some((request) => request.method === method.CHANNELS_REGISTER), 'registration');
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request) => {
    downloads.push(String(url));
    return new Response('verified attachment', { headers: { 'content-type': 'text/plain' } });
  });
  const call = async (name: string, args: Record<string, unknown>) => h.host.sendRequest('tools/call', {
    name, arguments: args,
  }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  return { h, adapter, fileInfo, downloads, call,
    async emit() {
      messageHandler({ event: {
        type: 'message', channel: 'C1', channel_type: 'channel', user: 'U2', text: '<@UBOT> files', ts: '200.1',
        files: [{ id: 'FLIVE', name: 'live.txt', mimetype: 'text/plain' }, { name: 'FINVENTED.txt', mimetype: 'text/plain', url_private: 'https://files.slack.com/no-file-id' }],
      }, ack: async () => {} });
      await until(() => h.hostSaw.some((request) => request.method === method.PUSH_EVENT), 'live attachment delivery');
      const push = h.hostSaw.find((request) => request.method === method.PUSH_EVENT)!;
      return (push.params as any).payload.content.map((block: any) => block.text ?? '').join('\n');
    },
  };
}

function argumentsFrom(text: string): Array<{ channelId: string; fileId: string }> {
  return [...text.matchAll(/fetch_attachment\((\{[^\n]*?\})\)/g)].map((match) => JSON.parse(match[1]));
}

test('live and backscroll attachment references expose usable protected-fetch arguments', async (t) => {
  const h = await fixture(t);
  const text = await h.emit();
  const args = argumentsFrom(text);
  assert.ok(args.some((arg) => arg.channelId === 'C1' && arg.fileId === 'FLIVE'));
  assert.ok(args.some((arg) => arg.channelId === 'C1' && arg.fileId === 'FHISTORY'));
  assert.ok(!args.some((arg) => arg.fileId === 'FINVENTED'));
  assert.match(text, /FINVENTED\.txt[^\n]*not downloadable: Slack file ID is missing/);
  const live = args.find((arg) => arg.fileId === 'FLIVE')!;
  assert.notEqual((await h.call('fetch_attachment', live)).isError, true);
  assert.deepEqual(h.fileInfo, ['FLIVE']);
  assert.deepEqual(h.downloads, ['https://files.slack.com/files-pri/T1-FLIVE/canonical.txt']);
});

test('normal history and thread tool responses retain Slack file IDs and supply protected-fetch arguments', async (t) => {
  const h = await fixture(t);
  const raw = await h.adapter.fetchHistory('C1');
  assert.equal(raw.messages[0].attachments[0].fileId, 'FHISTORY');
  assert.equal(raw.messages[0].attachments[1].fileId, undefined);
  for (const name of ['fetch_history', 'fetch_thread']) {
    const result = await h.call(name, { channelId: 'C1', threadTs: '100.1' });
    assert.notEqual(result.isError, true);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.messages[0].channelId, 'C1');
    const rendered = body.messages[0].attachments.join('\n');
    const args = argumentsFrom(rendered);
    assert.deepEqual(args, [{ channelId: 'C1', fileId: 'FHISTORY' }]);
    assert.match(rendered, /FINVENTED\.txt[^\n]*not downloadable/);
    assert.notEqual((await h.call('fetch_attachment', args[0])).isError, true);
  }
  assert.deepEqual(h.fileInfo, ['FHISTORY', 'FHISTORY']);
  assert.deepEqual(h.downloads, [
    'https://files.slack.com/files-pri/T1-FHISTORY/canonical.txt',
    'https://files.slack.com/files-pri/T1-FHISTORY/canonical.txt',
  ]);
});

test('legacy history references keep their URL-only fetch instructions', async (t) => {
  const h = await fixture(t, false);
  const result = await h.call('fetch_history', { channelId: 'C1' });
  assert.match(result.content[0].text, /fetchable via fetch_attachment: https:\/\/files.slack.com\/untrusted-message-history-url/);
  assert.deepEqual(argumentsFrom(result.content[0].text), []);
});
