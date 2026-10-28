/** Explicit deployment access: discovery, readable membership and writable
 * destinations are separate. No Slack calls or cached membership live here. */
export interface SlackAccessPolicyConfig {
  writeChannels: string[];
  dmUsers: string[];
  readJoinedChannels: boolean;
  /** Exact write destinations the operator has verified are public. History
   * proves fresh bot membership only when channels:read is unavailable; a C
   * prefix or successful history request cannot establish public visibility. */
  historyMembershipFallbackChannels?: string[];
  /** Exact group DM (mpim) IDs the bot may read while a member. Missing or
   * empty denies every group DM. Writing also needs the ID in writeChannels. */
  groupDms?: string[];
}

/** In-process proof only: JSON, message text and Slack metadata cannot mint it. */
export const HISTORY_MEMBERSHIP_PROOF: unique symbol = Symbol('Slack bot history membership');

export interface AccessConversation {
  [HISTORY_MEMBERSHIP_PROOF]?: true;
  id?: string;
  user?: string;
  is_im?: boolean;
  is_mpim?: boolean;
  is_private?: boolean;
  is_member?: boolean;
}

export class SlackAccessPolicy {
  private readonly writeChannels: ReadonlySet<string>;
  private readonly dmUsers: ReadonlySet<string>;
  private readonly readJoinedChannels: boolean;
  private readonly historyFallbackChannels: ReadonlySet<string>;
  private readonly groupDms: ReadonlySet<string>;

  constructor(config: SlackAccessPolicyConfig) {
    if (!Array.isArray(config.writeChannels) || !config.writeChannels.every((id) => typeof id === 'string' && /^[CG][A-Z0-9]+$/.test(id))
        || !Array.isArray(config.dmUsers) || !config.dmUsers.every((id) => typeof id === 'string' && /^[UW][A-Z0-9]+$/.test(id))
        || typeof config.readJoinedChannels !== 'boolean') throw new Error('Invalid Slack access policy');
    this.writeChannels = new Set(config.writeChannels);
    this.dmUsers = new Set(config.dmUsers);
    this.readJoinedChannels = config.readJoinedChannels;
    const fallback = config.historyMembershipFallbackChannels ?? [];
    if (!Array.isArray(fallback) || !fallback.every((id) => typeof id === 'string'
        && /^C[A-Z0-9]+$/.test(id) && this.writeChannels.has(id))) throw new Error('History membership fallback must name pinned public write channels');
    this.historyFallbackChannels = new Set(fallback);
    const groupDms = config.groupDms ?? [];
    if (!Array.isArray(groupDms) || !groupDms.every((id) => typeof id === 'string' && /^[CG][A-Z0-9]+$/.test(id))) throw new Error('Group DMs must be conversation IDs');
    this.groupDms = new Set(groupDms);
  }

  historyMembershipFallbacks(scopes: readonly string[] | undefined): string[] {
    if (!Array.isArray(scopes) || scopes.includes('channels:read') || !this.readJoinedChannels) return [];
    return [...this.historyFallbackChannels];
  }

  usesHistoryMembershipFallback(channelId: string, scopes: readonly string[] | undefined): boolean {
    return this.historyMembershipFallbacks(scopes).includes(channelId);
  }

  get dmsWritable(): boolean { return this.dmUsers.size > 0; }

  get groupDmsReadable(): boolean { return this.groupDms.size > 0; }

  /** A synchronous configuration hint, never an authorization decision. */
  mayWrite(channelId: string): boolean {
    return this.writeChannels.has(channelId) || (channelId.startsWith('D') && this.dmsWritable);
  }

  requireScope(scopes: readonly string[] | undefined, needed: string): void {
    if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === 'string') || !scopes.includes(needed)) throw new Error(`Slack access requires granted scope ${needed}`);
  }

  requireDmUser(userId: string): void {
    if (!this.dmUsers.has(userId)) throw new Error(`Direct messages with ${userId} are not allowed by the Slack access policy`);
  }

  /** Require exact, fresh metadata. A group DM is readable only as a member
   * and only when groupDms names it. */
  requireReadable(channelId: string, conversation: AccessConversation | undefined, scopes: readonly string[] | undefined): 'channel' | 'private_channel' | 'dm' | 'group_dm' {
    if (conversation?.is_mpim === true && conversation.is_im !== true && conversation.id === channelId
        && /^[CG][A-Z0-9]+$/.test(channelId) && this.groupDms.has(channelId) && conversation.is_member === true) {
      this.requireScope(scopes, 'mpim:read');
      return 'group_dm';
    }
    if (!conversation || conversation.id !== channelId || conversation.is_mpim === true) {
      throw new Error(`Conversation ${channelId} has missing or unsupported membership metadata${conversation?.is_mpim === true ? ' (a group DM must be a joined one named in groupDms)' : ''}`);
    }
    if (conversation.is_im === true) {
      if ((conversation.is_mpim !== undefined && conversation.is_mpim !== false)
          || !/^D[A-Z0-9]+$/.test(channelId) || typeof conversation.user !== 'string') throw new Error(`Conversation ${channelId} has invalid DM metadata`);
      this.requireScope(scopes, 'im:read');
      this.requireDmUser(conversation.user);
      return 'dm';
    }
    if (conversation.is_im !== false || conversation.is_mpim !== false || typeof conversation.is_private !== 'boolean'
        || !/^[CG][A-Z0-9]+$/.test(channelId) || conversation.is_member !== true || !this.readJoinedChannels) {
      throw new Error(`Conversation ${channelId} is not a confirmed joined channel`);
    }
    if (conversation.is_private === false && conversation[HISTORY_MEMBERSHIP_PROOF] === true
        && this.usesHistoryMembershipFallback(channelId, scopes)) {
      this.requireScope(scopes, 'channels:history');
    } else this.requireScope(scopes, conversation.is_private ? 'groups:read' : 'channels:read');
    return conversation.is_private ? 'private_channel' : 'channel';
  }

  requireWritable(channelId: string, conversation: AccessConversation | undefined, scopes: readonly string[] | undefined, writeScope: string): void {
    const kind = this.requireReadable(channelId, conversation, scopes);
    if (kind !== 'dm' && !this.writeChannels.has(channelId)) throw new Error(`Writing to ${channelId} is not allowed by the Slack access policy`);
    this.requireScope(scopes, writeScope);
  }
}
