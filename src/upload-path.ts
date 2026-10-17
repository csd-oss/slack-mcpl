import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { MAX_ATTACHMENT_BYTES } from './content.js';

/** Open first, then inspect/read that same descriptor. O_NONBLOCK prevents a
 * FIFO from waiting for a writer before fstat can refuse it. Symlinks to
 * regular files are allowed; there is deliberately no directory boundary. */
export async function readUploadPath(path: string): Promise<Buffer> {
  if (!isAbsolute(path)) throw new Error('path must be absolute');
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error('upload path must name a regular file');
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`file too large: this server's upload limit is ${MAX_ATTACHMENT_BYTES} bytes`);
    // Also bound the read if the file grows after fstat. Never read more than
    // one byte beyond the cap, even when size metadata was stale.
    const data = Buffer.alloc(MAX_ATTACHMENT_BYTES + 1);
    let size = 0;
    while (size < data.length) {
      const { bytesRead } = await file.read(data, size, data.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_ATTACHMENT_BYTES) throw new Error(`file too large: this server's upload limit is ${MAX_ATTACHMENT_BYTES} bytes`);
    return data.subarray(0, size);
  } finally {
    await file.close();
  }
}

