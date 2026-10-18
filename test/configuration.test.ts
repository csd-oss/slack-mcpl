import {test} from 'node:test';
import assert from 'node:assert/strict';
import {optionalConfiguration} from '../src/configuration.js';

const accessPolicy = {readJoinedChannels: true, writeChannels: ['CTEAM', 'COTHER'], dmUsers: ['UOWNER']};
test('ordinary startup retains no-policy defaults', () => {
  assert.deepEqual(optionalConfiguration({}), {accessPolicy: undefined, recipientRouting: undefined, disabledTools: [], pathUploads: undefined});
});
test('optional profiles accept multiple configurable destinations and no deployment IDs', () => {
  const recipientRouting = {stateFile: '/private/agent/receipts.sqlite', namespace: 'workspace-agent', expectedBotUserId: 'USELF'};
  assert.deepEqual(optionalConfiguration({SLACK_ACCESS_POLICY: JSON.stringify(accessPolicy),
    SLACK_RECIPIENT_ROUTING: JSON.stringify(recipientRouting), SLACK_DISABLED_TOOLS: 'subscribe_channel, unsubscribe_channel'}),
    {accessPolicy, recipientRouting, disabledTools: ['subscribe_channel', 'unsubscribe_channel'], pathUploads: undefined});
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

test('path upload policy is explicit, closed and separate from legacy boolean flags', () => {
  for (const pathUploads of [{mode: 'unrestricted'}, {mode: 'restricted', directories: ['/operator/files']}]) {
    assert.deepEqual(optionalConfiguration({SLACK_PATH_UPLOADS: JSON.stringify(pathUploads)}).pathUploads, pathUploads);
  }
  for (const value of ['', 'false', 'true', '0']) {
    assert.throws(() => optionalConfiguration({SLACK_ALLOW_FILE_PATHS: value}), /was removed.*SLACK_PATH_UPLOADS/);
  }
  for (const value of ['', 'true', 'null', '{}', '{"mode":"restricted","directories":[]}', '{"mode":"unrestricted","extra":true}']) {
    assert.throws(() => optionalConfiguration({SLACK_PATH_UPLOADS: value}), /SLACK_PATH_UPLOADS must configure/);
  }
});
