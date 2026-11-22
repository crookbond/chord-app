/**
 * Which known model service a base URL points at, decided on the URL's host
 * alone. A pattern over the whole string is not enough: the base URL is the
 * user's to type, and `https://evil.example/?openrouter.ai` contains the name.
 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export const isOpenRouterUrl = (baseUrl: string | null | undefined): boolean =>
  !!baseUrl && hostOf(baseUrl) === 'openrouter.ai';

export const isOpenAiUrl = (baseUrl: string | null | undefined): boolean =>
  !!baseUrl && hostOf(baseUrl) === 'api.openai.com';
