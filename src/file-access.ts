import { parseSlackAttachmentUrl } from './content.js';

/** Metadata comes from files.info, never from the requested URL or message.
 * A file ID by itself says nothing about which conversation may read it. */
export function associatedFileUrl(file: Record<string, unknown>, channelId: string): URL {
  const inList = ['channels', 'groups', 'ims'].some((key) =>
    Array.isArray(file[key]) && (file[key] as unknown[]).includes(channelId));
  const shares = file.shares as Record<string, unknown> | undefined;
  const inShares = ['public', 'private'].some((kind) => {
    const conversations = shares?.[kind];
    if (!conversations || typeof conversations !== 'object') return false;
    const entries = Object.entries(conversations).find(([id]) => id === channelId)?.[1];
    return Array.isArray(entries) && entries.length > 0;
  });
  if (!inList && !inShares) throw new Error('Slack file is not associated with the requested readable conversation');
  const raw = file.url_private_download ?? file.url_private;
  if (typeof raw !== 'string') throw new Error('Slack file metadata has no private download URL');
  const url = parseSlackAttachmentUrl(raw);
  if (url.username || url.password) throw new Error('Slack file metadata has an invalid private download URL');
  return url;
}

/** What an explicit access policy shows after an attachment's name: the
 * arguments fetch_attachment takes for it, or that it can't be fetched. A
 * reference is never authorization: fetch_attachment checks it afresh. */
export function attachmentFetchHint(channelId: string, fileId: string | undefined): string {
  return fileId
    ? ` — fetch_attachment(${JSON.stringify({ channelId, fileId })})`
    : ' — not downloadable: Slack file ID is missing';
}
