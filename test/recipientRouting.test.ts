import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoutingLedger, type RoutingInput } from '../src/recipient-routing.js';

const supported = Number(process.versions.node.split('.')[0]) >= 24 && typeof process.geteuid === 'function';
const durableTest = supported ? test : test.skip;
const policy = { writeChannels: ['CWRITE', 'GWRITE'], dmUsers: ['UHUMAN'], readJoinedChannels: true };
const channel = (overrides: Partial<RoutingInput> = {}): RoutingInput => ({
  channel: 'CWRITE', id: '1.0', root: '1.0', authorId: 'UHUMAN', senderKind: 'human', mentions: ['UBOT'],
  access: { version: 1, channelId: 'CWRITE', readable: true, kind: 'channel', joined: true }, ...overrides,
});
const dm = (overrides: Partial<RoutingInput> = {}): RoutingInput => channel({
  channel: 'DCHAT', mentions: [], dmAuthorizedPeer: 'UHUMAN',
  access: { version: 1, channelId: 'DCHAT', readable: true, kind: 'dm', dmPeer: 'UHUMAN' }, ...overrides,
});
function directory(t: { after(fn: () => void): void }) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'recipient-routing-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, path: join(dir, 'routing.sqlite') };
}
function database(path: string) {
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  return new DatabaseSync(path);
}

test('recipient module imports without loading the optional SQLite feature', () => {
  assert.equal(typeof RoutingLedger, 'function');
  if (!supported) assert.throws(() => new RoutingLedger('/not-created/ledger', 'UBOT', 'workspace', policy), /requires Node 24/);
});

test('legacy import succeeds when SQLite is explicitly disabled by Node', () => {
  const url = new URL('../src/recipient-routing.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--no-experimental-sqlite', '--import', 'tsx', '--input-type=module', '-e',
    `const module = await import(${JSON.stringify(url)}); if (typeof module.RoutingLedger !== 'function') process.exit(2);`],
    { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 0, child.stderr);
});

durableTest('durable receipts are at most once across handles and restarts, with channel-scoped IDs', (t) => {
  const { path } = directory(t);
  let first = new RoutingLedger(path, 'UBOT', 'workspace', policy);
  let second = new RoutingLedger(path, 'UBOT', 'workspace', policy);
  try {
    assert.equal(first.receive(channel())?.wakeAllowed, true);
    assert.equal(second.receive(channel()), null);
    const other = channel({ channel: 'GREAD', access: { version: 1, channelId: 'GREAD', readable: true, kind: 'private_channel', joined: true } });
    assert.equal(second.receive(other)?.wakeAllowed, true);
    first.close(); second.close();
    first = new RoutingLedger(path, 'UBOT', 'workspace', policy);
    second = new RoutingLedger(path, 'UBOT', 'workspace', policy);
    assert.equal(first.receive(channel()), null);
    assert.equal(second.receive(other), null);
  } finally { first.close(); second.close(); }
});

durableTest('own mentions are addressed for humans, bots and unknown senders without prior traffic', (t) => {
  const { path } = directory(t); const ledger = new RoutingLedger(path, 'UBOT', 'workspace', policy);
  try {
    for (const [index, senderKind] of ['human', 'bot', 'unknown'].entries()) {
      const result = ledger.receive(channel({ id: `${index + 1}.0`, senderKind: senderKind as RoutingInput['senderKind'] }))!;
      assert.equal(result.wakeAllowed, true);
      assert.equal(result.senderKind, senderKind);
      assert.equal(result.isBot, senderKind !== 'human');
      assert.equal(result.routingReason, senderKind === 'human' ? 'human-mention' : 'peer-mention');
      assert.equal(result.authority, senderKind === 'human' ? 'human-source' : 'peer-not-owner');
      assert.deepEqual(result.mentionIds, ['UBOT']);
      assert.equal(result.botUserId, 'UBOT');
    }
  } finally { ledger.close(); }
});

durableTest('unmentioned and other-recipient messages are context; multi-mentions preserve actual provenance', (t) => {
  const { path } = directory(t); const ledger = new RoutingLedger(path, 'UBOT', 'workspace', policy);
  try {
    for (const [index, mentions] of [[], ['UOTHER']].entries()) {
      const result = ledger.receive(channel({ id: `${index + 1}.0`, mentions }))!;
      assert.equal(result.wakeAllowed, false);
      assert.equal(result.routingReason, 'context-only');
      assert.deepEqual(result.mentionIds, mentions);
    }
    const result = ledger.receive(channel({ id: '3.0', mentions: ['UOTHER', 'UBOT'] }))!;
    assert.equal(result.wakeAllowed, true);
    assert.deepEqual(result.mentionIds, ['UOTHER', 'UBOT']);
  } finally { ledger.close(); }
});

durableTest('DM wake uses the verified human counterpart independently from mention IDs', (t) => {
  const { path } = directory(t); const ledger = new RoutingLedger(path, 'UBOT', 'workspace', policy);
  try {
    const result = ledger.receive(dm())!;
    assert.equal(result.wakeAllowed, true);
    assert.equal(result.routingReason, 'authorized-human-dm');
    assert.deepEqual(result.mentionIds, []);
    assert.equal(result.dmAuthorizedPeer, 'UHUMAN');
    for (const [index, changed] of [
      { senderKind: 'bot' }, { senderKind: 'unknown' }, { authorId: 'UOTHER' },
      { dmAuthorizedPeer: 'UOTHER' }, { dmAuthorizedPeer: undefined }, { authorId: undefined },
    ].entries()) {
      const receipt = ledger.receive(dm({ id: `${index + 2}.0`, mentions: ['UBOT'], ...changed } as Partial<RoutingInput>))!;
      assert.equal(receipt.wakeAllowed, false, JSON.stringify(changed));
      assert.deepEqual(receipt.mentionIds, ['UBOT']);
      assert.equal(receipt.dmAuthorizedPeer, undefined);
    }
  } finally { ledger.close(); }
});

durableTest('denied admission does not consume a receipt; empty DM lists and disabled channel reading fail closed', (t) => {
  const { path } = directory(t); let ledger = new RoutingLedger(path, 'UBOT', 'workspace', { ...policy, dmUsers: [], readJoinedChannels: false });
  try {
    assert.throws(() => ledger.receive(dm()), /DM peer is not authorized/);
    assert.throws(() => ledger.receive(channel()), /joined channel is not authorized/);
    ledger.close(); ledger = new RoutingLedger(path, 'UBOT', 'workspace', policy);
    assert.equal(ledger.receive(dm())?.wakeAllowed, true);
    assert.equal(ledger.receive(channel())?.wakeAllowed, true);
  } finally { ledger.close(); }
});

durableTest('policy is copied/frozen; receipt fields cannot mutate future routing or input provenance', (t) => {
  const { path } = directory(t); const config = { writeChannels: ['CWRITE'], dmUsers: [] as string[], readJoinedChannels: true };
  const ledger = new RoutingLedger(path, 'UBOT', 'workspace', config);
  try {
    config.dmUsers.push('UHUMAN'); config.writeChannels.push('COTHER');
    assert.throws(() => ledger.receive(dm()), /not authorized/);
    assert.deepEqual(JSON.parse(JSON.stringify(ledger.accessPolicy)), { writeChannels: ['CWRITE'], dmUsers: [], readJoinedChannels: true });
    assert.ok(Object.isFrozen(ledger.accessPolicy)); assert.ok(Object.isFrozen(ledger.accessPolicy.dmUsers));
    const input = channel(); const receipt = ledger.receive(input)!;
    input.access.channelId = 'COTHER'; (input.mentions as string[]).push('UOTHER');
    assert.equal(receipt.supportAccess.channelId, 'CWRITE');
    assert.deepEqual(receipt.mentionIds, ['UBOT']);
    receipt.supportAccess.channelId = 'COTHER'; receipt.mentionIds.push('UELSE');
    assert.equal(ledger.receive(channel({ id: '2.0' }))?.wakeAllowed, true);
  } finally { ledger.close(); }
});

durableTest('existing identity and receipts survive policy changes; foreign identity/namespace are refused', (t) => {
  const { path } = directory(t); const old = new RoutingLedger(path, 'UBOT', 'anchor-channel', policy);
  old.receive(channel()); old.close();
  assert.throws(() => new RoutingLedger(path, 'UOTHER', 'anchor-channel', policy), /another or invalid identity/);
  assert.throws(() => new RoutingLedger(path, 'UBOT', 'other-namespace', policy), /another or invalid identity/);
  const revised = new RoutingLedger(path, 'UBOT', 'anchor-channel', { writeChannels: [], dmUsers: [], readJoinedChannels: true });
  try { assert.equal(revised.receive(channel()), null); } finally { revised.close(); }
});

durableTest('old seen/identity schema and unrelated legacy state are retained without reset', (t) => {
  const { path } = directory(t); let db = database(path);
  db.exec("CREATE TABLE identity(own_user TEXT,channel TEXT); INSERT INTO identity VALUES ('UBOT','CLEGACY'); CREATE TABLE seen(channel TEXT,id TEXT,PRIMARY KEY(channel,id)); INSERT INTO seen VALUES ('CWRITE','1.0'); CREATE TABLE preserved(payload TEXT); INSERT INTO preserved VALUES ('retained')");
  db.close(); chmodSync(path, 0o600);
  const ledger = new RoutingLedger(path, 'UBOT', 'CLEGACY', policy);
  assert.equal(ledger.receive(channel()), null); ledger.close();
  db = database(path);
  try { assert.deepEqual(db.prepare('SELECT payload FROM preserved').get().payload, 'retained'); } finally { db.close(); }
});

durableTest('orphaned or multiply bound receipt state is refused rather than adopted', (t) => {
  const { dir } = directory(t);
  for (const malformed of ['orphan', 'multiple']) {
    const path = join(dir, malformed); const db = database(path);
    db.exec("CREATE TABLE seen(channel TEXT,id TEXT,PRIMARY KEY(channel,id)); INSERT INTO seen VALUES ('CWRITE','1.0')");
    if (malformed === 'multiple') db.exec("CREATE TABLE identity(own_user TEXT,channel TEXT); INSERT INTO identity VALUES ('UBOT','workspace'),('UBOT','workspace')");
    db.close(); chmodSync(path, 0o600);
    assert.throws(() => new RoutingLedger(path, 'UBOT', 'workspace', policy), /no identity binding|invalid identity/);
    const check = database(path);
    try { assert.equal(check.prepare('SELECT COUNT(*) AS n FROM seen').get().n, 1); } finally { check.close(); }
  }
});

durableTest('malformed metadata, missing membership and cross-channel proofs fail before receipt writes', (t) => {
  const { path } = directory(t); const ledger = new RoutingLedger(path, 'UBOT', 'workspace', policy);
  try {
    for (const changes of [
      { channel: '../CWRITE' }, { channel: ['CWRITE'] }, { id: '' }, { root: 'invalid' },
      { senderKind: 'owner' }, { authorId: ['UHUMAN'] }, { mentions: ['not-a-user'] }, { mentions: ['WBOT'] },
      { mentions: ['UBOT', 'UBOT'] }, { access: undefined },
      { access: { ...channel().access, channelId: 'COTHER' } },
      { access: { ...channel().access, joined: false } },
      { access: { ...channel().access, readable: false } },
      { access: { ...channel().access, kind: 'group_dm' } },
    ]) assert.throws(() => ledger.receive(channel(changes as any)));
    assert.equal(ledger.receive(channel())?.wakeAllowed, true);
  } finally { ledger.close(); }
});

durableTest('invalid constructor configuration fails without creating or truncating state', (t) => {
  const { path } = directory(t);
  for (const [user, namespace, config] of [
    ['not-a-user', 'workspace', policy], ['WBOT', 'workspace', policy], ['UBOT', '', policy], ['UBOT', 123, policy],
    ['UBOT', 'workspace', { ...policy, writeChannels: ['DCHAT'] }],
    ['UBOT', 'workspace', { ...policy, dmUsers: ['bad'] }],
    ['UBOT', 'workspace', { ...policy, dmUsers: ['WHUMAN'] }],
    ['UBOT', 'workspace', { ...policy, dmUsers: ['UHUMAN', 'UHUMAN'] }],
    ['UBOT', 'workspace', { ...policy, readJoinedChannels: 'true' }],
  ]) assert.throws(() => new RoutingLedger(path, user as string, namespace as string, config as any));
  assert.equal(existsSync(path), false);
});

durableTest('unsafe state paths are refused and close is idempotent', (t) => {
  const { dir, path } = directory(t);
  const linked = join(dir, 'link'); writeFileSync(path, 'private-source', { mode: 0o600 }); symlinkSync(path, linked);
  assert.throws(() => new RoutingLedger(linked, 'UBOT', 'workspace', policy));
  assert.equal(readFileSync(path, 'utf8'), 'private-source');
  const hardlink = join(dir, 'hardlink'); linkSync(path, hardlink);
  assert.throws(() => new RoutingLedger(hardlink, 'UBOT', 'workspace', policy), /private regular file/);
  const publicFile = join(dir, 'public'); writeFileSync(publicFile, '', { mode: 0o644 });
  assert.throws(() => new RoutingLedger(publicFile, 'UBOT', 'workspace', policy), /private regular file/);
  const publicDir = join(dir, 'public-dir');
  // The parent must preexist and be private, never created implicitly.
  assert.throws(() => new RoutingLedger(join(publicDir, 'ledger'), 'UBOT', 'workspace', policy));
  const good = new RoutingLedger(join(dir, 'good'), 'UBOT', 'workspace', policy);
  good.close(); good.close(); assert.throws(() => good.receive(channel()), /closed/);
});
