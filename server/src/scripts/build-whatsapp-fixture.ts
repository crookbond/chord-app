/**
 * Generates a deterministic WhatsApp-style `.zip` export for demo purposes
 * and writes it to `server/fixtures/whatsapp-doe-family.zip`.
 *
 * Run via:  npm run fixture:whatsapp --workspace=server
 *
 * The chat content is curated to exercise each extraction pattern in
 * `MockLlmService.mockExtractionResponse`:
 *   - "remind me to …"         → create_task
 *   - "Costco … milk, bread …" → add_list_item
 *   - "https://…"              → save_link
 *   - "dinner at <Place>"      → save_place
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import AdmZip from 'adm-zip';

const FIXTURE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures',
);

const CHAT_LINES: string[] = [
  '[14/03/2024, 09:12:00] Priya: Morning folks. Let me know your thoughts on the trip',
  '[14/03/2024, 09:13:00] Arjun: I can do the week of April 15th. Flying from SFO',
  '[14/03/2024, 09:14:00] Meera: Same — I looked at flights, https://expedia.com/itinerary/DOE-APRIL',
  '[14/03/2024, 09:14:20] Priya: nice. Arjun can you remind me to confirm the car rental by Friday?',
  '[14/03/2024, 09:15:00] Arjun: sure',
  '[14/03/2024, 09:27:00] Meera: Also Costco run this weekend — we need milk, bread, eggs, sunscreen, towels',
  '[14/03/2024, 09:28:00] Priya: add beer to that please',
  '[15/03/2024, 18:30:00] Priya: IMG-20240315-WA0001.jpg (file attached)',
  '[15/03/2024, 18:30:30] Priya: view from the Airbnb — pool is amazing',
  '[15/03/2024, 20:02:00] Arjun: we should book dinner at Hog Island on the first night',
  '[15/03/2024, 20:02:40] Meera: yes! I can call them tomorrow',
  '[15/03/2024, 20:10:00] Priya: remind me to pack the swim stuff the night before',
  '[16/03/2024, 11:05:00] Arjun: DOC-20240316-WA0001.pdf (file attached)',
  '[16/03/2024, 11:05:10] Arjun: rental car confirmation attached — pickup SFO 4pm',
  '[16/03/2024, 11:06:00] Meera: awesome',
  '',
].map((line) => line);

function fakeJpegBytes(): Buffer {
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
    0xff, 0xd9,
  ]);
}

function fakePdfBytes(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n',
    'utf-8',
  );
}

function main(): void {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const zip = new AdmZip();
  zip.addFile('_chat.txt', Buffer.from(CHAT_LINES.join('\n'), 'utf-8'));
  zip.addFile('IMG-20240315-WA0001.jpg', fakeJpegBytes());
  zip.addFile('DOC-20240316-WA0001.pdf', fakePdfBytes());
  const out = path.join(FIXTURE_DIR, 'whatsapp-doe-family.zip');
  fs.writeFileSync(out, zip.toBuffer());
   
  console.log(`wrote ${out} (${fs.statSync(out).size} bytes)`);
}

main();
