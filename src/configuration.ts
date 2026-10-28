/** Parse only optional connector settings. Credential values never enter this
 * parser, its diagnostics, examples or persisted routing state. */
import {isAbsolute} from 'node:path';
import {SlackAccessPolicy, type SlackAccessPolicyConfig} from './access-policy.js';
import {toolDefinitions} from './tools.js';

export interface RecipientRoutingConfig {
  stateFile: string;
  namespace: string;
  expectedBotUserId?: string;
}

function json(value: string, name: string): unknown {
  try { return JSON.parse(value); }
  catch { throw new Error(`${name} must be valid JSON`); }
}
function object(value: unknown, keys: string[], name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).some(key => !keys.includes(key))) throw new Error(`Invalid ${name}`);
  return value as Record<string, unknown>;
}

export function optionalConfiguration(env: Record<string, string | undefined>) {
  // A local draft's boolean switch for paths; it must not be read as off.
  if (env.SLACK_ALLOW_FILE_PATHS !== undefined) {
    throw new Error('SLACK_ALLOW_FILE_PATHS was removed; configure SLACK_PATH_UPLOADS restricted directories or explicit unrestricted mode');
  }
  let accessPolicy: SlackAccessPolicyConfig | undefined;
  if (env.SLACK_ACCESS_POLICY !== undefined) {
    const policy = object(json(env.SLACK_ACCESS_POLICY, 'SLACK_ACCESS_POLICY'),
      ['readJoinedChannels', 'writeChannels', 'dmUsers', 'historyMembershipFallbackChannels', 'groupDms'], 'Slack access policy');
    new SlackAccessPolicy(policy as unknown as SlackAccessPolicyConfig);
    accessPolicy = policy as unknown as SlackAccessPolicyConfig;
  }
  let recipientRouting: RecipientRoutingConfig | undefined;
  if (env.SLACK_RECIPIENT_ROUTING !== undefined) {
    const routing = object(json(env.SLACK_RECIPIENT_ROUTING, 'SLACK_RECIPIENT_ROUTING'),
      ['stateFile', 'namespace', 'expectedBotUserId'], 'recipient routing configuration');
    if (!accessPolicy || typeof routing.stateFile !== 'string' || !isAbsolute(routing.stateFile)
        || typeof routing.namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(routing.namespace)
        || (routing.expectedBotUserId !== undefined && (typeof routing.expectedBotUserId !== 'string'
          || !/^[UW][A-Z0-9]+$/.test(routing.expectedBotUserId)))) {
      throw new Error('Recipient routing requires an explicit access policy, absolute state file and namespace');
    }
    recipientRouting = routing as unknown as RecipientRoutingConfig;
  }
  const disabledTools = env.SLACK_DISABLED_TOOLS?.split(',').map(name => name.trim()).filter(Boolean) ?? [];
  const toolNames = new Set(toolDefinitions.map(tool => tool.name));
  if (disabledTools.some(name => !toolNames.has(name))) throw new Error('SLACK_DISABLED_TOOLS names an unknown tool');
  return {accessPolicy, recipientRouting, disabledTools};
}
