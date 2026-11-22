/**
 * Pool of personas used by the load simulator.
 *
 * The two anchor users (john, alice) are always present and are
 * sprinkled across multiple groups to mirror the real user's group graph.
 * The remaining names are seeded into roughly 25 groups of 4 members.
 */
export interface Persona {
  username: string;
  displayName: string;
}

const RAW = [
  'Aarav Shah','Diya Patel','Nolan Iyer','Anaya Nair','Kabir Rao',
  'Mira Kapoor','Aryan Joshi','Saanvi Reddy','Reyansh Menon','Anika Bose',
  'Ishaan Pillai','Aadhya Sen','Vivaan Desai','Myra Chawla','Arjun Kulkarni',
  'Pari Subramanian','Neil Gupta','Riya Banerjee','Ayaan Mehta','Kiara Trivedi',
  'Liam Walker','Olivia Hughes','Noah Bennett','Emma Carter','Mason Reed',
  'Sophia Brooks','Lucas Hayes','Mia Wright','Ethan Cooper','Ava Bailey',
  'Logan Foster','Isabella Hayes','James Russell','Charlotte Long','Henry Price',
  'Amelia Ward','Daniel Ross','Harper Powell','Matthew Diaz','Ella Patterson',
  'Yuki Tanaka','Haruto Sato','Sakura Suzuki','Riku Watanabe','Hina Kobayashi',
  'Sora Yamamoto','Ren Nakamura','Aoi Saito','Itsuki Kato','Mei Inoue',
  'Min-jun Kim','Seo-yeon Lee','Ji-ho Park','Ha-eun Choi','Do-hyun Jung',
  'Su-bin Kang','Yu-jin Cho','Eun-woo Yoon','Soo-ah Han','Tae-hyun Lim',
  'Diego Ramirez','Sofia Castillo','Mateo Herrera','Camila Vargas','Alejandro Soto',
  'Valentina Ruiz','Sebastian Mendez','Isabella Cruz','Joaquin Flores','Lucia Romero',
  'Amari Johnson','Zara Williams','Malik Brown','Imani Davis','Jamal Wilson',
  'Aaliyah Thomas','Marcus Anderson','Nia Jackson','Andre White','Kendra Harris',
  'Lukas Müller','Emma Schmidt','Felix Weber','Lina Fischer','Jonas Becker',
  'Mila Wagner','Paul Hoffmann','Lara Schulz','Tim Bauer','Anna Krause',
  'Olivier Dubois','Camille Martin','Hugo Bernard','Léa Petit','Maxime Robert',
  'Chloé Richard','Antoine Moreau','Inès Laurent','Théo Simon','Manon Lefevre',
];

export const PERSONAS: Persona[] = [
  { username: 'john', displayName: 'John Doe' },
  { username: 'alice', displayName: 'Alice Doe' },
  ...RAW.slice(0, 98).map((full) => {
    const [first, last] = full.split(' ');
    const slug = (s: string) =>
      s
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9_.-]/g, '');
    return {
      username: `${slug(first)}_${slug(last ?? 'x') || 'x'}`,
      displayName: full,
    };
  }),
];

/**
 * Return `count` personas for a sim run: the curated pool first (so the anchors
 * john/alice are always present and named users appear in small runs), then
 * synthetic `simuser_N` fillers so the load sim can scale to hundreds of users
 * past the curated list.
 */
export function personasFor(count: number): Persona[] {
  if (count <= PERSONAS.length) return PERSONAS.slice(0, count);
  const out = [...PERSONAS];
  for (let i = PERSONAS.length; i < count; i++) {
    const n = i + 1;
    out.push({ username: `simuser_${n}`, displayName: `Sim User ${n}` });
  }
  return out;
}
