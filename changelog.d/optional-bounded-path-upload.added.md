- Operators may explicitly enable `allowFilePaths` to add absolute local-file
  uploads. One nonblocking descriptor checks regular-file type and a 5 MiB cap
  before and during the read; Slack receives bounded bytes. Symlinks are allowed,
  ordinary OS permissions apply, and there is no directory boundary or sandbox.
  Defaults remain inline-only; `path` is neither advertised nor accepted unless
  enabled. Only enabled path mode adds the `files` class alongside `comms`.
