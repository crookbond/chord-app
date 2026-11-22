/**
 * ADR 0299 — "help me plan my day": read what is already fixed, ask what else
 * has to fit, then lay the day out. Nothing is written without a yes.
 */
import type { Skill } from './types.js';

export const planMyDay: Skill = {
  id: 'plan_my_day',
  title: 'Plan my day',
  when: '"plan my day", "help me plan today", "what should I do today", "how should I fit everything in"',
  command: 'plan',
  opensWithQuestion: false,
  instructions: [
    'You are helping the user plan TODAY (or the day they named).',
    'A plan for today starts at the user\'s current local time (in the prompt) and runs to the end of the day. Events and free time that are already over are not part of it: leave them out, and never put anything before the current time. A day the user names later than today (tomorrow, Friday) is planned in full.',
    'First read what is fixed: find_events for that day, list_tasks for open to-dos (due soon first), and get_my_availability for the free gaps (for today its line covers only the rest of the day). Use the weather line in the prompt if there is one. Do this before asking anything.',
    'Give a short overview (two or three lines: what is still ahead, what is due), then ask the current question below.',
    'Never invent events or to-dos: only what the tools returned, plus what the user tells you.',
  ].join(' '),
  steps: [
    {
      id: 'extras',
      ask: 'Anything else you need to fit in today?',
      choices: ['No, that\'s it'],
      saveWith: [],
      howToSave: 'Nothing is saved yet: what they said goes into the plan. Do not ask about it, just plan it.',
    },
  ],
  finish: [
    'Now give the plan: a short time-ordered list starting at the current time (for today) or the start of the day (for a later day), fixed events at their times, to-dos and the user\'s extras placed in the free gaps still ahead at sensible hours, the most urgent first. Say plainly what does not fit. If less than about two hours of today are left, say so and offer to plan tomorrow instead.',
    'Then offer, in one sentence, to add the new items as to-dos (create_task) or calendar events (create_event). Create them only if the user says yes.',
  ].join(' '),
};
