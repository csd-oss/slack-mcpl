- Under `SLACK_ACCESS_POLICY`, a conversation listing asked
  `conversations.info` for every channel `conversations.list` returned, which
  is every public channel in the workspace, before leaving out the ones the
  bot isn't in. On a workspace of 137 public channels with the bot in 12, a
  listing made about 137 requests, so `list_channels` ran out of its call's
  time and registration crawled through rate limits. A channel the list says
  the bot isn't in is now left out first, so only joined channels and DMs are
  checked afresh, each still listed only as that check describes it.
