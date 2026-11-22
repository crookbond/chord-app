/**
 * ADR 0322 addendum — the starting tool groups come from the user's own words,
 * and ordinary conversation does not switch a group on. Prod (Nov 2026): most
 * turns started with 4-8 of the 8 groups (70-122 of 121 tools), because the
 * words were read out of the bot's own long replies and matched on "week",
 * "plan", "number", "message", "phone", "order", "colour".
 */
import { describe, expect, it } from 'vitest';

import { groupsForText } from '../tool-groups.js';

const ALL = ['calendar', 'trips', 'email', 'email_settings', 'people', 'chats', 'account', 'forms'];

/** message, the groups it must start, everything else must stay off. */
const CASES: Array<[string, string[]]> = [
  // The owner's everyday turns: core tools only.
  ['add milk, eggs and bread to the grocery list', []],
  ['Add bananas to the Costco list, the kids want them', []],
  ['add dinner Friday at 7', []],
  ['add dinner with my wife Friday at 7', []],
  ["what's on this week", []],
  ['what do we have planned next week?', []],
  ['plan my day', []],
  ['yes', []],
  ['that one', []],
  ['yes please, do it', []],
  ['remind me to call mom tomorrow at 9', []],
  ['move the dentist appointment to 3pm', []],
  ['cancel dinner on Friday', []],
  ['delete the soccer practice on Saturday', []],
  ['add the order number to the task', []],
  ['what color shirt should Ben wear', []],
  ['set up a meeting with Bill on Tuesday', []],
  ['schedule a call with the plumber for Monday morning', []],
  ['let me know when the package arrives', []],
  ['tell me what is due this week', []],
  ['how much does the camp cost', []],
  ['I have a book club meeting on Thursday', []],
  ['we are staying home this weekend', []],
  ['add "check in with grandma" to my to-dos', []],
  ['save this restaurant for date night', []],
  ['what is my phone plan renewal date', []],
  ['text of that note please', []],
  ['block 2-4pm Thursday for focus time', []],
  ['my son has a report card meeting', []],

  // Real asks still start their group.
  ['reply to that email', ['email']],
  ['reply to the email from the school', ['email']],
  ['any new mail from the school?', ['email']],
  ["what's in my inbox", ['email']],
  ['forward it to Alice', ['email']],
  ['how much did I spend at Amazon last month', ['email']],
  ['show my receipts from Costco', ['email']],
  ['unsubscribe me from macys', ['email_settings']],
  ['put emails from the school in a folder called School', ['email_settings', 'email']],
  ['change my email signature', ['email_settings']],
  ['add my flight to Denver on the 12th', ['trips']],
  ['what hotel are we staying at in Vail', ['trips']],
  ['plan a trip to Toronto in March', ['trips']],
  ['am I free Thursday afternoon?', ['calendar']],
  ['make my calendar color green', ['calendar']],
  ['invite karl.work@media.example to it', ['calendar']],
  ['who has RSVPed to the party', ['calendar']],
  ['count me in for dinner Saturday', ['calendar']],
  ["I can't make it to the barbecue", ['calendar']],
  ["who's coming to dinner?", ['calendar']],
  ['decline the party on Sunday', ['calendar']],
  ["what's mom's birthday", ['people']],
  ["what's the dentist's phone number", ['people']],
  ['add Sarah to my contacts', ['people']],
  ['add my sister to the family plan', ['people']],
  ['how many tokens have I used', ['account']],
  ['cancel my subscription', ['account']],
  ['connect me on WhatsApp', ['account']],
  ['send my morning briefing at 6:30', ['account']],
  ['what is the weather location set to', ['account']],
  ['block him', ['account']],
  ['message the family chat that dinner is at 7', ['chats']],
  ['tell her I will be late', ['chats']],
  ['delete the last 3 messages', ['chats']],
  ['leave the soccer group', ['chats']],
  ['fill out this permission form', ['forms']],
];

describe('tool group words (ADR 0322 addendum)', () => {
  it.each(CASES)('%s', (text, expected) => {
    const got = groupsForText(text);
    for (const g of expected) expect(got, `${g} should start`).toContain(g);
    for (const g of ALL.filter((x) => !expected.includes(x))) expect(got, `${g} should stay off`).not.toContain(g);
  });
});
