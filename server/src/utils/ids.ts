import { customAlphabet, nanoid } from 'nanoid';

const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const inviteCode = customAlphabet(INVITE_ALPHABET, 6);

export function newId(prefix: string, len = 12): string {
  return `${prefix}_${nanoid(len)}`;
}

export function newInviteCode(): string {
  return inviteCode();
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
}
