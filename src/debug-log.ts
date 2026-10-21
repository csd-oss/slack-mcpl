import { appendFileSync } from 'node:fs';

// Diagnostic file logger — bypasses the host's stderr capture. Set
// SLACK_MCPL_DEBUG_LOG in the spawn env to a writable absolute path to
// enable; leave unset for no-op.
const _DEBUG_LOG_PATH = process.env.SLACK_MCPL_DEBUG_LOG;
export function dbg(tag: string, info: Record<string, unknown> = {}): void {
  if (!_DEBUG_LOG_PATH) return;
  try {
    appendFileSync(
      _DEBUG_LOG_PATH,
      `${new Date().toISOString()} ${tag} ${JSON.stringify(info)}\n`,
    );
  } catch {
    // Logging is best-effort; never break the server because of it.
  }
}
