/**
 * Words for the people a family deals with by ROLE (ADR 0275): "mail from the
 * dentist", "what did the school send". A role is not a name, so it is matched
 * against what a sender, a saved contact or an address-book entry says it is:
 * "Bright Smiles Dental", "Lincoln Elementary Office", company "Fixit
 * Plumbing", job title "Pediatrician".
 *
 * Every term is a whole word (or a two-word phrase) to look for. Deliberately
 * specific: a loose term ("health", "care", "center") would make every
 * newsletter a dentist. A role not listed here simply matches nothing and the
 * words are searched as words.
 */
const ROLES: Record<string, string[]> = {
  dentist: ['dentist', 'dentists', 'dental', 'dds', 'dmd', 'orthodontist', 'orthodontics', 'endodontist', 'periodontist'],
  orthodontist: ['orthodontist', 'orthodontics', 'braces'],
  doctor: ['doctor', 'physician', 'md', 'pediatrician', 'pediatrics', 'clinic', 'medical', 'family medicine', 'internal medicine'],
  pediatrician: ['pediatrician', 'pediatrics', 'pediatric'],
  vet: ['vet', 'veterinary', 'veterinarian', 'animal hospital'],
  pharmacy: ['pharmacy', 'pharmacist', 'cvs', 'walgreens', 'rite aid'],
  school: ['school', 'schools', 'elementary', 'middle school', 'high school', 'academy', 'pta', 'pto', 'school district', 'preschool', 'montessori'],
  teacher: ['teacher', 'teachers', 'classroom', 'homeroom'],
  daycare: ['daycare', 'day care', 'childcare', 'child care', 'preschool', 'nursery'],
  plumber: ['plumber', 'plumbing'],
  electrician: ['electrician', 'electrical contractor'],
  landlord: ['landlord', 'property management', 'leasing office'],
  accountant: ['accountant', 'cpa', 'tax preparer', 'bookkeeper', 'bookkeeping'],
  lawyer: ['lawyer', 'attorney', 'law office', 'law firm', 'esq'],
  insurance: ['insurance', 'insurer'],
  bank: ['bank', 'credit union'],
  coach: ['coach', 'coaching'],
  babysitter: ['babysitter', 'nanny', 'sitter'],
  therapist: ['therapist', 'therapy', 'counselor', 'counseling', 'psychologist'],
  optometrist: ['optometrist', 'optometry', 'eye doctor', 'ophthalmologist', 'vision center'],
  mechanic: ['mechanic', 'auto repair', 'auto shop', 'garage'],
  hoa: ['hoa', 'homeowners association'],
};

/** Plural and casual forms people ask with. */
const ALIASES: Record<string, string> = {
  dentists: 'dentist', 'dental office': 'dentist', orthodontists: 'orthodontist',
  doctors: 'doctor', doc: 'doctor', pediatricians: 'pediatrician', 'kids doctor': 'pediatrician',
  vets: 'vet', veterinarian: 'vet', pharmacist: 'pharmacy', schools: 'school', teachers: 'teacher',
  'day care': 'daycare', plumbers: 'plumber', attorney: 'lawyer', cpa: 'accountant',
  nanny: 'babysitter', sitter: 'babysitter', 'eye doctor': 'optometrist',
};

/**
 * The words a role is known by, or null when `asked` is not a role. Takes the
 * person part of a question ("the dentist", "my kids doctor", "Dentist").
 */
export function roleTerms(asked: string): string[] | null {
  const k = asked
    .toLowerCase()
    .replace(/^(?:the|my|our|kids'?|the kids'?)\s+/, '')
    .replace(/'s$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const key = ROLES[k] ? k : ALIASES[k];
  return key ? ROLES[key] : null;
}

/**
 * Does `text` contain one of the role's terms as a whole word (or phrase)?
 * "Bright Smiles Dental" has "dental"; "Dentalplans Weekly" does not.
 */
export function mentionsRole(text: string | null | undefined, terms: string[]): boolean {
  if (!text) return false;
  const words = ` ${text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  return terms.some((t) => words.includes(` ${t} `));
}
