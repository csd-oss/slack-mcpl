- `fetch_history` and `fetch_thread` keep an explicit access policy's checks: each
  call, a continuation with a cursor included, checks the conversation afresh,
  with a pinned channel's membership proof, before its first page. The proof is
  not one of the read's pages. Attachments in their results and in backscroll
  carry `fetch_attachment`'s `channelId` and `fileId`, never the message's URL.
