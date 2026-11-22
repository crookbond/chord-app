# Microsoft publisher verification — accounts and status

Chord's Outlook mail and calendar connection (ADR 0080, ADR 0228) runs on
an Entra app registration. Until Microsoft lists Chord as a **verified
publisher**, the Microsoft consent screen shows the app as "unverified",
and many work or school organisations block it until their IT admin
approves it. Personal Outlook and Hotmail accounts work either way. This
page records which account does the Microsoft setup and how far the
verification has got. Sibling page: [google-oauth-verification.md](./google-oauth-verification.md).

## Accounts

| What | Value |
|---|---|
| Admin account for **all** Microsoft setup (Entra, app registration, Partner Center, publisher verification) | `hello@chordapp.ai` |
| Mail routing | `hello@chordapp.ai` and `admin@chordapp.ai` are both email lists whose only member is `john@chordapp.ai` |
| Entra directory | `crookbondhotmail.onmicrosoft.com`, the only directory. It was created by the owner's personal Hotmail sign-in, and `chordapp.ai` is a verified custom domain on it, so there is no other directory to switch to |
| App registration | "Chord", application (client) id `af713851-d6c8-4077-bdd3-c61b0eef000b` |
| Publisher domain | `chordapp.ai`, verified by `mobile/public/.well-known/microsoft-identity-association.json` |
| Partner Center legal entity | Family Grocery Trip Chat Agent LLC dba ChordApp.ai |
| Partner Center primary contact | John Doe, `hello@chordapp.ai` |

Use `hello@chordapp.ai` wherever Microsoft asks for an admin. Do the steps
below signed in as that one account. Partner Center refuses a personal
Microsoft account (for example `ownertest@hotmail.com`) as a user, and
shows only a vague "Something went wrong" message when you try.

## Status (2026-10-23)

- [x] Publisher domain `chordapp.ai` verified on the app
- [x] Enrolled in the **Microsoft AI Cloud Partner Program**. That is the
  program that issues the Partner ID; the Windows, Edge and Commercial
  Marketplace programs do not.
- [x] Contact verification
- [x] Identity verification (2026-10-23). It needed the Entra display name
  of `hello@chordapp.ai` to match the government ID, not "Admin".
- [x] Partner Center account verified. Account settings → Identifiers
  lists two Partner IDs for the same LLC: a **PartnerGlobal** ID (the
  company) and a **PartnerLocation** ID (its one office, NY). Every
  account gets both. Publisher verification takes the **PartnerGlobal**
  one. Partner Center asks that the Global ID be shared only with
  Microsoft, so it is not written here; read it from that page.
- [x] PartnerGlobal ID entered under Entra → App registrations → Chord →
  Branding & properties → Publisher verification, **Verify and save**
  succeeded (2026-10-23, as `hello@chordapp.ai`). Chord is a verified
  publisher. To redo it (for example on a new app registration), the
  account needs multi-factor sign-in on, an admin role in Partner Center,
  and ownership of the app or the Global Administrator role in Entra.

## What verification changes

- The consent screen shows a blue verified badge and the company name
  instead of "unverified". No code change or deploy is needed.
- Chord asks for `Mail.ReadWrite` and `Calendars.ReadWrite`. Those are not
  low-impact permissions, so an organisation that allows its users to
  consent only to low-impact permissions still requires its admin to
  approve Chord once, even after verification. Personal Outlook accounts
  are unaffected.
- Optional later, if Chord is sold to businesses: Microsoft 365 App
  Compliance (Publisher Attestation), also in Partner Center.
