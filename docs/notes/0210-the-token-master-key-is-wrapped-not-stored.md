# 0210 — The token master key is wrapped, not stored

**Status**: accepted; code built and tested (2026-09-25), not yet deployed; the cutover is two deploys and is run by the owner (runbook: [master-key.md](../ops/master-key.md))
**Date**: 2026-09-25

Phase 8a of [the key custody plan](../tasks/phase-8-key-custody.md). Extends [ADR 0201](./0201-email-and-attachments-are-sealed-at-rest.md): content keys were put behind Cloud KMS, and this does the same for the other key in `.env` that opens stored secrets.

## Context

`MASTER_KEY` (`utils/crypto-tokens.ts`) seals Google and Microsoft refresh tokens, Apple's refresh token, IMAP app passwords, BYOK LLM keys, connector credentials, and (through the same key) the image-proxy tokens. A stolen refresh token is a stolen mailbox. It sat in `/srv/chord/.env` on the VM, beside the database credential and in every copy of that file, so the content encryption's protection ("a copy of the disk or a backup is useless without KMS") did not hold for the tokens.

## Decision

**Keep the key's value, change where it lives.** `MASTER_KEY_WRAPPED` holds the same 32 bytes encrypted by a Cloud KMS key; the process unwraps them once at boot (`db/crypto/master-key.ts`, reusing the existing `GcpKmsKeyProvider`, whose additional authenticated data binds the key name) and hands the result to `crypto-tokens.ts`, whose `sealToken`/`openToken` stay synchronous. Because the value does not change, **every blob already sealed stays readable, and nothing is re-sealed**.

- **The wrapped key wins, and is never skipped.** If `MASTER_KEY_WRAPPED` is set and the boot step has not unwrapped it, sealing throws instead of falling back to a plain `MASTER_KEY`. Falling back would seal new blobs under a key the wrapped copy cannot open, and hide that the move is half done.
- **Two deploys, so it is reversible.** Deploy the code (accepts either). On the VM, `npm run wrap:master-key` prints only the ciphertext (after checking it unwraps to the same bytes); put it in `.env.prod`, deploy, verify. Only then remove the plain `MASTER_KEY` and deploy again.
- **Boot fails loudly and says which setting.** A wrapped value for a different key, garbage, a wrong length, or a service account that lost access all stop the process at startup with a message naming `MASTER_KEY_WRAPPED`, not on the first sign-in.
- **Key name.** `MASTER_KEY_KMS_KEY`, defaulting to `GCP_KMS_KEY_NAME` (the content key). It is bound into the wrapping, so it must not change once set.

## Why the content key, and what that costs

Wrapping under the content key needs no new key and no IAM change. The cost is a shared kill switch: disabling or destroying the content key would now also make every stored refresh token and IMAP password unreadable (users would reconnect their accounts; nothing is lost that they cannot re-grant, unlike sealed mail). A separate key gives two independent switches and a cleaner blast radius; it is one `MASTER_KEY_KMS_KEY` value and a re-wrap away, since the setting exists for exactly that. Not done now because a second key needs a KMS create and an IAM grant to the VM's account, both owner actions.

## What this does not do

It does not protect against root on the running app VM (that account can ask KMS to unwrap; ADR 0203 is the answer), and it does not make the key per-user: one global key still seals every token, so there is no per-user erasure and no rotation without a re-seal (the stretch item in the Phase 8 plan). The plain key still exists offline wherever the owner keeps a copy: **lose the KMS key and the wrapped value is unrecoverable, so keep a sealed offline copy of the plain `MASTER_KEY`** (break-glass, an owner decision).

## Rejected

Re-sealing every token under per-user keys now (a backfill and a bigger change for a benefit nobody has asked for yet); a separate synchronous unwrap (KMS is a network call, so boot became async instead and the sealing API did not); reading the key from Secret Manager (a key that must be plaintext in memory but is only ever wrapped is exactly what KMS is for; Secret Manager is 8b's job for vendor secrets); silently preferring a plain key when both are present (the half-migrated state that hides itself).
