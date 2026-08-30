# Vault Storage-Neutral Byte Lifecycle

Status: implemented

## Problem

Vault file lifecycle was shallow: callers selected local versus S3 behavior and depended on
sync versus async, paths versus bytes, and separate local versus stored operations. Durability,
recovery, compensation, and checksum responsibilities were spread across callers and the Vault
implementation.

## Decision

Expose one storage-neutral Vault interface to Telegram, Dashboard, Assistant, and tests. Keep
backend selection, journaling, compensation, startup recovery, byte lookup, and checksum
verification inside the Vault implementation. Local filesystem and S3 are internal adapters at
one real storage seam.

## Requirements

- Callers save, read, and delete files through one asynchronous lifecycle.
- Public Vault items never expose storage backend, storage key, filesystem path, or checksum.
- Existing local files remain readable when S3 becomes the default write backend.
- Local and S3 operations retain enough journal state to recover safely after interruption.
- Reads verify stored size and SHA-256 before returning bytes.
- Folder deletion handles mixed local/S3 descendants without selecting a backend in callers.
- Concurrent subtree mutations cannot cause metadata to survive without bytes or leave orphan
  bytes after a cascade delete.
- Production dependencies and tests depend on the Vault interface, not its concrete implementation.

## Acceptance Criteria

- Telegram, Dashboard, Assistant, and tests use `saveFile`, `readFile`, and `delete`.
- Construction returns the `Vault` interface; the concrete implementation is internal.
- A file moved out while its folder deletion is being staged remains readable after the folder is
  deleted.
- Failed metadata deletion compensates staged operations, while failed post-commit cleanup remains
  journaled for startup recovery.
- Type checking and production build pass.
