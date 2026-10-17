/**
 * SlackAdapter — owns the Slack connection and all platform operations.
 *
 * Conversation IDs are Slack's immutable IDs (C… public, G… private,
 * D… DM) — names are mutable and never used for routing.
 *
 * Connectivity: Web API (xoxb- bot token) for calls, Socket Mode (xapp-
 * app-level token) for real-time events — no public webhook URL needed,
 * matching the stdio-spawned server model.
 *
 * Threads map to thread_ts: incoming messages carry their thread_ts, and
 * reply/publish routing posts into the thread of the referenced message
 * (top-level when the conversation isn't threaded).
 *
 * Typing: Slack has no typing indicator for bots outside RTM. channels/typing
 * is shown instead as a thread status ("is thinking…",
 * assistant.threads.setStatus, which works in channels with chat:write since
 * 2026-03) on the thread of the message being answered.
 *
 * Event handling salvaged from zulip-mcp PR #8's SlackAdapter.
 */

import { WebClient } from '@slack/web-api';
import { SocketModeClient } from '@slack/socket-mode';
import { SlackAccessPolicy, HISTORY_MEMBERSHIP_PROOF, type SlackAccessPolicyConfig } from './access-policy.js';
import {RoutingLedger, type AccessAdmission, type RoutingReceipt, type SenderKind} from './recipient-routing.js';
import type {RecipientRoutingConfig} from './configuration.js';
import {
  formatSlackText,
  extractSlackUserIds,
  resolveSlackUserNames,
  fetchSlackHistory,
  classifyExtension,
  MAX_ATTACHMENT_BYTES,
  reactionName,
  type AttachmentRef,
  type SlackHistoryMessage,
} from './content.js';

/** An acknowledgement reaction is removed after this, replied to or not. */
const ACK_TTL_MS = 10 * 60 * 1000;
/** A removal that failed without an answer from Slack is tried again after
 *  this, at most ACK_MAX_TRIES times in all. */
const ACK_RETRY_MS = 60 * 1000;
const ACK_MAX_TRIES = 5;
/** The host refreshes typing every few seconds; Slack keeps a thread status
 *  for 2 minutes, so it is set again only after this. */
const STATUS_REFRESH_MS = 60 * 1000;
const STATUS_TEXT = 'is thinking…';

/** The read scope conversations.list needs for each conversation type. */
const TYPE_SCOPE: Record<string, string> = {
  public_channel: 'channels:read',
  private_channel: 'groups:read',
  im: 'im:read',
  mpim: 'mpim:read',
};

type AckEntry = { timer: ReturnType<typeof setTimeout>; added: Promise<boolean>; tries: number };

/** Message subtypes that represent real user content. Everything else
 * (message_changed, message_deleted, channel_join, bot_message, …) is noise
 * for the inference loop. */
const CONTENT_SUBTYPES = new Set([undefined, 'file_share', 'thread_broadcast', 'me_message']);

/** The fields of a Socket Mode message event this adapter dereferences.
 * Payloads come off the wire — everything is optional until checked. */
interface SlackMessageEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  user?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  /** On a thread_broadcast the parent may be named only here. */
  root?: { thread_ts?: string };
  bot_id?: string;
  channel_type?: string;
  team?: string;
  files?: Array<{ id?: string; url_private?: string; name?: string; mimetype?: string }>;
}

/** The fields of a conversations.list/info entry this adapter dereferences —
 * structurally satisfied by @slack/web-api's Channel type. */
export interface SlackApiConversation {
  id?: string;
  name?: string;
  user?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_member?: boolean;
  is_archived?: boolean;
  num_members?: number;
  topic?: { value?: string };
}

export type ConversationKind = 'channel' | 'private_channel' | 'dm' | 'group_dm';

export interface SlackConversationInfo {
  id: string;
  kind: ConversationKind;
  /** Channel name, group-DM name, or the DM counterpart's display name. */
  name: string;
  /** DM counterpart user ID (dm only). */
  userId?: string;
  topic?: string;
  isMember: boolean;
  numMembers?: number;
}

export interface SlackMessageData {
  /** Slack conversation ID (C…/G…/D…). */
  channelId: string;
  /** Message ts — Slack's message ID within the conversation. */
  id: string;
  threadTs?: string;
  authorId: string;
  authorName: string;
  isBot?: boolean;
  senderKind?: SenderKind;
  authorBotId?: string;
  routing?: RoutingReceipt;
  /** Raw mrkdwn text as received. */
  content: string;
  /** Mentions resolved to @name (uid:U…), links/broadcasts unescaped. */
  cleanContent: string;
  /** User IDs mentioned as <@U…> in the text. */
  mentionIds: string[];
  /** Personal mention of the bot — @here/@channel broadcasts don't count. */
  mentionsBot: boolean;
  isDM: boolean;
  channelType?: string;
  teamId?: string;
  timestamp: Date;
  attachments: AttachmentRef[];
}

export interface HistoryMessage {
  id: string;
  authorId?: string;
  authorName: string;
  content: string;
  threadTs?: string;
  timestamp: Date;
  attachments: Array<{ fileId?: string; name: string; mimeType?: string; url?: string }>;
}

export interface SlackUserMatch {
  userId: string;
  username?: string;
  realName?: string;
  displayName?: string;
}

export interface SlackAdapterConfig {
  /** Opt-in deployment policy. Unset preserves the legacy operator controls. */
  accessPolicy?: SlackAccessPolicyConfig;
  recipientRouting?: RecipientRoutingConfig;
  botToken: string;
  appToken: string;
  /** When set, DMs from anyone not in this user-ID list are dropped. */
  dmUsers?: string[];
  /** Conversation-ID allow-list for every write (send, DM, edit, delete,
   *  reaction). Unset or empty = no restriction. */
  sendChannels?: string[];
  /** Drop incoming DMs and refuse DM sends and DM history reads. */
  disableDms?: boolean;
  /** Emoji name put on an addressed message while the agent works on it. */
  ackReaction?: string;
}

/**
 * Connect to Slack and build an adapter: auth.test resolves the bot's own
 * user ID (for self-filtering and mention detection), team name (for channel
 * labels), and token scopes used to narrow conversation listings. Socket
 * Mode is wired but not yet started — call start() after registering the
 * message handler.
 */
export async function connectSlack(config: SlackAdapterConfig): Promise<SlackAdapter> {
  const web = new WebClient(config.botToken);
  const auth = await web.auth.test();
  const socket = new SocketModeClient({ appToken: config.appToken });
  const adapter = new SlackAdapter(
    // WebClient satisfies SlackWebLike at runtime; the cast bridges the
    // parameter-width gap (SlackWebLike takes loose records so tests can
    // inject fakes, WebClient's methods want their exact argument types).
    web as unknown as SlackWebLike,
    socket,
    (auth.user_id as string | undefined) ?? null,
    (auth.team as string | undefined) ?? '',
    config.dmUsers,
    config.sendChannels,
    config.disableDms,
    config.ackReaction,
    // Granted scopes, from the x-oauth-scopes header of auth.test.
    (auth.response_metadata as { scopes?: string[] } | undefined)?.scopes,
  );
  if (config.accessPolicy) adapter.configureAccessPolicy(config.accessPolicy);
  if (config.recipientRouting) adapter.configureRecipientRouting(config.recipientRouting);
  return adapter;
}

/** The client surfaces the adapter needs — structural, so tests can inject fakes. */
export interface SlackWebLike {
  conversations: {
    list(args: Record<string, unknown>): Promise<{ channels?: unknown[]; response_metadata?: { next_cursor?: string; scopes?: string[] } }>;
    info(args: { channel: string }): Promise<{ channel?: unknown }>;
    open(args: { users: string }): Promise<{ channel?: { id?: string } }>;
    history(args: Record<string, unknown>): Promise<{ ok?: boolean; messages?: unknown[]; response_metadata?: { next_cursor?: string } }>;
    replies(args: Record<string, unknown>): Promise<{ messages?: unknown[]; response_metadata?: { next_cursor?: string } }>;
  };
  chat: {
    postMessage(args: Record<string, unknown>): Promise<{ ts?: string }>;
    update(args: Record<string, unknown>): Promise<unknown>;
    delete(args: Record<string, unknown>): Promise<unknown>;
  };
  reactions: {
    add(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
    remove(args: { channel: string; timestamp: string; name: string }): Promise<unknown>;
  };
  /** Optional so test fakes need not carry it; the real WebClient has it. */
  assistant?: {
    threads: { setStatus(args: { channel_id: string; thread_ts: string; status: string }): Promise<unknown> };
  };
  filesUploadV2?(args: Record<string, unknown>): Promise<{ files?: Array<{ files?: Array<{ id?: string }> }> }>;
  files?: {
    delete(args: { file: string }): Promise<unknown>;
    info?(args: { file: string }): Promise<{ file?: Record<string, unknown> }>;
  };
  users: {
    info(args: { user: string }): Promise<{ user?: { is_bot?: boolean; profile?: { display_name?: string }; real_name?: string; name?: string } }>;
    list(args: { limit?: number; cursor?: string }): Promise<{ members?: unknown[]; response_metadata?: { next_cursor?: string } }>;
  };
}

export interface SlackSocketLike {
  on(event: string, handler: (args: { event: SlackMessageEvent; ack: () => Promise<void> }) => void): void;
  start(): Promise<unknown>;
  disconnect(): Promise<unknown>;
}

export class SlackAdapter {
  private routingLedger?: RoutingLedger;
  get routing(): RoutingLedger | undefined { return this.routingLedger; }
  private accessConfig?: SlackAccessPolicyConfig;
  private botUsers = new Set<string>();
  private humanUsers = new Set<string>();
  private accessPolicy?: SlackAccessPolicy;
  /** Lets file helpers select strict association checks without exposing policy. */
  get hasExplicitAccessPolicy(): boolean { return this.accessPolicy !== undefined; }
  private userNameCache = new Map<string, string>();
  private messageHandlers: Array<(msg: SlackMessageData) => void> = [];
  private socketStarted = false;
  /** Conversations Slack reported as DMs or group DMs, and as channels. IDs
   *  alone don't tell them apart. */
  private dmIds = new Set<string>();
  private channelIds = new Set<string>();

  get dmsDisabled(): boolean {
    if (this.accessPolicy) return !this.accessPolicy.dmsWritable;
    return this.disableDms;
  }

  /** Can send_dm succeed at all? A DM ID starts with D. */
  get dmsWritable(): boolean {
    if (this.accessPolicy) return this.accessPolicy.dmsWritable;
    return !this.disableDms && (!this.sendChannels?.length || this.sendChannels.some((id) => id.startsWith('D')));
  }

  private stopping = false;

  constructor(
    private web: SlackWebLike,
    private socket: SlackSocketLike,
    readonly botUserId: string | null,
    readonly teamName: string,
    private dmUsers?: string[],
    private sendChannels?: string[],
    private disableDms = false,
    private ackReaction?: string,
    /** The bot token's scopes; undefined = unknown, ask for every type. */
    private scopes?: string[],
  ) {
    if (this.scopes) {
      const omitted = this.conversationTypes().filter((type) => !this.scopes!.includes(TYPE_SCOPE[type]));
      if (omitted.length) {
        console.error(`[slack-mcpl] Conversation listing omits types without a granted read scope: ${omitted.map((type) => `${type} (requires ${TYPE_SCOPE[type]})`).join(', ')}.`);
      }
    }
    // Register the handler at construction so start() ordering can't race
    // an early event past an unregistered listener.
    this.socket.on('message', ({ event, ack }) => {
      void (async () => {
        // Always ack first — Slack redelivers unacked envelopes.
        try { await ack(); } catch { /* ignore */ }
        try {
          await this.handleMessageEvent(event);
        } catch (error) {
          console.error('[slack-mcpl] Failed to handle Slack message event:', error);
        }
      })();
    });
  }

  onMessage(handler: (msg: SlackMessageData) => void): void {
    this.messageHandlers.push(handler);
  }

  /** Install before Socket Mode starts; membership itself is never cached. */
  configureAccessPolicy(config: SlackAccessPolicyConfig): void {
    if (this.socketStarted || this.accessPolicy) throw new Error('Slack access policy must be configured once before start');
    this.accessPolicy = new SlackAccessPolicy(config);
    this.accessConfig = {readJoinedChannels: config.readJoinedChannels,
      writeChannels: [...config.writeChannels], dmUsers: [...config.dmUsers]};
  }

  /** Install once after Slack authentication and explicit policy, before start.
   * Each agent supplies its own private state file and installation namespace. */
  configureRecipientRouting(config: RecipientRoutingConfig): void {
    if (this.socketStarted || this.routingLedger || !this.accessConfig || !this.botUserId)
      throw new Error('Recipient routing requires authenticated identity and explicit access policy before start');
    if (config.expectedBotUserId !== undefined && config.expectedBotUserId !== this.botUserId)
      throw new Error('Authenticated Slack recipient identity differs from configuration');
    this.routingLedger = new RoutingLedger(config.stateFile, this.botUserId, config.namespace, this.accessConfig);
  }

  /** Open the Socket Mode connection. Resolves once connected. */
  async start(): Promise<void> {
    if (this.socketStarted) return;
    await this.socket.start();
    this.socketStarted = true;
  }

  async stop(): Promise<void> {
    // Best effort: take our reactions off before going away. A crash or kill
    // cannot, and leaves them on Slack. No new ones while that runs.
    this.stopping = true;
    await Promise.all([...this.ackPending.keys()].map((c) => this.clearAck(c)));
    if (this.socketStarted) {
      await this.socket.disconnect().catch(() => {});
      this.socketStarted = false;
    }
    this.routingLedger?.close();
  }

  // ── Conversations ──

  private conversationTypes(): string[] {
    if (this.accessPolicy) return this.accessPolicy.dmsWritable ? ['public_channel', 'private_channel', 'im'] : ['public_channel', 'private_channel'];
    return this.disableDms ? ['public_channel', 'private_channel'] : Object.keys(TYPE_SCOPE);
  }

  /** Enumerate conversations the bot can act in: member channels, DMs, and
   *  group DMs, limited to types whose read scopes the token reports. Each
   *  response refreshes those scopes for the next listing; missing metadata
   *  retains the last known scopes, and unknown scopes keep the legacy request
   *  for every enabled type. conversations.list also returns public channels
   *  the bot is NOT a member of (no events, no posting without joining) — those
   *  are excluded here; list_channels with includeNonMember surfaces them. */
  async listConversations(includeNonMember = false): Promise<SlackConversationInfo[]> {
    const out: SlackConversationInfo[] = [];
    for (const id of this.accessPolicy?.historyMembershipFallbacks(this.scopes) ?? []) {
      const info = await this.describeConversation(await this.readAccessConversation(id));
      if (info) out.push(info);
    }
    // Slack refuses the whole call when one type lacks its read scope.
    // Keep the type set stable across pagination; refreshed scopes apply to
    // the next listing rather than changing the meaning of an existing cursor.
    const types = this.conversationTypes()
      .filter((type) => this.scopes ? this.scopes.includes(TYPE_SCOPE[type]) : !this.accessPolicy)
      .join(',');
    // An empty types value has undocumented behavior; do not rely on Slack's
    // default public_channel listing when no readable type is available.
    if (!types) return out;
    let cursor: string | undefined;
    do {
      const result = await this.web.conversations.list({
        types,
        exclude_archived: true,
        limit: 200,
        cursor,
      });
      const scopes = result.response_metadata?.scopes;
      if (Array.isArray(scopes) && scopes.every((scope) => typeof scope === 'string')) {
        this.scopes = [...scopes];
      }
      for (let raw of (result.channels ?? []) as SlackApiConversation[]) {
        if (out.some((info) => info.id === raw.id)) continue;
        if (this.accessPolicy) {
          if (!raw.id) continue;
          try { raw = await this.readAccessConversation(raw.id); } catch { continue; }
        }
        const info = await this.describeConversation(raw);
        if (!info) continue;
        if ((!includeNonMember || this.accessPolicy) && info.kind === 'channel' && !info.isMember) continue;
        out.push(info);
      }
      cursor = result.response_metadata?.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  async getConversationMeta(channelId: string): Promise<SlackConversationInfo | null> {
    if (this.accessPolicy) return this.describeConversation(await this.readAccessConversation(channelId));
    const info = await this.web.conversations.info({ channel: channelId });
    return this.describeConversation((info.channel ?? {}) as SlackApiConversation);
  }

  private async readAccessConversation(channelId: string): Promise<SlackApiConversation> {
    if (!this.accessPolicy) throw new Error('Slack access policy is not configured');
    if (!/^[CGD][A-Z0-9]+$/.test(channelId)) throw new Error('Invalid Slack conversation ID');
    if (!Array.isArray(this.scopes)) throw new Error('Slack scope metadata is unavailable');
    if (this.accessPolicy.usesHistoryMembershipFallback(channelId, this.scopes)) {
      this.accessPolicy.requireScope(this.scopes, 'channels:history');
      // Bot tokens can read history only for conversations they belong to.
      // Never cache this proof or add channels:read to reported token scopes.
      const result = await this.web.conversations.history({ channel: channelId, limit: 1 });
      if (result.ok !== true) throw new Error(`Could not freshly confirm membership of ${channelId}`);
      const conversation: SlackApiConversation & { [HISTORY_MEMBERSHIP_PROOF]: true } = {
        id: channelId, name: channelId, is_im: false, is_mpim: false,
        is_private: false, is_member: true, [HISTORY_MEMBERSHIP_PROOF]: true,
      };
      this.accessPolicy.requireReadable(channelId, conversation, this.scopes);
      return conversation;
    }
    const result = await this.web.conversations.info({ channel: channelId });
    const conversation = result.channel as SlackApiConversation | undefined;
    this.accessPolicy.requireReadable(channelId, conversation, this.scopes);
    return conversation!;
  }

  /** Used by file association checks as well as history reads. */
  async requireReadableConversation(channelId: string): Promise<void> {
    if (this.accessPolicy) { await this.readAccessConversation(channelId); return; }
    await this.assertNotDm(channelId);
  }

  private async requireHistoryConversation(channelId: string): Promise<SlackApiConversation | undefined> {
    if (!this.accessPolicy) { await this.assertNotDm(channelId); return; }
    const conversation = await this.readAccessConversation(channelId);
    this.accessPolicy.requireScope(this.scopes, conversation.is_im ? 'im:history' : conversation.is_private ? 'groups:history' : 'channels:history');
    return conversation;
  }

  private async requireWritableConversation(channelId: string, scope: string): Promise<SlackApiConversation | undefined> {
    let conversation: SlackApiConversation | undefined;
    if (this.accessPolicy) {
      conversation = await this.readAccessConversation(channelId);
      this.accessPolicy.requireWritable(channelId, conversation, this.scopes, scope);
    }
    this.assertWritable(channelId);
    return conversation;
  }

  /** Fetch metadata only. Callers must validate readable conversation shares
   * before fetching bytes; a file ID alone is not permission to download. */
  async getFileInfo(fileId: string): Promise<Record<string, unknown>> {
    if (!/^F[A-Z0-9]+$/.test(fileId)) throw new Error('Invalid Slack file ID');
    this.accessPolicy?.requireScope(this.scopes, 'files:read');
    if (!this.web.files?.info) throw new Error('File metadata is not available');
    const result = await this.web.files.info({ file: fileId });
    if (!result.file || result.file.id !== fileId) throw new Error('Slack returned missing or mismatched file metadata');
    return result.file;
  }

  private async describeConversation(conv: SlackApiConversation): Promise<SlackConversationInfo | null> {
    if (!conv.id) return null;
    if (conv.is_im) {
      // DM: label with the human's name so the host can scope/whitelist it.
      await this.resolveUserNames([conv.user]);
      const userName = (conv.user ? this.userNameCache.get(conv.user) : undefined) ?? conv.user ?? conv.id;
      this.dmIds.add(conv.id);
      return { id: conv.id, kind: 'dm', name: userName, userId: conv.user, isMember: true };
    }
    if (conv.is_mpim) {
      this.dmIds.add(conv.id);
      return { id: conv.id, kind: 'group_dm', name: conv.name ?? conv.id, isMember: true };
    }
    // Cached as a channel only when Slack says outright it is neither kind of DM.
    if (conv.is_im === false && conv.is_mpim === false) this.channelIds.add(conv.id);
    return {
      id: conv.id,
      kind: conv.is_private ? 'private_channel' : 'channel',
      name: conv.name ?? conv.id,
      topic: conv.topic?.value || undefined,
      isMember: !!conv.is_member,
      numMembers: conv.num_members,
    };
  }

  // ── Messaging ──

  /** Slack scopes are workspace-wide, so "speak only here" is enforced here:
   *  the one place every write passes through. */
  canWrite(channelId: string): boolean {
    if (this.accessPolicy && !this.accessPolicy.mayWrite(channelId)) return false;
    return !this.sendChannels?.length || this.sendChannels.includes(channelId);
  }

  private assertWritable(channelId: string): void {
    if (!this.canWrite(channelId)) {
      throw new Error(
        `Writing to ${channelId} is not allowed: this bot may only write to ${this.sendChannels?.join(', ')} (SLACK_SEND_CHANNELS)`,
      );
    }
  }

  // ── Acknowledgement reaction ──
  // Slack has no typing indicator for bots, so "received" is shown as a
  // reaction on the message that addressed the bot, removed when the bot next
  // posts in that conversation or after ACK_TTL_MS, whichever comes first.

  /** `added` settles once reactions.add has, so a removal never overtakes it. */
  private ackPending = new Map<string, Map<string, AckEntry>>();

  private armAck(channelId: string, ts: string, ms: number): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => void this.clearAck(channelId, ts), ms);
    timer.unref?.();
    return timer;
  }

  /** Forget `entry`, unless a newer entry has taken its place. */
  private dropAck(channelId: string, ts: string, entry: AckEntry): void {
    const pending = this.ackPending.get(channelId);
    if (!pending || pending.get(ts) !== entry) return;
    clearTimeout(entry.timer);
    pending.delete(ts);
    if (pending.size === 0) this.ackPending.delete(channelId);
  }

  // ── Thread status ──

  /** Per conversation, the thread showing our status and when it was set. */
  private statusOn = new Map<string, { ts: string; at: number }>();
  private recipientStatusOperations = new Map<string, Promise<void>>();

  /** Optional frozen-target status path. A delayed stop for one turn must not
   * clear another turn's thread status. Legacy status behavior is unchanged. */
  async setRecipientThreadStatus(channelId: string, root: string, stop: boolean, isCurrent = () => true): Promise<void> {
    const previous = this.recipientStatusOperations.get(channelId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      if (!isCurrent()) return;
      if (!stop) await this.setThreadStatus(channelId, root, isCurrent);
      else if (this.statusOn.get(channelId)?.ts === root) await this.setThreadStatus(channelId, undefined, isCurrent);
    });
    this.recipientStatusOperations.set(channelId, operation);
    try { await operation; }
    finally { if (this.recipientStatusOperations.get(channelId) === operation) this.recipientStatusOperations.delete(channelId); }
  }

  /** Show "is thinking…" on thread `threadTs` of `channelId`, or clear the
   *  conversation's status when `threadTs` is undefined. Moving to another
   *  thread clears the old one. Only where the bot may write: a status in a
   *  read-only conversation would tell its readers the bot is reading.
   *  Best-effort: never throws. */
  async setThreadStatus(channelId: string, threadTs: string | undefined, isCurrent = () => true): Promise<void> {
    if (!isCurrent()) return;
    const cur = this.statusOn.get(channelId);
    if (threadTs && cur?.ts === threadTs && Date.now() - cur.at < STATUS_REFRESH_MS) return;
    if (cur && cur.ts !== threadTs) {
      this.statusOn.delete(channelId);
      await this.callStatus(channelId, cur.ts, '', isCurrent);
    }
    if (!threadTs || !this.canWrite(channelId) || !isCurrent()) return;
    if (!this.accessPolicy && this.disableDms && (this.dmIds.has(channelId) || channelId.startsWith('D'))) return;
    this.statusOn.set(channelId, { ts: threadTs, at: Date.now() });
    if (!(await this.callStatus(channelId, threadTs, STATUS_TEXT, isCurrent))) this.statusOn.delete(channelId);
  }

  private async callStatus(channelId: string, threadTs: string, status: string, isCurrent = () => true): Promise<boolean> {
    if (!this.web.assistant) return false;
    try {
      if (this.accessPolicy) await this.requireWritableConversation(channelId, 'chat:write');
      if (!isCurrent()) return false;
      await this.web.assistant.threads.setStatus({ channel_id: channelId, thread_ts: threadTs, status });
      return true;
    } catch (err) {
      console.error(`[slack-mcpl] thread status on ${channelId} failed:`, (err as Error).message);
      return false;
    }
  }

  /** Mark an addressed message as received. Best-effort: never throws. */
  async acknowledge(channelId: string, ts: string): Promise<void> {
    if (!this.ackReaction || this.stopping) return;
    if (this.ackPending.get(channelId)?.has(ts)) return; // Slack delivered the event twice
    const added = this.addReaction(channelId, ts, this.ackReaction).then(() => true, () => false);
    // Recorded before the add resolves, so a reply that lands first still removes it.
    let pending = this.ackPending.get(channelId);
    if (!pending) this.ackPending.set(channelId, (pending = new Map()));
    const entry: AckEntry = { timer: this.armAck(channelId, ts, ACK_TTL_MS), added, tries: 0 };
    pending.set(ts, entry);
    if (!(await added)) this.dropAck(channelId, ts, entry); // not writable here, or Slack refused
  }

  /** Remove the reaction from one message, or from every pending message in the
   *  conversation. A removal that failed without an answer from Slack (rate
   *  limit, HTTP or network error) is tried again; one Slack refused is not. */
  async clearAck(channelId: string, ts?: string): Promise<void> {
    const pending = this.ackPending.get(channelId);
    if (!pending || !this.ackReaction) return;
    const targets = ts === undefined ? [...pending.keys()] : pending.has(ts) ? [ts] : [];
    await Promise.all(targets.map(async (t) => {
      const entry = pending.get(t);
      if (!entry) return;
      clearTimeout(entry.timer);
      if (!(await entry.added)) return this.dropAck(channelId, t, entry);
      try {
        if (this.accessPolicy) await this.requireWritableConversation(channelId, 'reactions:write');
        await this.web.reactions.remove({ channel: channelId, timestamp: t, name: this.ackReaction! });
        this.dropAck(channelId, t, entry);
      } catch (err) {
        // Slack's own answer (data.error) will be the same next time.
        const answered = !!(err as { data?: { error?: string } }).data?.error;
        if (answered || ++entry.tries >= ACK_MAX_TRIES) this.dropAck(channelId, t, entry);
        else entry.timer = this.armAck(channelId, t, ACK_RETRY_MS);
      }
    }));
  }

  async sendMessage(
    channelId: string,
    text: string,
    opts: { threadTs?: string } = {},
  ): Promise<{ messageId: string }> {
    await this.requireWritableConversation(channelId, 'chat:write');
    await this.assertNotDm(channelId);
    return this.postValidatedMessage(channelId, text, opts);
  }

  private async postValidatedMessage(channelId: string, text: string, opts: { threadTs?: string } = {}): Promise<{ messageId: string }> {
    const result = await this.web.chat.postMessage({
      channel: channelId,
      text,
      ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
    });
    void this.clearAck(channelId);
    // Slack clears a thread's status when the bot posts in that thread.
    if (opts.threadTs && this.statusOn.get(channelId)?.ts === opts.threadTs) this.statusOn.delete(channelId);
    return { messageId: result.ts ? String(result.ts) : '' };
  }

  /** Upload a file (files.getUploadURLExternal + completeUploadExternal).
   *  Same write checks as sendMessage. Needs the files:write scope. */
  async uploadFile(
    channelId: string,
    file: { filename: string; data: Buffer; title?: string; comment?: string; threadTs?: string },
  ): Promise<{ fileId: string }> {
    if (!Buffer.isBuffer(file.data)) throw new Error('File upload requires bounded bytes, not a raw path');
    if (file.data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('File upload exceeds the 5 MiB byte limit');
    await this.requireWritableConversation(channelId, 'files:write');
    await this.assertNotDm(channelId);
    if (!this.web.filesUploadV2) throw new Error('File upload is not available');
    const result = await this.web.filesUploadV2({
      channel_id: channelId,
      file: file.data,
      filename: file.filename,
      title: file.title ?? file.filename,
      ...(file.comment ? { initial_comment: file.comment } : {}),
      ...(file.threadTs ? { thread_ts: file.threadTs } : {}),
    });
    const fileId = result.files?.[0]?.files?.[0]?.id;
    if (typeof fileId !== 'string' || !fileId.trim()) {
      throw new Error("Slack's upload response named no file with a valid ID; the upload could not be confirmed");
    }
    void this.clearAck(channelId);
    return { fileId };
  }

  /** With SLACK_DISABLE_DMS, only a conversation Slack confirmed to be a
   *  channel may be written to or read. Every write path and both history
   *  reads call this. An ID is not enough: a group DM ID looks like a channel
   *  ID, and a user ID (U…) posts into that user's DM. An unknown ID is asked
   *  about until Slack confirms it; if Slack cannot say, it is refused. */
  private async assertNotDm(channelId: string): Promise<void> {
    // Callers with the explicit policy already performed a fresh access check.
    if (this.accessPolicy) return;
    if (!this.disableDms || this.channelIds.has(channelId)) return;
    const refuse = (why: string) =>
      new Error(`Conversation ${channelId} ${why}; direct messages are disabled for this bot (SLACK_DISABLE_DMS)`);
    if (this.dmIds.has(channelId) || channelId.startsWith('D')) throw refuse('is a DM');
    try {
      await this.getConversationMeta(channelId); // fills channelIds for this very ID, or not
    } catch (err) {
      throw refuse(`could not be confirmed as a channel (${(err as Error).message})`);
    }
    if (!this.channelIds.has(channelId)) throw refuse('is not a channel');
  }

  async sendDM(userId: string, text: string): Promise<{ messageId: string; channelId: string }> {
    if (this.accessPolicy) {
      this.accessPolicy.requireDmUser(userId); // before conversations.open
      this.accessPolicy.requireScope(this.scopes, 'im:write');
      const open = await this.web.conversations.open({ users: userId });
      const channelId = open.channel?.id;
      if (!channelId) throw new Error(`Could not open a DM with user ${userId}`);
      const conversation = await this.requireWritableConversation(channelId, 'chat:write');
      if (!conversation) throw new Error('Opened DM access could not be confirmed');
      if (conversation.is_im !== true || conversation.user !== userId) throw new Error('Opened DM does not match the allowed peer');
      const { messageId } = await this.postValidatedMessage(channelId, text);
      return { messageId, channelId };
    }
    if (this.disableDms) throw new Error('Direct messages are disabled for this bot (SLACK_DISABLE_DMS)');
    // A DM ID starts with D. If the allow-list names none, no DM can be written,
    // so don't open one just to find that out.
    if (this.sendChannels?.length && !this.sendChannels.some((id) => id.startsWith('D'))) {
      throw new Error('Writing to a direct message is not allowed: SLACK_SEND_CHANNELS lists no DM conversation');
    }
    const open = await this.web.conversations.open({ users: userId });
    const channelId = open.channel?.id;
    if (!channelId) throw new Error(`Could not open a DM with user ${userId}`);
    const { messageId } = await this.sendMessage(channelId, text);
    return { messageId, channelId };
  }

  async editMessage(channelId: string, ts: string, text: string): Promise<void> {
    await this.requireWritableConversation(channelId, 'chat:write');
    await this.assertNotDm(channelId);
    await this.web.chat.update({ channel: channelId, ts, text });
  }

  async deleteMessage(channelId: string, ts: string): Promise<void> {
    await this.requireWritableConversation(channelId, 'chat:write');
    await this.assertNotDm(channelId);
    await this.web.chat.delete({ channel: channelId, ts });
  }

  /** Remove a file uploaded by this bot, retaining its destination write guards. */
  async deleteUploadedFile(channelId: string, fileId: string): Promise<void> {
    await this.requireWritableConversation(channelId, 'files:write');
    await this.assertNotDm(channelId);
    if (!this.web.files) throw new Error('File deletion is not available');
    await this.web.files.delete({ file: fileId });
  }

  async addReaction(channelId: string, ts: string, emoji: string): Promise<void> {
    await this.requireWritableConversation(channelId, 'reactions:write');
    await this.assertNotDm(channelId);
    await this.web.reactions.add({ channel: channelId, timestamp: ts, name: reactionName(emoji) });
  }

  // ── History ──

  /** Channel-level history, oldest-first. Thread replies are NOT included
   *  (Slack requires conversations.replies per thread — see fetchThread). */
  async fetchHistory(
    channelId: string,
    opts: { limit?: number; oldest?: string; latest?: string } = {},
  ): Promise<{ messages: HistoryMessage[]; truncated: boolean }> {
    await this.requireHistoryConversation(channelId);
    const { messages, truncated } = await fetchSlackHistory(this.web, {
      channel: channelId,
      ...(opts.oldest !== undefined ? { oldest: opts.oldest } : {}),
      ...(opts.latest !== undefined ? { latest: opts.latest } : {}),
      maxMessages: opts.limit ?? 50,
    });
    return { messages: await this.shapeHistory(messages), truncated };
  }

  /** All replies in a thread (the parent message is included first). */
  async fetchThread(
    channelId: string,
    threadTs: string,
    limit = 100,
  ): Promise<{ messages: HistoryMessage[]; truncated: boolean }> {
    await this.requireHistoryConversation(channelId);
    const collected: SlackHistoryMessage[] = [];
    let cursor: string | undefined;
    let truncated = false;
    do {
      const result = await this.web.conversations.replies({
        channel: channelId,
        ts: threadTs,
        limit: Math.min(200, limit - collected.length),
        cursor,
      });
      collected.push(...((result.messages ?? []) as SlackHistoryMessage[]));
      cursor = result.response_metadata?.next_cursor || undefined;
      if (cursor && collected.length >= limit) {
        truncated = true;
        cursor = undefined;
      }
    } while (cursor);
    // conversations.replies returns oldest-first already.
    return { messages: await this.shapeHistory(collected), truncated };
  }

  private async shapeHistory(messages: SlackHistoryMessage[]): Promise<HistoryMessage[]> {
    // Pre-resolve author + mentioned user names in one pass.
    const ids = new Set<string>();
    for (const msg of messages) {
      if (msg.user) ids.add(msg.user);
      for (const id of extractSlackUserIds(msg.text ?? '')) ids.add(id);
    }
    await this.resolveUserNames(Array.from(ids));

    return messages.map((msg) => ({
      id: String(msg.ts ?? ''),
      authorId: msg.user,
      authorName: msg.user ? (this.userNameCache.get(msg.user) ?? msg.user) : (msg.username ?? 'bot'),
      content: formatSlackText(msg.text ?? '', this.userNameCache),
      threadTs: msg.thread_ts && msg.thread_ts !== msg.ts ? msg.thread_ts : undefined,
      timestamp: new Date(parseFloat(msg.ts ?? '0') * 1000),
      attachments: (msg.files ?? []).map((f) => ({
        ...(typeof f.id === 'string' && /^F[A-Z0-9]+$/.test(f.id) ? { fileId: f.id } : {}),
        name: f.name ?? 'attachment',
        mimeType: f.mimetype,
        url: f.url_private,
      })),
    }));
  }

  // ── Users ──

  async findUsers(query: string, max = 25): Promise<SlackUserMatch[]> {
    this.accessPolicy?.requireScope(this.scopes, 'users:read');
    const q = query.toLowerCase();
    if (!q) throw new Error('query is required');
    const matches: SlackUserMatch[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.web.users.list({ limit: 200, cursor });
      for (const raw of (result.members ?? []) as Array<{
        id?: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean;
        profile?: { display_name?: string };
      }>) {
        if (!raw.id || raw.deleted || raw.is_bot) continue;
        const name = raw.name?.toLowerCase() ?? '';
        const realName = raw.real_name?.toLowerCase() ?? '';
        const displayName = raw.profile?.display_name?.toLowerCase() ?? '';
        if (name.includes(q) || realName.includes(q) || displayName.includes(q)) {
          matches.push({
            userId: raw.id,
            username: raw.name,
            realName: raw.real_name,
            displayName: raw.profile?.display_name,
          });
          if (matches.length >= max) break;
        }
      }
      cursor = matches.length >= max
        ? undefined
        : (result.response_metadata?.next_cursor || undefined);
    } while (cursor);
    return matches;
  }

  // ── Incoming events ──

  private async handleMessageEvent(event: SlackMessageEvent): Promise<void> {
    if (!event || event.type !== 'message') return;
    if (!CONTENT_SUBTYPES.has(event.subtype) && !(this.routing && event.subtype === 'bot_message')) return;
    // Self-filter: skip our own messages and other bots' (bot_id covers
    // bot_message-without-subtype edge cases like app-posted file shares).
    if (event.bot_id && !this.routing) return;
    if (this.botUserId !== null && event.user === this.botUserId) return;
    // A real user content message always carries channel, user, and ts;
    // a malformed payload missing any of them is dropped, not crashed on
    // (parseFloat(undefined) → NaN → toISOString() throws).
    if (!event.channel || !event.user || !event.ts) return;

    let supportAccess: AccessAdmission | undefined;
    if (this.accessPolicy) {
      // Fresh admission precedes dedup and any wake decision.
      const conversation = await this.requireHistoryConversation(event.channel);
      if (conversation?.is_im && conversation.user !== event.user) return;
      supportAccess = {version: 1, channelId: event.channel, readable: true,
        kind: conversation!.is_im ? 'dm' : conversation!.is_private ? 'private_channel' : 'channel',
        ...(conversation!.is_im ? {dmPeer: conversation!.user} : {joined: true as const})};
    }

    const isDM = supportAccess ? supportAccess.kind === 'dm' : event.channel_type === 'im' || event.channel.startsWith('D');
    // Only what Slack marks as a channel gets through, not merely what isn't marked a DM.
    if (!this.accessPolicy && this.disableDms && event.channel_type !== 'channel' && event.channel_type !== 'group') return;
    if (!this.accessPolicy && isDM && this.dmUsers && this.dmUsers.length > 0 && !this.dmUsers.includes(event.user)) {
      return; // DM whitelist active and this sender isn't on it
    }

    // Resolve author + mentioned users before formatting.
    const mentionIds = extractSlackUserIds(event.text ?? '');
    await this.resolveUserNames([event.user, ...mentionIds]);
    const authorName = this.userNameCache.get(event.user) ?? event.user;
    const senderKind: SenderKind = event.bot_id || event.subtype === 'bot_message' || this.botUsers.has(event.user)
      ? 'bot' : this.humanUsers.has(event.user) || !this.routing ? 'human' : 'unknown';
    const routing = this.routing?.receive({channel: event.channel, id: event.ts,
      root: event.thread_ts || event.root?.thread_ts || event.ts, senderKind, authorId: event.user,
      mentions: mentionIds, access: supportAccess!,
      ...(supportAccess?.kind === 'dm' && senderKind === 'human' ? {dmAuthorizedPeer: event.user} : {})});
    if (this.routing && routing === null) return;

    const attachments: AttachmentRef[] = (event.files ?? [])
      .filter((f) => this.hasExplicitAccessPolicy || !!f.url_private)
      .map((f) => {
        const name = f.name ?? 'attachment';
        const mime = f.mimetype || classifyExtension(name).mimeType;
        return {
          ...(typeof f.id === 'string' && /^F[A-Z0-9]+$/.test(f.id) ? { fileId: f.id } : {}),
          path: f.url_private ?? '', // needs Bearer bot-token auth to fetch
          name,
          mimeType: mime,
          isImage: mime.startsWith('image/'),
        };
      });

    const msg: SlackMessageData = {
      channelId: event.channel,
      id: String(event.ts),
      threadTs: event.thread_ts || event.root?.thread_ts || undefined,
      authorId: String(event.user),
      authorName,
      ...(routing ? {routing, isBot: senderKind !== 'human', senderKind,
        ...(event.bot_id ? {authorBotId: event.bot_id} : {})} : {}),
      content: event.text ?? '',
      cleanContent: formatSlackText(event.text ?? '', this.userNameCache),
      mentionIds,
      // Personal mention of the bot — hosts use this to gate wake policy.
      // @here/@channel broadcasts deliberately don't count.
      mentionsBot: this.botUserId !== null && mentionIds.includes(this.botUserId),
      isDM,
      channelType: event.channel_type,
      teamId: event.team,
      timestamp: new Date(parseFloat(event.ts) * 1000),
      attachments,
    };

    for (const handler of this.messageHandlers) handler(msg);
  }

  /** Resolve user IDs into this adapter's cache (shared logic in content.ts). */
  private async resolveUserNames(userIds: Array<string | undefined>): Promise<void> {
    await resolveSlackUserNames(
      {users: {info: async (args) => {
        const info = await this.web.users.info(args);
        if (info.user?.is_bot === true) this.botUsers.add(args.user);
        if (info.user?.is_bot === false) this.humanUsers.add(args.user);
        return info;
      }}},
      this.userNameCache,
      userIds.filter((id): id is string => !!id),
    );
  }
}
