/** Optional durable recipient routing. Importing this module does not load
 * node:sqlite; constructing a ledger requires Node 24+ on a POSIX platform.
 *
 * Admission is trusted adapter metadata from a fresh access check, never message
 * text. A receipt is committed before delivery, so transport failure can lose a
 * delivery but cannot admit the same (channel, message ID) again. No message
 * bodies, credentials or agent memory are stored. Existing tables are retained.
 */
import { createRequire } from 'node:module';
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';

export interface RoutingAccessPolicy {
  writeChannels: readonly string[];
  dmUsers: readonly string[];
  readJoinedChannels: boolean;
}
export type SenderKind = 'human' | 'bot' | 'unknown';
export interface AccessAdmission {
  version: 1;
  channelId: string;
  kind: 'channel' | 'private_channel' | 'dm';
  readable: true;
  joined?: true;
  dmPeer?: string;
}
export interface RoutingInput {
  channel: string;
  id: string;
  root: string;
  mentions: readonly string[];
  senderKind: SenderKind;
  authorId?: string;
  access: AccessAdmission;
  /** Independent, verified counterpart signal, not a synthetic mention. */
  dmAuthorizedPeer?: string;
}
export interface RoutingReceipt {
  routingVersion: 1;
  wakeAllowed: boolean;
  routingReason: 'authorized-human-dm' | 'human-mention' | 'peer-mention' | 'context-only';
  replyRoot: string;
  authority: 'human-source' | 'peer-not-owner';
  botUserId: string;
  mentionIds: string[];
  /** Unknown sources stay conservative for clients using this legacy boolean. */
  isBot: boolean;
  senderKind: SenderKind;
  authorId?: string;
  supportAccess: AccessAdmission;
  dmAuthorizedPeer?: string;
}
interface Statement {
  get(...args: unknown[]): Record<string, unknown> | undefined;
  all(...args: unknown[]): Array<Record<string, unknown>>;
  run(...args: unknown[]): unknown;
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
const USER = /^[UW][A-Z0-9]{1,63}$/;
const CHANNEL = /^[CGD][A-Z0-9]{1,63}$/;
const TS = /^\d{1,20}\.\d{1,10}$/;

function ids(value: unknown, pattern: RegExp, name: string, canonical = true): readonly string[] {
  if (!Array.isArray(value) || !value.every((id) => typeof id === 'string' && pattern.test(id))
      || new Set(value).size !== value.length) throw new Error(`Invalid routing ${name}`);
  return Object.freeze(canonical ? [...value].sort() : [...value]);
}
function copyPolicy(policy: RoutingAccessPolicy): Readonly<RoutingAccessPolicy> {
  if (!policy || typeof policy !== 'object' || typeof policy.readJoinedChannels !== 'boolean')
    throw new Error('Invalid routing access policy');
  return Object.freeze({
    writeChannels: ids(policy.writeChannels, /^[CG][A-Z0-9]{1,63}$/, 'write channels'),
    dmUsers: ids(policy.dmUsers, USER, 'DM users'), readJoinedChannels: policy.readJoinedChannels,
  });
}

export class RoutingLedger {
  private db: Database | undefined;
  readonly accessPolicy: Readonly<RoutingAccessPolicy>;

  /** namespace binds an installation/workspace independently from its channels.
   * An old ledger's anchor-channel string may be reused as namespace: the
   * existing identity(own_user,channel) and seen tables remain compatible.
   * Policy may change on restart without resetting any admission receipts.
   */
  constructor(path: string, readonly ownUserId: string, readonly namespace: string,
    accessPolicy: RoutingAccessPolicy) {
    if (typeof ownUserId !== 'string' || !USER.test(ownUserId) || typeof namespace !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(namespace))
      throw new Error('Invalid routing identity or namespace');
    this.accessPolicy = copyPolicy(accessPolicy);
    if (Number(process.versions.node.split('.')[0]) < 24 || typeof process.geteuid !== 'function')
      throw new Error('Durable recipient routing requires Node 24+ on a POSIX platform');
    // Deliberately lazy: legacy Node 22 startup does not require node:sqlite.
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string) => Database;
    };
    if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Routing state path must be absolute');
    const parentPath = dirname(path);
    if (lstatSync(parentPath).isSymbolicLink()) throw new Error('Routing state directory must not be a link');
    const parent = statSync(parentPath);
    if (!parent.isDirectory() || parent.uid !== process.geteuid() || (parent.mode & 0o077))
      throw new Error('Routing state directory must be private to this user');
    const canonicalPath = join(realpathSync(parentPath), basename(path));
    const fd = openSync(canonicalPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
    try {
      const file = fstatSync(fd);
      if (!file.isFile() || file.nlink !== 1 || file.uid !== process.geteuid() || (file.mode & 0o077))
        throw new Error('Routing state file must be a private regular file owned by this user');
    } finally { closeSync(fd); }
    const db = new DatabaseSync(canonicalPath);
    let transaction = false;
    try {
      db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
      transaction = true;
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
      if (tables.includes('identity')) {
        const identities = db.prepare('SELECT own_user,channel FROM identity').all();
        if (identities.length !== 1 || identities[0].own_user !== ownUserId || identities[0].channel !== namespace)
          throw new Error('Routing state belongs to another or invalid identity');
      } else {
        // Never silently take ownership of previously recorded, unbound state.
        if (tables.includes('seen') && db.prepare('SELECT 1 FROM seen LIMIT 1').get())
          throw new Error('Existing routing receipts have no identity binding');
        db.exec('CREATE TABLE identity(own_user TEXT, channel TEXT)');
        db.prepare('INSERT INTO identity VALUES (?,?)').run(ownUserId, namespace);
      }
      db.exec('CREATE TABLE IF NOT EXISTS seen(channel TEXT, id TEXT, PRIMARY KEY(channel,id)); COMMIT');
      transaction = false;
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL');
      this.db = db;
    } catch (error) {
      if (transaction) { try { db.exec('ROLLBACK'); } catch { /* keep original error */ } }
      db.close();
      throw error;
    }
  }

  /** Idempotent; never removes the database, receipts or unrelated tables. */
  close(): void {
    const db = this.db;
    this.db = undefined;
    db?.close();
  }

  receive(input: RoutingInput): RoutingReceipt | null {
    if (!this.db) throw new Error('Routing ledger is closed');
    if (!input || typeof input.channel !== 'string' || !CHANNEL.test(input.channel)
        || typeof input.id !== 'string' || !TS.test(input.id) || typeof input.root !== 'string' || !TS.test(input.root)
        || !['human', 'bot', 'unknown'].includes(input.senderKind)
        || (input.authorId !== undefined && (typeof input.authorId !== 'string' || !USER.test(input.authorId)))) throw new Error('Invalid routing message metadata');
    const mentions = [...ids(input.mentions, USER, 'mentions', false)];
    const access = input.access;
    if (!access || access.version !== 1 || access.channelId !== input.channel || access.readable !== true)
      throw new Error('Routing access admission missing or mismatched');
    let admission: AccessAdmission;
    if (access.kind === 'dm') {
      if (!input.channel.startsWith('D') || !access.dmPeer || !this.accessPolicy.dmUsers.includes(access.dmPeer))
        throw new Error('Routing DM peer is not authorized');
      admission = { version: 1, channelId: input.channel, readable: true, kind: 'dm', dmPeer: access.dmPeer };
    } else {
      if (!['channel', 'private_channel'].includes(access.kind) || access.joined !== true
          || !/^[CG]/.test(input.channel) || !this.accessPolicy.readJoinedChannels)
        throw new Error('Routing joined channel is not authorized');
      admission = { version: 1, channelId: input.channel, readable: true, kind: access.kind, joined: true };
    }
    if (input.dmAuthorizedPeer !== undefined && (typeof input.dmAuthorizedPeer !== 'string' || !USER.test(input.dmAuthorizedPeer)))
      throw new Error('Invalid routing DM counterpart signal');
    const dmAddressed = admission.kind === 'dm' && input.senderKind === 'human'
      && input.authorId === admission.dmPeer && input.dmAuthorizedPeer === admission.dmPeer;
    const mentioned = admission.kind !== 'dm' && mentions.includes(this.ownUserId);
    const receipt: RoutingReceipt = {
      routingVersion: 1, wakeAllowed: dmAddressed || mentioned,
      routingReason: dmAddressed ? 'authorized-human-dm' : mentioned
        ? input.senderKind === 'human' ? 'human-mention' : 'peer-mention'
        : 'context-only',
      replyRoot: input.root, botUserId: this.ownUserId, mentionIds: mentions,
      senderKind: input.senderKind, isBot: input.senderKind !== 'human',
      authority: input.senderKind === 'human' ? 'human-source' : 'peer-not-owner',
      ...(input.authorId !== undefined ? { authorId: input.authorId } : {}), supportAccess: admission,
      ...(dmAddressed ? { dmAuthorizedPeer: admission.dmPeer } : {}),
    };
    const db = this.db;
    db.exec('BEGIN IMMEDIATE');
    let transaction = true;
    try {
      if (db.prepare('SELECT 1 FROM seen WHERE channel=? AND id=?').get(input.channel, input.id)) {
        db.exec('COMMIT'); transaction = false;
        return null;
      }
      db.prepare('INSERT INTO seen VALUES (?,?)').run(input.channel, input.id);
      db.exec('COMMIT'); transaction = false;
      return receipt;
    } catch (error) {
      if (transaction) { try { db.exec('ROLLBACK'); } catch { /* keep original error */ } }
      throw error;
    }
  }
}
