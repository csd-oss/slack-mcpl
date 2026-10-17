import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUploadPath } from '../src/upload-path.js';
import { MAX_ATTACHMENT_BYTES } from '../src/content.js';
import { SlackAdapter } from '../src/slack-adapter.js';
import { SlackMcplServer } from '../src/server.js';
import { toolDefinitions } from '../src/tools.js';
import { connectHost, initialize } from './harness.js';

async function fixture(t: any, allowFilePaths?: boolean) {
  const uploads: any[] = [];
  const adapter = new SlackAdapter({
    filesUploadV2: async (args: any) => { uploads.push(args); return { files: [{ files: [{ id: 'F1' }] }] }; },
  } as any, { on() {} } as any, 'UBOT', 'workspace', undefined, ['CWRITE']);
  const h = connectHost(new SlackMcplServer(adapter, { allowFilePaths }));
  t.after(() => h.close());
  await initialize(h, false);
  const call = (args: Record<string, unknown>) => h.host.sendRequest('tools/call', {
    name: 'upload_file', arguments: { channelId: 'CWRITE', ...args },
  }) as Promise<{ isError?: boolean; content: Array<{ text: string }> }>;
  const listed = await h.host.sendRequest('tools/list') as { tools: any[] };
  return { uploads, call, tool: listed.tools.find((tool) => tool.name === 'upload_file') };
}

for (const enabled of [undefined, false, true]) {
  test(`path schema and files class are exposed only with explicit opt-in: ${enabled}`, async (t) => {
    const h = await fixture(t, enabled);
    assert.equal(Object.hasOwn(h.tool.inputSchema.properties, 'path'), enabled === true);
    assert.deepEqual(h.tool._meta['mcpl/class'], enabled ? ['comms', 'files'] : ['comms']);
    assert.deepEqual(h.tool.inputSchema.required, enabled ? ['channelId'] : ['channelId', 'filename']);
    assert.equal(Object.hasOwn(toolDefinitions.find((tool) => tool.name === 'upload_file')!.inputSchema.properties, 'path'), false);
    if (!enabled) {
      const result = await h.call({ path: '/must-not-be-read', filename: 'x', content: 'inline' });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /path uploads are disabled/);
      assert.equal(h.uploads.length, 0);
    }
    assert.notEqual((await h.call({ filename: 'inline.txt', content: 'hello' })).isError, true);
    assert.deepEqual(h.uploads[0].file, Buffer.from('hello'));
  });
}

test('enabled path uploads send bounded exact bytes, default filename and preserve write guards', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-path-option-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'bytes.bin'), bytes = Buffer.from([0, 255, 10]);
  writeFileSync(path, bytes);
  const h = await fixture(t, true);
  assert.notEqual((await h.call({ path, messageId: '1.0', comment: 'hello' })).isError, true);
  assert.deepEqual(h.uploads[0], { channel_id: 'CWRITE', file: bytes, filename: 'bytes.bin', title: 'bytes.bin', initial_comment: 'hello', thread_ts: '1.0' });
  assert.equal((await h.call({ path, channelId: 'CREAD' })).isError, true);
  assert.equal(h.uploads.length, 1);
  for (const args of [{ path, content: 'x' }, { path, contentBase64: 'eA==' }, { path: 123 }, { path: 'relative' }]) {
    assert.equal((await h.call(args)).isError, true);
  }
  assert.equal(h.uploads.length, 1);
});

test('path reader rejects nonregular files without blocking and caps all regular files', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-safe-path-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'file.bin');
  writeFileSync(path, 'inside');
  symlinkSync(path, join(dir, 'linked'));
  assert.deepEqual(await readUploadPath(join(dir, 'linked')), Buffer.from('inside'));
  // This mode follows ordinary OS permissions: no directory boundary.
  const outside = mkdtempSync(join(tmpdir(), 'slack-other-path-'));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, 'outside'), 'outside');
  symlinkSync(join(outside, 'outside'), join(dir, 'outside-link'));
  assert.deepEqual(await readUploadPath(join(dir, 'outside-link')), Buffer.from('outside'));
  for (const invalid of [dir, '/dev/null']) await assert.rejects(readUploadPath(invalid), /regular file/);
  await assert.rejects(readUploadPath('relative.txt'), /absolute/);
  execFileSync('mkfifo', [join(dir, 'pipe')]);
  await assert.rejects(readUploadPath(join(dir, 'pipe')), /regular file/);
  writeFileSync(path, Buffer.alloc(MAX_ATTACHMENT_BYTES + 1));
  await assert.rejects(readUploadPath(path), /too large/);
  writeFileSync(path, Buffer.alloc(MAX_ATTACHMENT_BYTES));
  assert.equal((await readUploadPath(path)).length, MAX_ATTACHMENT_BYTES);
});

test('reader caps bytes even if size metadata is stale, and closes its one descriptor', async (t) => {
  let opened = 0, closed = 0, readCapacity = 0;
  const mock = t.mock.method(fsPromises, 'open', async () => {
    opened++;
    return {
      stat: async () => ({ isFile: () => true, size: 1 }),
      read: async (_buffer: Buffer, _offset: number, length: number) => { readCapacity += length; return { bytesRead: length }; },
      close: async () => { closed++; },
    };
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(readUploadPath('/fake/growing-file'), /too large/);
  assert.equal(opened, 1); assert.equal(closed, 1);
  assert.equal(readCapacity, MAX_ATTACHMENT_BYTES + 1);
});
