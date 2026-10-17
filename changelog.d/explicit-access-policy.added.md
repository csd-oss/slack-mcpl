- Operators may explicitly configure joined-channel reads, separate writable channel IDs,
  and allowed one-to-one DM peers. Incoming events and operations recheck membership and
  required scopes; empty DM allowlists deny all DMs, and group DMs remain denied.
  Without a policy, existing operator flags and access behavior remain unchanged.
- Explicit-profile attachment downloads require `channelId` and `fileId`, fresh readable
  membership and exact `files.info` conversation association. Downloads use the canonical
  private Slack URL and refuse redirects. URL-only downloads remain available without a profile.
- Live messages, history, threads and backscroll preserve Slack file IDs and show usable
  authorized download arguments; missing IDs are marked unavailable instead of inferred.
