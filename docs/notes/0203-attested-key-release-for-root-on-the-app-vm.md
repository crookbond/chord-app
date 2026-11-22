# 0203 - Attested key release, for when root on the app VM is in the threat model

**Status**: proposed, not built. Recommendation: defer (see "When to build it").
**Date**: 2026-09-23

Optional last step of the ADR 0201 plan. Reads with ADR [0201](./0201-email-and-attachments-are-sealed-at-rest.md) and [0202](./0202-postgres-moves-off-the-app-vm.md).

## What is and is not covered today

With ADR 0201 and 0202 in place, a person with access to the database, its backups, the disk, or the logs sees ciphertext. The threat model the owner chose stops there: **someone with root on the app VM is out of scope**, because the running process necessarily holds plaintext in memory and holds the credentials that ask the key service to unwrap keys. Such a person can read process memory, attach a debugger, or call KMS as the app's service account. That is true of every design where the server itself reads the data (which Chord must, to search, to run the bot, and to send excerpts to an LLM).

This ADR is about closing that gap, and about whether it is worth it.

## The mechanism, if it were built

**Confidential Space** (Google Cloud): the application runs as a container image on a Confidential VM (memory encrypted by the CPU, so the host and a root user on the guest OS cannot read it). The VM produces an attestation, a signed statement of what image (by digest) is running and whether it is a debug build. A Workload Identity Pool accepts that attestation only when its claims match a policy (this image digest, production mode, this project), and only then does the pool's principal get `cryptoKeyEncrypterDecrypter` on the content key. The KEK is released to the workload and to nothing else: not to a person, not to the same VM running a different image, not to a debug build.

Effect: root on the VM can no longer obtain the key by acting as the service account, and cannot read the process's memory. A malicious or coerced *deploy* is still possible (someone with permission to publish a new image and update the policy), so the residual control is who may change that policy and that changes are logged and alerted on.

## What it costs

- **The deployment model changes completely.** Today the release is `rsync` + `npm install` + build on the VM + `systemd` units, with `ssh` for operations. A Confidential Space production workload is a container image run by a launcher; there is no `ssh` into a production image (that is the point), logs go to Cloud Logging, and secrets and config are passed as launch metadata rather than a file on disk. That means containerising the web and worker roles (ADR 0172), moving the Expo web export into the image or elsewhere, replacing `deploy.sh`, and rewriting the runbooks. It is the largest item here and none of it exists.
- **Machine types.** Confidential VMs need specific families (for example N2D/C2D/C3); the current e2-micro target for the shrunken VM (ADR 0202) is not available. Expect a larger, dearer VM than the one ADR 0202 shrinks to. Price it before deciding.
- **Local state.** Uploaded files live on the VM disk (sealed, ADR 0201 phase 2) and the GeoLite2 database is rsynced in. A container needs a persistent disk mount or object storage for both.
- **Debuggability.** Operational debugging by `ssh` is gone in production. A debug image exists, but it attests as debug and is denied the key: by design, you cannot inspect the production process.
- **Verification.** None of this can be tried without a project, a billing account and an image build. Every flag and claim name above is from documentation and unverified.

## Cheaper controls that cover most of the same ground

None of these stop a determined root user, but they raise the cost and, more usefully, make abuse visible:

- Turn on **Data Access audit logs for Cloud KMS** and alert on any decrypt by a principal that is not the app's service account (already in the ADR 0201 runbook).
- **No standing human SSH**: OS Login with two-step verification, access granted per incident and expiring, and an alert on every login.
- The VM's service account has **only** `cryptoKeyEncrypterDecrypter` on the **content key** (ADR 0201 runbook), no other role, and the database key is separate.
- **Short DEK cache TTL** (`CONTENT_DEK_TTL_MS`) so an unwrapped key does not sit in memory for long. It shortens the window, it does not close it.
- Cloud SQL private IP with IAM database auth (ADR 0202), so the database is not reachable except from the VM.

## When to build it

Not now. The trigger is one of: a reviewer, customer or regulator requires that platform staff with VM access cannot read user mail; the deployment is being containerised anyway (then the incremental cost is the attestation policy, not the whole migration); or the user base grows to where insider risk is a real operating concern rather than a theoretical one.

If it is built, do it in this order: containerise web and worker with no behaviour change; move files and the GeoIP database off the VM disk; run the same image on an ordinary VM behind the existing key policy; then switch to Confidential Space and bind the key policy to the image digest, with the policy-change path itself audited.

## Rejected alternatives

- **Building it now** on top of the current rsync/systemd deploy: it cannot work on that model, and containerising is a larger project than the protection it serves at this stage.
- **A hardware security module (Cloud HSM) for the content key**: protects the key material from extraction from KMS itself, which was never the gap; the gap is the running process being able to ask for it.
- **Client-side encryption with keys held only on devices**: would end search, the bot and LLM inference over mail, which are the product; this is the constraint the whole of ADR 0201 was designed around.
- **Doing nothing and saying nothing**: the honest statement for a reviewer is the first section above, not silence. What Chord promises today is that database, backup, disk and log access yield ciphertext, not that Chord's own operators cannot read mail while a request is being served.
