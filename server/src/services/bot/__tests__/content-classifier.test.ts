/**
 * content_classifier — verifies the saves[] bucket lands in proposals
 * alongside tasks/listAdds/events. Uses vi.mock to stub the LLM so the
 * test is deterministic and doesn't need a network or API key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Kysely } from 'kysely';

import type { DB } from '@/db/schema.js';
import { createGroup } from '@/services/groups.service.js';
import { closeTestDb, createUser, openTestDb } from '@/__test-helpers__/db.js';

// Stub the LLM factory before importing the classifier so the dynamic
// import in classifyAndProposeContent resolves to our mock.
const mockComplete = vi.fn<(messages: unknown, opts?: unknown) => Promise<string>>();
vi.mock('@/services/llm/factory.js', () => {
  // Built on demand: `mockComplete` does not exist yet when this factory is hoisted.
  const llm = () => ({
    providerName: 'mock' as const,
    defaultModel: 'mock',
    supportsNativeTools: false,
    complete: mockComplete,
    stream: async function* () {
      yield { type: 'done', reason: 'stop' as const };
    },
  });
  // The classifier reaches the model through the one chooser (ADR 0257).
  return { getLlm: llm, getLlmForUser: async () => llm() };
});

const { classifyAndProposeContent } = await import('@/services/bot/content_classifier.js');
const { listProposalsForGroup } = await import('@/services/proposals.service.js');

describe('classifyAndProposeContent — saves[] proposals', () => {
  let db: Kysely<DB>;
  let groupId: string;
  let userId: string;
  let imagePath: string;

  beforeEach(async () => {
    db = await openTestDb();
    userId = await createUser(db, 'john', 'John');
    const g = await createGroup(db, {
      name: 'Family',
      kind: 'group',
      createdBy: userId,
    });
    groupId = g.id;

    // Write a tiny placeholder image to the temp dir — the file just
    // needs to exist; the LLM is stubbed and won't actually read it.
    imagePath = path.join(os.tmpdir(), `chord-test-${Date.now()}.png`);
    await fs.writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    // Insert a placeholder attachment row so proposals reference a real id.
    await db
      .insertInto('attachments')
      .values({
        id: 'a_test',
        scope_kind: 'group',
        scope_id: groupId,
        uploaded_by: userId,
        filename: 'screenshot.png',
        mime_type: 'image/png',
        size: 4,
        path: imagePath,
        summary: null,
        extracted_text: null,
        image_meta: null,
        pinned: 0,
        indexed_at: null,
        created_at: new Date().toISOString(),
      })
      .execute();

    mockComplete.mockReset();
  });

  afterEach(async () => {
    await closeTestDb(db);
    try {
      await fs.unlink(imagePath);
    } catch {
      /* ignore */
    }
  });

  it('proposes save_place for a restaurant screenshot with a cuisine tag', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        tasks: [],
        listAdds: [],
        events: [],
        saves: [
          {
            kind: 'place',
            title: 'Consulate',
            tags: ['restaurant', 'italian', 'date night'],
            note: 'West Village wine bar',
          },
        ],
      }),
    );
    await classifyAndProposeContent(db, {
      attachmentId: 'a_test',
      groupId,
      uploadedBy: userId,
      filename: 'screenshot.png',
      mimeType: 'image/png',
      imagePath,
      imageMeta: { ocrChars: 100, keyFacts: ['Consulate'], caption: 'Restaurant menu' } as never,
    });
    const proposals = await listProposalsForGroup(db, groupId);
    const placeProp = proposals.find((p) => p.toolName === 'save_place');
    expect(placeProp).toBeDefined();
    const placeArgs = JSON.parse(placeProp!.argsJson) as { name: string; tags: string[] };
    expect(placeArgs.name).toBe('Consulate');
    expect(placeArgs.tags).toContain('italian');
  });

  it('proposes save_media for a media screenshot and downgrades a no-URL link to media/article', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        tasks: [],
        listAdds: [],
        events: [],
        saves: [
          { kind: 'media', title: 'Tomorrow and Tomorrow and Tomorrow', mediaKind: 'book' },
          // No URL → should be downgraded to save_media kind=article.
          { kind: 'link', title: 'Anthropic essay on prompt design' },
        ],
      }),
    );
    await classifyAndProposeContent(db, {
      attachmentId: 'a_test',
      groupId,
      uploadedBy: userId,
      filename: 'screenshot.png',
      mimeType: 'image/png',
      imagePath,
      imageMeta: { ocrChars: 200, keyFacts: ['book'], caption: '' } as never,
    });
    const proposals = await listProposalsForGroup(db, groupId);
    const media = proposals.filter((p) => p.toolName === 'save_media');
    expect(media).toHaveLength(2);
    const kinds = media
      .map((m) => (JSON.parse(m.argsJson) as { kind: string }).kind)
      .sort();
    expect(kinds).toEqual(['article', 'book']);
    expect(proposals.find((p) => p.toolName === 'save_link')).toBeUndefined();
  });

  it('keeps save_link when a real URL is present', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        tasks: [],
        listAdds: [],
        events: [],
        saves: [
          {
            kind: 'link',
            title: 'NYT recipe',
            url: 'https://cooking.nytimes.com/recipes/123',
          },
        ],
      }),
    );
    await classifyAndProposeContent(db, {
      attachmentId: 'a_test',
      groupId,
      uploadedBy: userId,
      filename: 'screenshot.png',
      mimeType: 'image/png',
      imagePath,
      imageMeta: { ocrChars: 200, keyFacts: [], caption: '' } as never,
    });
    const proposals = await listProposalsForGroup(db, groupId);
    const link = proposals.find((p) => p.toolName === 'save_link');
    expect(link).toBeDefined();
    const linkArgs = JSON.parse(link!.argsJson) as { url: string };
    expect(linkArgs.url).toBe('https://cooking.nytimes.com/recipes/123');
  });

  it('proposes save_contact from a contact-card screenshot', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        tasks: [],
        listAdds: [],
        events: [],
        saves: [
          {
            kind: 'contact',
            title: 'Dr. Patel',
            note: 'Pediatrician — 555-2020',
            tags: ['physician'],
          },
        ],
      }),
    );
    await classifyAndProposeContent(db, {
      attachmentId: 'a_test',
      groupId,
      uploadedBy: userId,
      filename: 'screenshot.png',
      mimeType: 'image/png',
      imagePath,
      imageMeta: { ocrChars: 80, keyFacts: ['Dr. Patel'], caption: '' } as never,
    });
    const proposals = await listProposalsForGroup(db, groupId);
    const c = proposals.find((p) => p.toolName === 'save_contact');
    expect(c).toBeDefined();
    const cArgs = JSON.parse(c!.argsJson) as { name: string; tags: string[] };
    expect(cArgs.name).toBe('Dr. Patel');
    expect(cArgs.tags).toContain('physician');
  });

  it('still proposes tasks/lists/events alongside saves', async () => {
    mockComplete.mockResolvedValueOnce(
      JSON.stringify({
        tasks: [{ title: 'Email teacher about field trip' }],
        listAdds: [{ listName: 'Groceries', items: ['milk', 'eggs'] }],
        events: [],
        saves: [{ kind: 'place', title: 'Park Slope Library' }],
      }),
    );
    await classifyAndProposeContent(db, {
      attachmentId: 'a_test',
      groupId,
      uploadedBy: userId,
      filename: 'screenshot.png',
      mimeType: 'image/png',
      imagePath,
      imageMeta: { ocrChars: 200, keyFacts: [], caption: '' } as never,
    });
    const proposals = await listProposalsForGroup(db, groupId);
    const byTool = new Map<string, number>();
    for (const p of proposals) byTool.set(p.toolName, (byTool.get(p.toolName) ?? 0) + 1);
    expect(byTool.get('create_task')).toBe(1);
    expect(byTool.get('add_list_item')).toBe(1);
    expect(byTool.get('save_place')).toBe(1);
  });
});
