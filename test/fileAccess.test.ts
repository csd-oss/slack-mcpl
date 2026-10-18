import test from 'node:test';
import assert from 'node:assert/strict';
import { associatedFileUrl } from '../src/file-access.js';
import { SlackAdapter } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { connectHost, initialize } from './harness.js';

test('file association uses exact conversation IDs in Slack share metadata', () => {
  const url_private = 'https://files.slack.com/files-pri/T1-F1/test.txt';
  for (const association of [
    { channels: ['C1'] }, { groups: ['C1'] }, { ims: ['C1'] },
    { shares: { public: { C1: [{ ts: '1.0' }] } } }, { shares: { private: { C1: [{ ts: '1.0' }] } } },
  ]) assert.equal(associatedFileUrl({ ...association, url_private }, 'C1').toString(), url_private);
  for (const association of [{}, { channels: ['C11'] }, { shares: { public: { C1: [] } } }, { channels: 'C1' }]) {
    assert.throws(() => associatedFileUrl({ ...association, url_private }, 'C1'), /not associated/);
  }
  assert.throws(() => associatedFileUrl({ channels: ['C1'], url_private: 'https://evil.example/file' }, 'C1'), /evil\.example isn't Slack's file server/);
});

async function fixture(t: any, opts: { legacy?: boolean; scopes?: string[] } = {}) {
  let member = true;
  let file: Record<string, unknown> = { id: 'F1', channels: ['C1'], url_private: 'https://files.slack.com/files-pri/T1-F1/canonical.txt' };
  const calls: string[] = [];
  const downloads: Array<{ url: string; options: RequestInit | undefined }> = [];
  const adapter = new SlackAdapter({
    conversations: { info: async ({ channel }: { channel: string }) => {
      calls.push(`membership:${channel}`);
      return { channel: { id: channel, is_im: false, is_mpim: false, is_private: false, is_member: member } };
    } },
    files: { info: async () => { calls.push('fileInfo'); return { file }; } },
  } as any, { on() {} } as any, 'UBOT', 'acme', undefined, undefined, false, undefined,
  opts.scopes ?? ['channels:read', 'files:read']);
  if (!opts.legacy) adapter.configureAccessPolicy({ writeChannels: ['C1'], dmUsers: [], readJoinedChannels: true });
  const h = connectHost(new SlackMcplServer(adapter));
  t.after(() => h.close());
  await initialize(h, false);
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    downloads.push({ url: String(url), options });
    return new Response('hello', { headers: { 'content-type': 'text/plain' } });
  });
  return {
    calls, downloads, host: h.host,
    member(value: boolean) { member = value; }, file(value: Record<string, unknown>) { file = value; },
    call: async (args: Record<string, unknown>) => h.host.sendRequest('tools/call', {
      name: 'fetch_attachment', arguments: args,
    }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>,
  };
}

test('explicit file fetch requires channel and file IDs and ignores untrusted requested URLs', async (t) => {
  const h = await fixture(t);
  const listed = await h.host.sendRequest('tools/list') as { tools: Array<{ name: string; inputSchema: { required: string[]; properties: Record<string, unknown> } }> };
  assert.deepEqual(listed.tools.find((tool) => tool.name === 'fetch_attachment')?.inputSchema.required, ['channelId', 'fileId']);
  assert.ok(['channelId', 'fileId'].every((key) => key in listed.tools.find((tool) => tool.name === 'fetch_attachment')!.inputSchema.properties));
  const missing = await h.call({ url: 'https://files.slack.com/files-pri/T1-F1/input.txt' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /channelId must be a non-empty string, and this call left it out/);
  const missingFile = await h.call({ channelId: 'C1' });
  assert.equal(missingFile.isError, true);
  assert.match(missingFile.content[0].text, /fileId must be a non-empty string, and this call left it out/);
  assert.equal(h.downloads.length, 0);
  const result = await h.call({ channelId: 'C1', fileId: 'F1', url: 'https://evil.example/do-not-fetch' });
  assert.notEqual(result.isError, true);
  assert.deepEqual(h.calls, ['membership:C1', 'fileInfo']);
  assert.equal(h.downloads[0].url, 'https://files.slack.com/files-pri/T1-F1/canonical.txt');
  assert.equal(h.downloads[0].options?.redirect, 'error');
});

test('explicit file fetch rechecks membership and denies unjoined or unrelated files before bytes', async (t) => {
  const h = await fixture(t);
  h.member(false);
  assert.equal((await h.call({ channelId: 'C1', fileId: 'F1' })).isError, true);
  assert.deepEqual(h.calls, ['membership:C1']);
  h.member(true);
  h.file({ id: 'F1', channels: ['COTHER'], url_private: 'https://files.slack.com/files-pri/T1-F1/file.txt' });
  const unrelated = await h.call({ channelId: 'C1', fileId: 'F1' });
  assert.equal(unrelated.isError, true);
  assert.match(unrelated.content[0].text, /not associated/);
  assert.equal(h.downloads.length, 0);
  h.file({ id: 'F1', channels: ['C1'], url_private: 'https://files.slack.com/files-pri/T1-F1/file.txt' });
  assert.notEqual((await h.call({ channelId: 'C1', fileId: 'F1' })).isError, true);
  h.member(false);
  assert.equal((await h.call({ channelId: 'C1', fileId: 'F1' })).isError, true);
  assert.equal(h.downloads.length, 1);
});

test('missing files:read scope denies downloads', async (t) => {
  const h = await fixture(t, { scopes: ['channels:read'] });
  const result = await h.call({ channelId: 'C1', fileId: 'F1' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /files:read/);
  assert.equal(h.downloads.length, 0);
});

test('mismatched file metadata denies downloads', async (t) => {
  const h = await fixture(t);
  h.file({ id: 'FOTHER', channels: ['C1'], url_private: 'https://files.slack.com/files-pri/T1-FOTHER/file.txt' });
  const result = await h.call({ channelId: 'C1', fileId: 'F1' });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /mismatched file metadata/);
  assert.equal(h.downloads.length, 0);
});

test('explicit bearer downloads reject redirect responses without forwarding authorization', async (t) => {
  const h = await fixture(t);
  const previous = process.env.SLACK_BOT_TOKEN;
  const fakeToken = 'test-only-file-download-bearer';
  process.env.SLACK_BOT_TOKEN = fakeToken;
  t.after(() => { if (previous === undefined) delete process.env.SLACK_BOT_TOKEN; else process.env.SLACK_BOT_TOKEN = previous; });
  const sent: Array<{ url: string; redirect?: RequestInit['redirect']; authorization?: string }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    sent.push({ url: String(url), redirect: options?.redirect, authorization: (options?.headers as Record<string, string>)?.Authorization });
    // Native fetch throws for redirect:'error'; a 302 is also refused if a
    // custom transport returns it. No second fetch is made to Location.
    return new Response(null, { status: 302, headers: { Location: 'https://evil.example/collect' } });
  });
  const result = await h.call({ channelId: 'C1', fileId: 'F1' });
  assert.equal(result.isError, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].redirect, 'error');
  assert.equal(new URL(sent[0].url).host, 'files.slack.com');
  assert.equal(sent[0].authorization, `Bearer ${fakeToken}`);
  assert.ok(!result.content[0].text.includes(fakeToken));
  assert.ok(!result.content[0].text.includes('evil.example'));
});

test('legacy URL-only fetch remains compatible without the explicit profile', async (t) => {
  const h = await fixture(t, { legacy: true });
  assert.notEqual((await h.call({ url: 'https://files.slack.com/files-pri/T1-F1/legacy.txt' })).isError, true);
  assert.deepEqual(h.calls, []);
  assert.equal(h.downloads[0].url, 'https://files.slack.com/files-pri/T1-F1/legacy.txt');
});

