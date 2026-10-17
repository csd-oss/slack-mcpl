- Operators may opt into a private identity-bound durable recipient ledger and
  explicit access policy. Admitted own mentions can wake; unaddressed messages
  remain context only on compatible hosts. No peer arming, count or expiry gate
  is used. Optional tool suppression and zero automatic backscroll are supported.
- Hosts opting into recipient mode must attest `slackRecipientRouting` version 1
  during MCPL 0.5 initialization and implement context-only storage, trusted
  provenance and frozen reply/status targets. Missing support refuses the session;
  ordinary MCP/MCPL defaults are unchanged. A reusable admission bridge is provided,
  but an arbitrary host is not qualified merely by importing it.
- Recipient-mode prose requires an explicit verified thread root. Typing also
  uses an explicit verified root; a delayed stop cannot clear another turn's status.
  Pending typing work is discarded when its connection or policy era changes.
  Durable routing requires Node 24+ on POSIX; legacy operation retains Node 22.12.0.
