import * as AuthSession from 'expo-auth-session';

// ADR 0080 - one multi-tenant Microsoft app covers Outlook.com + Microsoft 365.
// The Settings mailbox connect and Sign in with Microsoft (ADR 0293) ask for
// the same grant, so either door leaves the mailbox in the same state.
export const MS_DISCOVERY = {
  authorizationEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
  tokenEndpoint: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
};
export const OUTLOOK_SCOPES = [
  'openid',
  'email',
  'offline_access',
  'User.Read',
  'Mail.ReadWrite',
  'Mail.Send',
];
// ADR 0228 - asked for only when the server has Outlook calendars turned on.
export const OUTLOOK_CALENDAR_SCOPE = 'Calendars.ReadWrite';

/**
 * `select_account`, not `consent`: Microsoft reuses whichever account the
 * browser is already signed in to, so "add a mailbox" silently re-attached the
 * one already there (ADR 0320) - the same picker the secondary-Gmail connect
 * asks for (ADR 0080 addendum). Microsoft takes ONE prompt value, so these are
 * a choice rather than Google's space-separated pair; consent is not lost,
 * since a scope the account has not granted still raises its own prompt.
 */
export const MS_ADD_ACCOUNT_PROMPT = 'select_account';

/**
 * `<origin>/oauthredirect` on web, `chord://oauthredirect` in the apps (iOS and
 * Android alike - the reversed-client-id redirect is a Google-only convention,
 * ADR 0041, and Microsoft accepts the custom scheme, so Android needs no App
 * Link here unlike Google's ADR 0081).
 */
export function microsoftRedirectUri(): string {
  return AuthSession.makeRedirectUri({
    scheme: 'chord',
    path: 'oauthredirect',
    native: 'chord://oauthredirect',
  });
}
