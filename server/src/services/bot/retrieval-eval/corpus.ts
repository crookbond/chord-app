/**
 * Labeled retrieval eval corpus.
 *
 * A small, realistic family-logistics document set plus a set of natural
 * questions, each tagged with the doc(s) that should answer it. Used by the
 * eval harness to score retrieval pipelines (baseline FTS vs. weighted vs.
 * LLM-assisted) on hit@k / MRR so every relevance change is measurable.
 *
 * Some queries are deliberately *paraphrased* away from the document's wording
 * ("kids' game" for a soccer practice doc, "shots" for an immunization record)
 * — those are where lexical FTS struggles and Tier-2 query expansion should
 * earn its keep.
 */

export interface CorpusDoc {
  /** Stable key used as the attachment id in the eval DB. */
  key: string;
  filename: string;
  mimeType: string;
  summary: string;
  extractedText: string;
  /** JSON image_meta (caption/ocrText/keyFacts) for image docs. */
  imageMeta?: string;
  /** Tier-2 — "questions this document answers", as an LLM would generate them
   *  at extraction (phrased the way users ask, not the way the doc reads). */
  answerableQuestions?: string[];
}

export interface EvalQuery {
  query: string;
  /** Doc key(s) that genuinely answer the question. */
  expected: string[];
  /** True when the wording is paraphrased away from the doc (synonym test). */
  paraphrase?: boolean;
}

export const CORPUS: CorpusDoc[] = [
  {
    key: 'flight',
    filename: 'flight-itinerary-sea-jfk.pdf',
    mimeType: 'application/pdf',
    summary: 'United Airlines itinerary, Seattle to New York, June 12.',
    extractedText:
      'United Airlines e-Ticket Itinerary. Passenger: John Doe. ' +
      'Flight UA 482 departs Seattle (SEA) June 12 at 9:05 AM, arrives New York (JFK) at 5:20 PM. ' +
      'Confirmation code ABC123. Seat 14C. Checked bags: 1.',
    answerableQuestions: [
      'When does our flight leave and when do we land?',
      'What is the flight confirmation code and seat?',
      'Which airline and flight number are we on to New York?',
    ],
  },
  {
    key: 'hotel',
    filename: 'marriott-confirmation.pdf',
    mimeType: 'application/pdf',
    summary: 'Marriott Downtown reservation, July 3 to July 6.',
    extractedText:
      'Marriott Downtown New York reservation confirmed. Guest: John Doe. ' +
      'Check-in Friday July 3, check-out Monday July 6. Room: 1 King. ' +
      'Confirmation number HX99821. Cancellation free until June 28.',
    answerableQuestions: [
      'What is our hotel reservation confirmation number?',
      'When do we check in and check out of the hotel?',
      'Where are we staying in New York?',
    ],
  },
  {
    key: 'immunization',
    filename: 'arjun-immunization-record.pdf',
    mimeType: 'application/pdf',
    summary: "Arjun's childhood immunization record from the pediatrician.",
    extractedText:
      'Pediatric Immunization Record. Patient: Arjun Doe. ' +
      'MMR vaccine (measles, mumps, rubella) administered March 14, 2019. ' +
      'DTaP series complete. Influenza given annually. Next booster due 2027.',
    answerableQuestions: [
      'What shots or vaccines has Arjun had?',
      'When did my son get his MMR / rubella shot?',
      'Are Arjun\'s immunizations up to date and when is the next booster?',
    ],
  },
  {
    key: 'soccer',
    filename: 'u10-soccer-roster.pdf',
    mimeType: 'application/pdf',
    summary: 'U10 soccer team roster and weekly practice schedule.',
    extractedText:
      'Riverside U10 Soccer — Fall season roster. Coach: Maria Santos. ' +
      'Practice every Tuesday and Thursday at 5:00 PM, Field 3. ' +
      'Home matches Saturdays 10 AM. Players: Arjun, Leo, Priya, Sam.',
    answerableQuestions: [
      'When is soccer practice?',
      "When are the kids' games this weekend?",
      'Who is the coach and who is on the team?',
    ],
  },
  {
    key: 'recipe',
    filename: 'dal-makhani-recipe.txt',
    mimeType: 'text/plain',
    summary: 'Dal makhani recipe with ingredients and steps.',
    extractedText:
      'Dal Makhani. Ingredients: 1 cup black lentils (urad), 1/4 cup kidney beans, ' +
      'butter, cream, tomato, ginger, garlic, garam masala. ' +
      'Soak lentils overnight. Simmer with spices for two hours. Finish with cream.',
    answerableQuestions: [
      "What's a good lentil dinner to make?",
      'How do I cook dal makhani and what ingredients do I need?',
    ],
  },
  {
    key: 'contractor',
    filename: 'kitchen-remodel-quote.pdf',
    mimeType: 'application/pdf',
    summary: 'Contractor quote for the kitchen remodel.',
    extractedText:
      'Bayside Renovations — Estimate. Project: kitchen remodel. ' +
      'New cabinets, quartz countertops, tile backsplash, labor. ' +
      'Total estimate $24,500. Deposit 30%. Estimated duration 5 weeks.',
    answerableQuestions: [
      'How much does the kitchen remodel cost?',
      'What does the contractor quote include and how long will it take?',
    ],
  },
  {
    key: 'insurance',
    filename: 'auto-insurance-policy.pdf',
    mimeType: 'application/pdf',
    summary: 'Auto insurance policy declarations and renewal.',
    extractedText:
      'GEICO Auto Policy Declarations. Policyholder: John Doe. ' +
      'Vehicle: 2021 Honda CR-V. Premium $1,180 per six months. ' +
      'Deductible $500 collision. Policy renews September 1.',
    answerableQuestions: [
      'When does the car insurance renew?',
      'What is the auto insurance premium and deductible?',
    ],
  },
  {
    key: 'receipt',
    filename: 'costco-receipt.jpg',
    mimeType: 'image/jpeg',
    summary: 'Grocery receipt. Tags: receipt, groceries, costco.',
    extractedText: '',
    imageMeta: JSON.stringify({
      caption: 'A printed Costco grocery receipt.',
      ocrText:
        'COSTCO WHOLESALE\nMILK 2x 6.98\nEGGS 4.49\nROTISSERIE CHICKEN 4.99\n' +
        'PAPER TOWELS 19.99\nSUBTOTAL 79.45\nTAX 7.55\nTOTAL 87.00',
      keyFacts: ['Total $87.00', 'Costco Wholesale', 'Includes milk, eggs, paper towels'],
      tags: ['receipt', 'groceries', 'costco'],
    }),
    answerableQuestions: [
      'How much did we spend on groceries at Costco?',
      'What did the Costco receipt total?',
    ],
  },
];

export const QUERIES: EvalQuery[] = [
  // Direct — wording overlaps the document.
  { query: 'when does our flight to New York leave', expected: ['flight'] },
  { query: 'what is our hotel confirmation number', expected: ['hotel'] },
  { query: 'when did Arjun get his rubella vaccine', expected: ['immunization'] },
  { query: 'what time is soccer practice', expected: ['soccer'] },
  { query: 'how do I make dal makhani', expected: ['recipe'] },
  { query: 'how much is the kitchen remodel estimate', expected: ['contractor'] },
  { query: 'when does the auto insurance policy renew', expected: ['insurance'] },
  { query: 'how much was the costco receipt total', expected: ['receipt'] },

  // Paraphrased — synonyms/intent, little lexical overlap. Tier-2 territory.
  { query: "when is the kids' game this weekend", expected: ['soccer'], paraphrase: true },
  { query: 'what shots has my son had', expected: ['immunization'], paraphrase: true },
  { query: "what's a good lentil dinner", expected: ['recipe'], paraphrase: true },
  { query: 'how much do I owe for the cabinets and countertops', expected: ['contractor'], paraphrase: true },
  { query: 'what did we spend on groceries', expected: ['receipt'], paraphrase: true },
];
