- Operators may explicitly configure `pathUploads` / `SLACK_PATH_UPLOADS` as
  restricted directory capabilities or unrestricted regular-file access. The
  default remains inline-only; both enabled modes use capped bytes and carry
  `comms` and `files` classes. Restricted mode requires optional Python 3.9+
  descriptor-path support, refuses symlinks below pinned roots, and fails closed.
  Inline and unrestricted modes remain Node-only. The earlier local draft's
  `allowFilePaths` / `SLACK_ALLOW_FILE_PATHS` flags now fail with migration errors.
- Upload destinations are checked before local path reads and checked again
  before Slack effects, including configured access policy, fresh membership,
  upload scope, DM restrictions and SDK availability.
