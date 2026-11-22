# CHORD — Spec Addendum — WhatsApp Identity Resolution

> Three-tier trust model · Resolution flow · Access matrix · Known limitations

> _Imported from `Chord_Identity_concise.docx` (source docx is gitignored). Treat as **reference, not contract** — see [README.md](./README.md)._

# E. WhatsApp Identity Resolution

In WhatsApp, Chord sees phone numbers only. Identity resolution maps each number to a trust tier on every inbound message. Trust flows from the admin outward.

## E.1 Three-Tier Trust Model

| Trust tier | Condition | Effective role | Access |
| --- | --- | --- | --- |
| Tier 1 — Verified | OTP-verified via companion app | Assigned role (Adult/Teen/Child/Guest) | Full per role — including Adults only if Adult |
| Tier 2 — Admin-assigned | Admin linked number to persona in chord.app, no OTP | Admin-assigned role — trusted without verification | Same as Tier 1 |
| Tier 3 — Unknown | Number in WhatsApp group, no Chord persona at all | Read-only guest | Group public docs only. No Adults only. No task creation. No memory writes. |

## E.2 Resolution Flow

Runs on every @Chord message. Result cached in Redis for 60 minutes per (number, group) pair.

| Step | Check | Match → tier | No match |
| --- | --- | --- | --- |
| 1 | group_members WHERE wa_phone = X AND group_id = this_group | verified=true → Tier 1 · verified=false → Tier 2 | → Step 2 |
| 2 | personas with this number, unlinked | Found → Tier 2 | → Step 3 |
| 3 | WhatsApp group participant list | Number is in group but no Chord record | → Tier 3 — read-only guest |

## E.3 Access Matrix

| Capability | Tier 1 | Tier 2 | Tier 3 |
| --- | --- | --- | --- |
| Query group public docs | ✓ | ✓ | ✓ |
| Query Adults only docs | ✓ if Adult | ✓ if admin set Adult | ✗ |
| Query own private docs | ✓ | ✓ | ✗ — no persona |
| Create tasks | ✓ | ✓ | ✗ |
| Be assigned tasks | ✓ | ✓ | ✗ — no persona |
| Trigger memory writes | ✓ | ✓ | ✗ |
| Upload docs via WhatsApp forward | ✓ | ✓ | ✗ |
| @Chord queries answered | ✓ — full per role | ✓ — full per role | ✓ — public only |
| Appear in trip/completeness queries | ✓ | ✓ | ✗ |

## E.4 Upgrade Path

| From → To | Trigger | How |
| --- | --- | --- |
| Tier 3 → Tier 2 | Admin adds them as a persona in chord.app | Admin assigns name, role, wa_phone in settings. Next message resolves as Tier 2. |
| Tier 2 → Tier 1 | Member downloads app and completes OTP | OTP flow sets verified=true. Next message resolves as Tier 1. |
| Tier 3 → Tier 1 | Both steps happen in same session | Jumps directly to Tier 1. |

Admin dashboard surfaces all Tier 3 numbers with a prompt: 'Unknown member — add them to your group?'

## E.5 Known Limitation — Device Sharing

> Chord identifies users by phone number. If a teen uses a parent's phone, Chord responds with the parent's access level. This is undetectable and accepted. Phone possession = identity, consistent with how WhatsApp itself works. No friction mechanism is added.

## E.6 Schema

```
-- Additions to group_members
  wa_phone          string?     -- E.164, set by admin or OTP verification
  verified          boolean     -- true = OTP (Tier 1), false = admin-assigned (Tier 2)
  verified_at       timestamp?

-- Transient — admin dashboard only, not long-term storage
wa_unknown_numbers
  wa_phone, group_id, first_seen_at, last_seen_at, message_count

-- Redis identity cache
-- Key:  identity:{group_id}:{wa_phone}
-- Value: { tier, persona_id, role, verified }
-- TTL:  3600s
-- Invalidated on: OTP verification, admin role change, member removal
```

