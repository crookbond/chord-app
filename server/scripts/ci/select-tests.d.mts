/** Types for select-tests.mjs (plain JS so CI can run it with bare node). */
export const ALWAYS: string[];
export function selectTests(changed: string[], everyTest: string[]): 'ALL' | string[];
export function listTests(serverDir: string): string[];
