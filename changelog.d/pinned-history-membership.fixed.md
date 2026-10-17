- An explicit access policy may name public write-channel IDs whose fresh bot-token
  history access proves membership when `channels:read` is absent. This fallback
  sends a one-message history request for every operation, never caches membership
  or changes reported scopes, and fails closed on refusal, timeout or rate limit.
  It cannot authorize another channel, private conversation or DM; normal metadata
  scope checks and independent file, directory and write restrictions remain.
