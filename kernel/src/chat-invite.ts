import type { InviteByEmailResponse } from './types/group';

/** ADR 0318 - what to tell the inviter after an invite by email, in one line.
 *  Says only what happened: an email that could not go is never "sent". */
export function inviteOutcomeText(res: InviteByEmailResponse, email: string): string {
  switch (res.status) {
    case 'added':
      return `${res.name} is in the chat.`;
    case 'asked':
      return `${res.name} is on Chord - they'll get your invite to accept.`;
    case 'emailed':
      return res.email === 'queued'
        ? `Invite emailed to ${email} from your mailbox. They join when they open the link.`
        : `${email} isn't on Chord yet and no email could be sent from your mailbox - share the link instead.`;
  }
}
