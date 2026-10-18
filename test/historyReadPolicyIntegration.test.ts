import test from 'node:test';
import assert from 'node:assert/strict';
import {SlackAdapter} from '../src/slack-adapter.js';

function fixture(options: {scopes?: string[]; dmUsers?: string[]; disableDms?: boolean; fallback?: boolean} = {}) {
  const calls: Array<{method: string; args: any}> = [];
  let joined = true, metadataError: unknown;
  const web = {conversations: {
    async info(args: any) {
      calls.push({method: 'info', args});
      if (metadataError) throw metadataError;
      return {channel: args.channel === 'D1' ? {id: 'D1', is_im: true, is_mpim: false, user: 'UALLOWED'} :
        {id: args.channel, is_im: false, is_mpim: false, is_private: false, is_member: joined}};
    },
    async history(args: any) {
      calls.push({method: 'history', args});
      if (!joined) throw new Error('not_in_channel');
      return args.limit === 1 ? {ok: true, messages: []} : {ok: true, messages: [
        {ts: '2.0', user: 'U1', text: 'second', files: [{id: 'FVALID', name: 'a.txt', url_private: 'https://files.slack.com/untrusted'}]},
        {ts: '1.0', user: 'U1', text: 'first'},
      ].filter(row => !args.latest || Number(row.ts) < Number(args.latest))};
    },
    async replies(args: any) {calls.push({method: 'replies', args});return {messages: [{ts: '1.0', thread_ts: '1.0', reply_count: 0}]};},
  }} as any;
  const adapter = new SlackAdapter(web, {on() {}, async start() {}, async disconnect() {}} as any,
    'UBOT', 'fixture', undefined, undefined, options.disableDms ?? false, undefined,
    options.scopes ?? ['channels:read', 'channels:history', 'im:read', 'im:history']);
  adapter.configureAccessPolicy({readJoinedChannels: true, writeChannels: ['C1'], dmUsers: options.dmUsers ?? [],
    ...(options.fallback ? {historyMembershipFallbackChannels: ['C1']} : {})});
  return {adapter, calls, revoke() {joined = false;}, failMetadata(error: unknown) {metadataError = error;}};
}

test('bounded continuation and thread reads reapply explicit membership and scope policy', async () => {
  const h = fixture();
  const first = await h.adapter.readHistory('C1', {limit: 1});
  assert.equal(first.messages[0]!.channelId, 'C1');
  assert.match(first.messages[0]!.attachments![0]!, /fetch_attachment\(\{"channelId":"C1","fileId":"FVALID"\}\)/);
  assert.doesNotMatch(first.messages[0]!.attachments![0]!, /untrusted/);
  const oldDataCalls = h.calls.filter(call => call.method !== 'info').length;
  h.revoke();
  await assert.rejects(h.adapter.readHistory('C1', {limit: 1, cursor: first.pagination.nextCursor}), /not a confirmed joined channel/);
  await assert.rejects(h.adapter.readThread('C1', '1.0', {}), /not a confirmed joined channel/);
  assert.equal(h.calls.filter(call => call.method !== 'info').length, oldDataCalls);
  const missing = fixture({scopes: ['channels:read']});
  await assert.rejects(missing.adapter.readHistory('C1', {}), /channels:history/);
  assert.equal(missing.calls.filter(call => call.method === 'history').length, 0);
});

test('explicit-policy metadata errors never enter legacy optional-metadata fallback', async () => {
  const h = fixture(); h.failMetadata({code: 'slack_webapi_platform_error', data: {error: 'missing_scope'}});
  await assert.rejects(h.adapter.readHistory('C1', {}), error => (error as any).data.error === 'missing_scope');
  assert.deepEqual(h.calls.map(call => call.method), ['info']);
});

test('bounded DM reads preserve the explicit policy precedence over legacy switches', async () => {
  const denied = fixture();
  await assert.rejects(denied.adapter.readHistory('D1', {}), /not allowed/);
  await assert.rejects(denied.adapter.readThread('D1', '1.0', {}), /not allowed/);
  assert.equal(denied.calls.some(call => call.method !== 'info'), false);
  const allowed = fixture({dmUsers: ['UALLOWED'], disableDms: true});
  assert.equal((await allowed.adapter.readThread('D1', '1.0', {})).messages.length, 1);
});

test('pinned history membership proof consumes the data-page budget and remains fresh on resume', async () => {
  const h = fixture({scopes: ['channels:history'], fallback: true});
  const bounded = await h.adapter.readHistory('C1', {maxPages: 1});
  assert.equal(bounded.pagination.stopReason, 'page_limit');
  assert.equal(bounded.pagination.pages, 1);
  assert.deepEqual(bounded.messages, []);
  assert.equal(h.calls.filter(call => call.method === 'history').length, 1);
  assert.equal(h.calls.some(call => call.method === 'info'), false);
  const second = await h.adapter.readHistory('C1', {maxPages: 2, cursor: bounded.pagination.nextCursor});
  assert.equal(second.pagination.pages, 2);
  assert.equal(second.messages.length, 2);
  assert.equal(second.pagination.scanComplete, true);
  h.revoke();
  await assert.rejects(h.adapter.readHistory('C1', {maxPages: 2, cursor: bounded.pagination.nextCursor}), /not_in_channel/);
});
