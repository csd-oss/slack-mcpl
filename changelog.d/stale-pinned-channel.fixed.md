- Under `SLACK_ACCESS_POLICY`, one pinned channel whose fresh membership
  proof failed (the bot had left it, it was archived, Slack refused) ended the
  whole conversation listing, so nothing else was listed or registered. The
  pinned channel is now left out and logged, still fail-closed, and the
  listing goes on with the rest.
