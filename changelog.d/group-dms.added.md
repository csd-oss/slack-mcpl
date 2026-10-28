- The explicit access policy takes an optional `groupDms` list of group DM (mpim)
  conversation IDs. A joined group DM it names is readable with `mpim:read` (history
  and threads also need `mpim:history`), is listed by `list_channels` as `group_dm`, and
  its incoming messages arrive as channel messages. Writing there also needs the ID in
  `writeChannels`. Without `groupDms`, every group DM stays denied, as before.
