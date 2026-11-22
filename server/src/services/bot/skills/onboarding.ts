/**
 * ADR 0299 — getting to know a new user: who is in the family, school, home,
 * the briefing, and what to connect. Every step can be skipped, and a step
 * whose answer is already on record is never asked.
 */
import { env } from '../../../config/env.js';
import {
  choseBriefingTime,
  hasBirthday,
  hasConnectedAccount,
  hasPeople,
  knowsHome,
  knowsSchool,
  phoneDoneOrUnavailable,
  whatsappDoneOrUnavailable,
} from './checks.js';
import type { Skill } from './types.js';

export const onboarding: Skill = {
  id: 'onboarding',
  title: 'Getting to know you',
  when: 'a new user, or "help me set up", "get to know me", "let\'s set up Chord", "finish setting up"',
  command: 'onboard',
  opensWithQuestion: true,
  instructions: [
    'You are getting to know the user so Chord can help their family. Ask ONE question at a time, the current one below, in a warm and short way (one or two sentences).',
    'Save what they tell you with the tools the question names. Save everything they said, even when it answers a later question too: those questions are then skipped on their own.',
    'Never invent details they did not give (ages, dates, schools). A partial answer is fine: save what you have and go on to the next question. Do not ask follow-up questions about an answer.',
  ].join(' '),
  steps: [
    {
      id: 'household',
      ask: 'Who is in your family? A partner, kids (with their ages), anyone else you help look after.',
      choices: ['Just me'],
      saveWith: ['add_family_member', 'update_person'],
      howToSave:
        'One add_family_member per person, with `relationship` ("son", "wife", "mother-in-law") and no invite, then update_person with their notes when an age was given ("son, 9"). Someone without an account is added to the family chat as a family member the user looks after, whenever there is a family chat. For a partner or teen who would use Chord themselves, offer once to invite them (add_family_member again with invite true and their email or phone); never ask for a young child\'s contact details. "Just me" saves nothing.',
      known: hasPeople,
    },
    {
      id: 'birthdays',
      ask: 'When are their birthdays?',
      choices: ['Skip'],
      saveWith: ['add_important_date'],
      howToSave: 'One add_important_date per birthday given. A day and month without a year is fine.',
      known: hasBirthday,
    },
    {
      id: 'school',
      ask: 'Which school does each of the kids go to?',
      choices: ['No kids in school'],
      saveWith: ['update_person', 'set_email_route'],
      howToSave:
        'Add the school to that child\'s notes with update_person (keep what the notes already said). If the user has a shared family chat, you may offer once to send that school\'s email there with set_email_route, and only do it on a yes.',
      known: knowsSchool,
    },
    {
      id: 'home',
      ask: 'Where is home: which city, and which airport do you usually fly from?',
      saveWith: ['set_weather_location', 'remember_fact'],
      howToSave: 'The city goes to set_weather_location. The airport goes to remember_fact with key "home_airport".',
      known: knowsHome,
    },
    {
      id: 'phone',
      ask: 'What is your mobile number? I will text you a code to confirm it, so family can find you in Chord and your WhatsApp links up.',
      choices: ['Skip'],
      saveWith: ['verify_phone'],
      howToSave:
        'verify_phone with their number sends the code; when they reply with it, verify_phone with the code. The question is answered only once the result says verified: true. If they would rather not, skip it.',
      known: phoneDoneOrUnavailable,
    },
    {
      id: 'briefing',
      ask: 'I can send you a short briefing every morning: your day, what is due, anything that needs you. What time suits you?',
      choices: ['6:30 AM', '7:00 AM', '8:00 AM', 'No briefing'],
      saveWith: ['set_nudge_time'],
      howToSave: 'A time → set_nudge_time with that hour and minute. "No briefing" → set_nudge_time with enabled false.',
      known: choseBriefingTime,
    },
    {
      id: 'connect',
      ask: 'Do you want to connect your calendar and email? Then I can spot clashes and pick up things like school notices and bookings.',
      choices: ['Done', 'Skip'],
      saveWith: [],
      howToSave:
        'There is no tool for this: tell them it is in Settings → Connected accounts (Google, Outlook or other mail). When they say done, or later, mark the step answered.',
      known: hasConnectedAccount,
    },
    {
      id: 'whatsapp',
      ask: () =>
        `I also work on WhatsApp: message ${env.WHATSAPP_PUBLIC_NUMBER} from your phone and you can talk to me there.`,
      choices: ['Done', 'Skip'],
      saveWith: [],
      howToSave: 'Nothing to save. Mark the step answered once they have read it.',
      known: whatsappDoneOrUnavailable,
    },
  ],
  finish:
    'Setup is complete. Thank them in one sentence, and say they can ask "plan my day" or just tell you things as they come up.',
};
