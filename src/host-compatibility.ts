/** Optional local extension, not a standard MCPL capability. A host must
 * implement the storage/turn-lifecycle hooks before advertising this contract. */
export const RECIPIENT_CAPABILITY = 'slackRecipientRouting';

export interface RecipientCapability {
  version: 1;
  botUserId: string;
  contextOnly: true;
  frozenReply: true;
  frozenStatus: true;
  provenance: true;
}

export interface RecipientReply {
  readonly channelId: string;
  readonly threadId: string;
}

export interface HostAccessPolicy {
  readJoinedChannels: boolean;
  writeChannels: readonly string[];
  dmUsers: readonly string[];
}

const USER = /^U[A-Z0-9]+$/;
const CHANNEL = /^[CGD][A-Z0-9]+$/;
const STAMP = /^\d+\.\d+$/;

export function recipientCapability(botUserId: string): RecipientCapability {
  if (!USER.test(botUserId)) throw new Error('Invalid recipient identity');
  return Object.freeze({version: 1, botUserId, contextOnly: true,
    frozenReply: true, frozenStatus: true, provenance: true});
}

/** Refuse a partial/other-recipient promise. This handshake is an attestation,
 * not proof that an arbitrary remote host actually implements its promise. */
export function requireRecipientCapability(value: unknown, botUserId: string): RecipientCapability {
  const expected = recipientCapability(botUserId);
  if (!value || typeof value !== 'object'
      || Object.entries(expected).some(([key, field]) => (value as Record<string, unknown>)[key] !== field)) {
    throw new Error('Recipient mode requires slackRecipientRouting v1 host support');
  }
  return expected;
}

export function freezeRecipientReply(value: unknown): RecipientReply {
  const reply = value as Partial<RecipientReply> | undefined;
  if (!reply || typeof reply.channelId !== 'string' || !/^slack:[CGD][A-Z0-9]+$/.test(reply.channelId)
      || typeof reply.threadId !== 'string' || !STAMP.test(reply.threadId)) {
    throw new Error('A frozen Slack conversation and thread target are required');
  }
  return Object.freeze({channelId: reply.channelId, threadId: reply.threadId});
}

/** Pass this frozen value through queues, tools, retries and budget restarts.
 * Do not replace it from a later context-only arrival. */
export function recipientPublishParams(reply: RecipientReply) {
  return {...freezeRecipientReply(reply)};
}

export function recipientTypingMetadata(reply: RecipientReply) {
  return {supportRecipientReplyRoot: freezeRecipientReply(reply).threadId};
}

type IngressLane = 'channels/incoming' | 'push/event';
export type RecipientDecision = Readonly<{
  store: boolean;
  triggerInference: boolean;
  recipientReply?: RecipientReply;
}>;

/** A small reusable host-side admission bridge. The host supplies metadata from
 * its authenticated connector transport, never parsed message text. It still
 * owns storage, inference scheduling, continuation suppression and authorization. */
export function createRecipientHostBridge(config: {
  serverId: string;
  ownUserId: string;
  accessPolicy: HostAccessPolicy;
}) {
  if (!config.serverId || !USER.test(config.ownUserId)
      || typeof config.accessPolicy?.readJoinedChannels !== 'boolean'
      || !Array.isArray(config.accessPolicy.writeChannels)
      || !config.accessPolicy.writeChannels.every(id => /^[CG][A-Z0-9]+$/.test(id))
      || !Array.isArray(config.accessPolicy.dmUsers) || !config.accessPolicy.dmUsers.every(id => USER.test(id))) {
    throw new Error('Invalid recipient host configuration');
  }
  const serverId = config.serverId;
  const ownUserId = config.ownUserId;
  const readJoined = config.accessPolicy.readJoinedChannels;
  const dmUsers = new Set(config.accessPolicy.dmUsers);
  const refuse: RecipientDecision = Object.freeze({store: false, triggerInference: false});
  return Object.freeze({
    initializeCapability: recipientCapability(ownUserId),
    accept(lane: IngressLane, metadata: Record<string, unknown>): RecipientDecision {
      if (!['channels/incoming', 'push/event'].includes(lane) || metadata.serverId !== serverId
          || metadata.botUserId !== ownUserId || metadata.routingVersion !== 1
          || typeof metadata.channelId !== 'string' || typeof metadata.replyRoot !== 'string'
          || !STAMP.test(metadata.replyRoot) || typeof metadata.wakeAllowed !== 'boolean'
          || !Array.isArray(metadata.mentionIds) || !metadata.mentionIds.every(id => typeof id === 'string' && USER.test(id))) return refuse;
      const channelId = metadata.channelId.replace(/^slack:/, '');
      const access = metadata.supportAccess as Record<string, unknown> | undefined;
      if (!CHANNEL.test(channelId) || !access || access.version !== 1
          || access.channelId !== channelId || access.readable !== true) return refuse;
      const kind = metadata.senderKind;
      const human = kind === 'human' && metadata.isBot === false;
      const peer = (kind === 'bot' || kind === 'unknown') && metadata.isBot === true;
      if ((!human && !peer) || typeof metadata.authorId !== 'string' || !USER.test(metadata.authorId)
          || metadata.authorId === ownUserId
          || metadata.authority !== (human ? 'human-source' : 'peer-not-owner')) return refuse;
      let addressed = false;
      if (access.kind === 'dm') {
        if (!channelId.startsWith('D') || metadata.isDM !== true
            || typeof access.dmPeer !== 'string' || !dmUsers.has(access.dmPeer)
            || metadata.authorId !== access.dmPeer) return refuse;
        addressed = human && metadata.dmAuthorizedPeer === access.dmPeer;
        if (metadata.routingReason !== (addressed ? 'authorized-human-dm' : 'context-only')) return refuse;
      } else {
        if (!/^[CG]/.test(channelId) || metadata.isDM !== false || !readJoined || access.joined !== true
            || !['channel', 'private_channel'].includes(access.kind as string)) return refuse;
        addressed = metadata.mentionIds.includes(ownUserId);
        if (metadata.routingReason !== (addressed ? human ? 'human-mention' : 'peer-mention' : 'context-only')) return refuse;
      }
      if (metadata.wakeAllowed !== addressed) return refuse;
      return Object.freeze({store: true, triggerInference: addressed,
        ...(addressed ? {recipientReply: freezeRecipientReply({channelId: `slack:${channelId}`, threadId: metadata.replyRoot})} : {})});
    },
  });
}
