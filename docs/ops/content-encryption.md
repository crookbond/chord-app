# Content encryption at rest — rollout runbook

ADR [0201](../notes/0201-email-and-attachments-are-sealed-at-rest.md). Order matters: readers first, then writers, then the backfill.

## Phase 2 — attachment files

1. **Deploy** the release. Nothing changes yet: `CONTENT_ENCRYPTION` defaults to off, every reader already opens sealed files and passes plain ones through. The `090_content_keys` migration runs at boot. Web and worker must both be on the new release before step 2 (a worker without the plugin would read ciphertext).
2. **Back up** the database and `DATA_DIR/files` (the backfill rewrites files in place).
3. **Choose the key provider.**
   - `gcp-kms` (the point of all this): create a key ring + key, grant the VM's service account `roles/cloudkms.cryptoKeyEncrypterDecrypter` on that one key and nothing broader, deny humans, turn on Data Access audit logs for Cloud KMS, set `CONTENT_KEY_PROVIDER=gcp-kms` and `GCP_KMS_KEY_NAME`.
   - `local`: set `CONTENT_KEK` (base64, 32 bytes). Stopgap only; the key sits in `.env`.
4. **Turn it on:** `CONTENT_ENCRYPTION=true`, restart web + worker. New files are sealed.
5. **Backfill:** `npm run encrypt:backfill --workspace=server -- --step attachments --dry-run`, then without `--dry-run`. Safe to stop and re-run; it skips what is sealed. Exit code 1 if any file failed.
6. **Verify:** `head -c 8 <some file>` under `DATA_DIR/files` starts with `CHENC1`; opening the same file in the app still works.

## Rolling back

Set `CONTENT_ENCRYPTION=false`. New files are written plain again; sealed ones keep opening as long as the key provider is reachable. Do NOT delete `content_keys` rows or rotate `CONTENT_KEK` while sealed files exist: that is the same as erasing them.

## Erasure

Account deletion destroys the user's key and every solo group's key after the database transaction commits. A backup taken earlier still contains the wrapped key and stays readable until it expires; state that retention when asked.

## What this phase does not cover

Mail columns, message bodies, search indexes, extracted attachment text: phases 3 and 4.

## Phase 3 - mail

Prerequisite: phase 2's steps 3 and 4 (key provider chosen, `CONTENT_ENCRYPTION=true`).

1. **Deploy.** Migration `091_email_blind_index` adds the index columns. Nothing is sealed yet; search reads the blind index and, for rows without one, the old columns.
2. **Back up the database.** The backfill rewrites every mail row.
3. **Backfill:** `npm run encrypt:backfill --workspace=server -- --step email --dry-run`, then without `--dry-run`. New mail is sealed and indexed as it arrives (once `CONTENT_ENCRYPTION` is on), so this only catches up what already exists. Safe to stop and re-run.
4. **Verify:** `--step verify` exits 1 and lists what is still readable, per column. Repeat step 3 until it prints "No readable mail content remains."
5. **Search on sealed mail only:** set `CONTENT_LEGACY_TSV=false` on web AND worker and restart both. Spot-check search from the app.
6. **Finalize:** `--step finalize-email --vacuum` drops `search_tsv` on both tables and rewrites them so the old plaintext is not left in dead tuples. It refuses while the flag is still on or while anything is readable. The rewrite takes a table lock; run it when mail is quiet.
7. **Remove the plaintext elsewhere:** old database dumps and WAL still hold the mail as it was (phase 6 of the plan). Until those are destroyed, "sealed at rest" is true of the live database only.

## What is and is not sealed in mail

Sealed: subject, snippet, sender display name, plain and HTML bodies, attachment metadata (names), invite text, and the delivery / flight / receipt / advisory facts. Readable by design: sender and recipient addresses, labels, dates, read state. The blind index reveals which rows share a word, and how many words a row has, but not the words.


## Phase 4 - derived content (files' text, suggestions, drafts, meeting summaries)

Prerequisite: phase 3 done, `CONTENT_ENCRYPTION=true`.

1. **Deploy.** Migration `092_attachment_chunk_blind_index` adds a column. Nothing is sealed yet; chunk search reads the blind index and, for chunks without one, the old column.
2. **Back up the database.**
3. **Backfill:** `npm run encrypt:backfill --workspace=server -- --step derived --dry-run`, then without `--dry-run`. Attachment text, search chunks, suggestions mined from mail, drafts and meeting summaries. Safe to stop and re-run.
4. **Verify:** `--step verify-derived` exits 1 and lists what is still readable or has no index, per column. Repeat step 3 until it prints "No readable derived content remains."
5. Set `CONTENT_LEGACY_TSV=false` on web AND worker (one flag for mail and chunks), restart both, spot-check the bot answering a question about a file.
6. **Finalize:** `--step finalize-derived --vacuum` drops `attachment_chunks.body_tsv` and rewrites `attachment_chunks`, `attachments`, `proposals`, `email_drafts`. Takes table locks; run when quiet. Refuses while the flag is on or while anything is readable.

What stays readable: filenames; confirmed tasks, events, list items, people and saved places (once a suggestion is accepted it is family content, outside this design); suggestions a person made in chat.
