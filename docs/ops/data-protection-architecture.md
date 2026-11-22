# Data protection architecture: how Chord stores, protects and recovers user data

Written 2026-09-25, the day production moved to Cloud SQL. Decision records: ADR [0201](../notes/0201-email-and-attachments-are-sealed-at-rest.md) (sealing content at rest) and ADR [0202](../notes/0202-postgres-moves-off-the-app-vm.md) (Postgres off the app VM). Runbooks: [content-encryption.md](./content-encryption.md), [cloud-sql.md](./cloud-sql.md). What is still to do: [phase-8-key-custody.md](../tasks/phase-8-key-custody.md).

## Why this was done

Google's restricted-scope review (Limited Use, CASA Tier 2) asks what stops company staff, or anyone who gets hold of a disk, a backup or a log, from reading a user's mail. Before this work the honest answer was "nothing": mail bodies, subjects, attachment text and files sat in plaintext Postgres on the same VM as the key material, and the nightly `pg_dump` was plaintext next to them.

**Threat model.** Protected against: a stolen or leaked disk, snapshot, backup, database dump, `.env` copy, log file, or a database login that can run `SELECT`. **Not** protected against: an attacker with root on the running app VM. Root can act as the VM's service account and so can ask KMS to decrypt whatever the app can. The app also has to hold plaintext in memory to call the LLM and to search. Attested key release (phase 7) is the answer to that and is deliberately left out.

## Before and after

| | Before | Now |
|---|---|---|
| Mail bodies, subjects, snippets, attachment text, derived facts | Plaintext columns | Sealed (AES-256-GCM), per-owner data keys |
| Attachment files on disk | Plaintext | Sealed (`CHENC1`), per-owner data keys |
| Where the keys that open them live | Nowhere separate (`MASTER_KEY` in `.env` on the VM) | Cloud KMS. The VM's service account can use the key but the key material never leaves KMS |
| Full-text search | Postgres `tsvector` of the real words | Keyed blind index (HMAC of terms), so the index reveals nothing readable |
| Database host | Postgres on the app VM | Cloud SQL, private IP only, customer-managed disk key |
| Database backups | Nightly plaintext `pg_dump` on the same VM | Cloud SQL automated backups + point-in-time recovery, encrypted, off the VM |
| A person with database access | Could read all mail | Sees ciphertext in every sealed column |
| Deleting a user | Row deletes; backups keep the text | Destroy their key: their content is unreadable everywhere, including in backups |
| LLM prompt log | Full prompts, unrotated | Closed (phase 1) |

## The layers

```
                      Cloud KMS
        ┌─────────────────────┬──────────────────────┐
        │ chord-content /     │ chord-db /           │   two separate keys
        │ content-kek         │ Cloud SQL disk key   │
        └──────────┬──────────┴───────────┬──────────┘
                   │ wraps                │ encrypts disk
                   ▼                      ▼
   per-owner data keys (content_keys)   Cloud SQL instance (private IP)
                   │                      │  holds ONLY sealed content
                   │ seals                │
                   ▼                      │
   mail columns, attachment text ─────────┘
   attachment files on the VM (CHENC1)
```

1. **Envelope encryption.** Each user (and each solo group) gets a random 256-bit data key. That key is stored only *wrapped* by the KMS key. Sealed values are self-describing (`enc1.<owner>.<ctx>.…`, files start `CHENC1`), so sealed and old plaintext coexist safely during a rollout and the app never guesses.
2. **Where decryption happens.** Reads go through one Kysely plugin that opens any sealed string in a result. Writes seal explicitly at a small number of choke points. Key lookups use their own small connection pool, so a key fetch can never starve or deadlock the request that needs it.
3. **Search without plaintext.** The app tokenises and stems, HMACs each term with a per-user index key derived from the data key, and stores those opaque terms in the same GIN index shape. Queries hash the same way, so ranking, paging and the code/prefix matching (`ua512`-style) keep working. The database learns which rows share a word and how many words a row has, not the words.
4. **Cloud SQL.** A managed Postgres 15 on a private IP in the project's VPC, no public address. Its disk is encrypted with a customer-managed key that is separate from the content key: disabling or destroying one can never brick or erase the other. It was built after the content was sealed, so only ciphertext was ever copied onto it.
5. **What stays readable on purpose.** Sender and recipient addresses, labels, dates, read state, filenames, and confirmed family content (a task, event or list item someone accepted, which is shared with the group and outside this design). The reason is joins and routing, for example bulk-mail rules, unsubscribe, routing and vacation replies all key on the address.

## Why it is better

### Security

- **A database dump, a snapshot, a stolen disk or a SQL login is not enough.** Every sensitive column is ciphertext, the search index is keyed, and the key is in KMS. To read mail you now need the data-key row *and* permission to call KMS.
- **Least privilege on the key.** Only the VM's service account holds `cryptoKeyEncrypterDecrypter` on the content key. No engineer is granted it by name, so a copy of the data on a laptop cannot be decrypted. **One exception (verified 2026-09-25): the project Owner basic role carries `useToDecrypt`**, so whoever holds Owner can decrypt through the API. The `chord-audit` alert fires on that, and a deny policy to close it is planned in Phase 8.
- **Auditable.** KMS decrypts are logged per call with the calling principal (Data Access logs on since 2026-09-25, kept a year in the `chord-audit` bucket), and an email alert fires on any decrypt of the content key by anything other than the app. On the VM, logins and sudo, and any person's read of `.env` or the files directory, are recorded by `auditd` and shipped off the box. See [audit-logging.md](./audit-logging.md).
- **Blast radius is per user.** One user's key opens one user's content; there is no single value that opens everything.
- **The database host is off the app VM.** Someone with a shell on the app VM no longer also has the database's files. The database is reachable only over the private network with a password.
- **Leaks closed first.** LLM prompt logging, raw model replies in logs, operator scripts that printed subjects, and mail text in push notifications were removed before any crypto was added.

### Backup

- **Automated, encrypted, and off the VM.** Cloud SQL takes daily backups and keeps write-ahead logs for point-in-time recovery, encrypted with the customer-managed key. The old design left a plaintext dump on the machine it was protecting.
- **Backups are safe to hold.** A copy of a backup is ciphertext plus wrapped keys; it is useless without KMS. This is what makes retention cheap to defend in a review.
- **No shell cron to forget.** The nightly `pg_dump` job and its disk usage retire with the old database.

### Restore

- **Point-in-time recovery.** A bad migration or an accidental delete can be rolled back to a moment, not just to last night. Restore is a Cloud SQL operation into a new instance, so it can be rehearsed without touching production.
- **The cutover itself was rehearsed.** A live dump was restored into a scratch database first (12 to 13 seconds), then the real cutover ran with row-count comparison. The old database was never modified, so rollback was, and until it is retired still is, a one-line `DATABASE_URL` change plus a restart.
- **Restoring data does not restore access.** A restored database is only readable by a principal that can use the KMS key, so a backup that leaks is inert.
- **Deletion that reaches backups.** Destroying a user's key (done at account deletion, ADR 0043) makes their content unreadable in every copy. Caveat: a backup keeps the wrapped key until that backup expires, so the honest statement is "unreadable in live data immediately, and in backups once the key can no longer be unwrapped or they age out".

### Operations

- **A smaller, simpler VM.** It no longer runs Postgres, so it can be shrunk (`cloudsql.sh shrink-vm`), and patching and disk growth for the database are Google's problem.
- **Two independent keys** mean the recovery story for the database disk and for the content are separate decisions.
- **Direct connections, no pooler**, because the app uses session advisory locks (migrations, the proactive drain). Connection counts are sized as (web + worker) × `DB_POOL_MAX` against the instance's `max_connections` (100).

## State on 2026-09-25

Done and verified:

- Mail and attachments sealed, search on the blind index, plaintext search indexes dropped (`CONTENT_ENCRYPTION=true`, `CONTENT_LEGACY_TSV=false`).
- Content keys in Cloud KMS (`chord-content/content-kek`, 90-day rotation).
- Production on Cloud SQL at `10.59.0.3` (`sslmode=no-verify`, see below): services healthy, three connections on Cloud SQL and none on the local Postgres, no database errors after restart, row counts identical to the old database.

## What is not done yet (read this before quoting the design externally)

1. **Old plaintext still exists on the VM.** The old Postgres (frozen at the cutover), its write-ahead log, `/var/backups/chord` (including the pre-encryption dump) and any disk snapshots still hold mail as it was before sealing. "Sealed at rest" is true of the live database and of Cloud SQL, not yet of those copies. Phase 6 (`cloudsql.sh retire-old`, then ideally replacing the VM, since deleting files does not overwrite disk blocks) closes this. It is deliberately waiting until Cloud SQL has run well for a while.
2. **Cloud SQL backups and PITR are configured but not yet drilled.** Do one restore into a scratch instance and confirm the first automatic backup succeeded before relying on them.
3. **Other secrets are still in `.env` on the VM**, which is also readable more widely than it should be: the token-sealing key `MASTER_KEY` (seals Google/Microsoft refresh tokens and IMAP app passwords), third-party API keys, and now the database password. Phase 8 moves `MASTER_KEY` under KMS, third-party secrets into Secret Manager and the database password with them.
4. **The VM runs as the default compute service account.** Its actual project roles have not been audited. A broad role there weakens every key above. Phase 8d replaces it with a dedicated, minimal account.
5. **Audit logs: mostly done** (see [audit-logging.md](./audit-logging.md)). Still open: OS Login (SSH tied to a Google identity), locking the `chord-audit` bucket, and query-level logging (`pgaudit` is already on for schema and role changes; reads and writes are not logged, on purpose). The project Owner can still decrypt (see the least-privilege bullet); the alert catches it, a deny policy would prevent it.
6. **TLS to Cloud SQL is encrypted but not identity-verified** (`sslmode=no-verify`), because node-postgres would otherwise reject Cloud SQL's per-instance certificate. On a private-IP-only instance inside the project's network this is an accepted trade; full verification is Phase 8 hardening.
7. **Root on the running app VM** is out of scope by design (see the threat model).
8. **The model provider's retention window is restricted, and training is confirmed off two ways** (found 2026-09-26, corrected 2026-09-30, closed 2026-09-30). Production sends prompts, including excerpts of user mail, through OpenRouter to OpenAI. Training was already off by OpenAI's own stated default (not opted in; policy since March 2023) — the specific thing Google's Limited Use policy forbids — and is now also confirmed off at the OpenRouter account level, where both "allow endpoints that train on request data" toggles (paid and free, every provider) are off. OpenAI's default is 30 days of abuse-monitoring retention regardless of training; OpenRouter's account-level Zero Data Retention setting for OpenAI is now on (owner-confirmed), so production's traffic routes only to OpenAI endpoints that do not retain it either. Everything above protects data at rest; this closes the equivalent gap for data in use. **Closed by the owner 2026-09-30**, with two items deliberately deferred rather than pursued: OpenRouter's separate prompt-logging opt-in is still unconfirmed, and no data processing agreement is in hand. Full write-up, subprocessor table and what is sent: [llm-data-handling.md](./llm-data-handling.md).

## How to describe this to a reviewer in one paragraph

User mail and attachments are encrypted at the application layer with per-user AES-256 keys, wrapped by a key in Cloud KMS that only the application's service account can use. Search runs over a keyed blind index, so the database holds no readable words. The database runs on Cloud SQL with a private IP and a customer-managed disk key, with automated backups and point-in-time recovery, so backups and dumps are ciphertext that is useless without KMS. Deleting an account destroys its key. Staff or anyone who obtains a database login, backup, disk or log cannot read message content; the residual exposure is the running application host, which holds plaintext in memory to serve requests and call the model.
