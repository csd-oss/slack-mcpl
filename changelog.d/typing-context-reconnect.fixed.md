- The thread a host's `channels/typing` lands on, the newest incoming
  message's, outlived the connection it was learned on: a new peer's typing
  could show "is thinking…" on a thread from before it connected. It is now
  cleared with the rest of the peer's delivery context when a connection
  starts.
