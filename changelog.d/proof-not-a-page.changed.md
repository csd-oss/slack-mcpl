- `fetch_history` and `fetch_thread` counted a pinned channel's membership
  proof (`SLACK_ACCESS_POLICY`'s `historyMembershipFallbackChannels`) as one
  of the call's `maxPages`, so `maxPages: 1` in such a channel returned no
  messages. The proof is now a metadata request, like `conversations.info`,
  outside the page count; `maxMs` still covers it. `maxPages` is pages of
  messages.
