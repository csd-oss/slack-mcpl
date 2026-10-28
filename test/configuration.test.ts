import {test} from 'node:test';
import assert from 'node:assert/strict';
import {optionalConfiguration} from '../src/configuration.js';

const accessPolicy = {readJoinedChannels: true, writeChannels: ['CTEAM', 'COTHER'], dmUsers: ['UOWNER']};
test('ordinary startup retains no-policy defaults', () => {
  assert.deepEqual(optionalConfiguration({}), {accessPolicy: undefined, recipientRouting: undefined, disabledTools: []});
});
test('optional profiles accept multiple configurable destinations and no deployment IDs', () => {
  const recipientRouting = {stateFile: '/private/agent/receipts.sqlite', namespace: 'workspace-agent', expectedBotUserId: 'USELF'};
  assert.deepEqual(optionalConfiguration({SLACK_ACCESS_POLICY: JSON.stringify(accessPolicy),
    SLACK_RECIPIENT_ROUTING: JSON.stringify(recipientRouting), SLACK_DISABLED_TOOLS: 'subscribe_channel, unsubscribe_channel'}),
    {accessPolicy, recipientRouting, disabledTools: ['subscribe_channel', 'unsubscribe_channel']});
});
test('the policy may name group DMs, and refuses ones that are not conversation IDs', () => {
  const withGroups = {...accessPolicy, groupDms: ['CGROUPDM']};
  assert.deepEqual(optionalConfiguration({SLACK_ACCESS_POLICY: JSON.stringify(withGroups)}).accessPolicy, withGroups);
  for (const groupDms of [['DPEER'], ['UPEER'], 'CGROUPDM']) {
    assert.throws(() => optionalConfiguration({SLACK_ACCESS_POLICY: JSON.stringify({...accessPolicy, groupDms})}));
  }
});
test('malformed or misspelled policy and recipient settings fail before connecting Slack', () => {
  for (const env of [
    {SLACK_ACCESS_POLICY: ''}, {SLACK_ACCESS_POLICY: 'null'},
    {SLACK_ACCESS_POLICY: JSON.stringify({...accessPolicy, readJoinChannels: true})},
    {SLACK_ACCESS_POLICY: JSON.stringify({...accessPolicy, writeChannels: ['DPEER']})},
    {SLACK_RECIPIENT_ROUTING: '{}'},
    {SLACK_DISABLED_TOOLS: 'misspelled'},
    {SLACK_ACCESS_POLICY: JSON.stringify(accessPolicy), SLACK_RECIPIENT_ROUTING: JSON.stringify({stateFile: './relative', namespace: 'test'})},
    {SLACK_ACCESS_POLICY: JSON.stringify(accessPolicy), SLACK_RECIPIENT_ROUTING: JSON.stringify({stateFile: '/private/db', namespace: 'test', expectedBotUserId: 'other'})},
  ]) assert.throws(() => optionalConfiguration(env));
});

test('the old boolean path switch is refused rather than read as off', () => {
  for (const value of ['', 'false', 'true', '0']) {
    assert.throws(() => optionalConfiguration({SLACK_ALLOW_FILE_PATHS: value}), /was removed.*SLACK_PATH_UPLOADS/);
  }
});
