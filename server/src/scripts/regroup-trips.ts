/**
 * One-off (ADR 0190): re-file existing trips under the traveler-chain rule.
 *
 * Trips created before ADR 0190 were grouped by date overlap, so one family
 * member's weekend can hold another's long-haul tickets. This re-runs the same
 * rules the live matcher now uses (`trips/chain.ts`) over what is already
 * filed: a leg moves only when its traveler's own chain — or the flight it
 * shares with a companion — says it belongs elsewhere.
 *
 * Conservative by construction: legs that name no traveler stay where they
 * are, cancelled legs are never moved, duplicates are REPORTED and left (each
 * leg owns a calendar event), and nothing is deleted — emptied trips are
 * soft-deleted like every other trip delete (ADR 0171).
 *
 * PLAN ONLY unless `--apply`. Each applied group writes an undo file.
 *
 * Usage (from the repo root):
 *   npm run regroup:trips --workspace=server                         # plan, every group
 *   npm run regroup:trips --workspace=server -- --user ownertest@gmail.com
 *   npm run regroup:trips --workspace=server -- --group <groupId>
 *   npm run regroup:trips --workspace=server -- --user <email> --apply
 *   npm run regroup:trips --workspace=server -- --undo <undo-file.json>
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { openDb } from '../db/index.js';
import { ensureDataDirs } from '../db/paths.js';
import {
  applyRegroupPlan,
  loadRegroupInput,
  planGroupRegroup,
  undoRegroup,
  type RegroupPlan,
  type RegroupTrip,
  type RegroupUndo,
} from '../services/trips/regroup.service.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function describePlan(plan: RegroupPlan, trips: RegroupTrip[]): string[] {
  const legs = new Map(trips.flatMap((t) => t.legs.map((l) => [l.id, l] as const)));
  const tripName = new Map(trips.map((t) => [t.id, t.name] as const));
  const label = (id: string) => tripName.get(id) ?? plan.ops.flatMap((o) => (o.kind === 'new_trip' && o.tripId === id ? [o.name] : []))[0] ?? id;
  const lines: string[] = [];
  for (const op of plan.ops) {
    if (op.kind === 'new_trip') {
      lines.push(`  + new trip  "${op.name}"  ${op.startDate} → ${op.endDate}`);
    } else if (op.kind === 'move_leg') {
      const l = legs.get(op.legId);
      const who = l ? l.passengerName ?? l.personaId ?? '(unnamed)' : op.legId;
      const what = l ? `${l.origin}→${l.destination} ${l.departAt.slice(0, 10)}` : '';
      lines.push(`  ~ move leg  ${who}  ${what}   "${label(op.fromTripId)}" → "${label(op.toTripId)}"`);
    } else {
      lines.push(`  ⇒ fold trip "${label(op.fromTripId)}" into "${label(op.intoTripId)}"`);
    }
  }
  if (plan.pinnedLegIds.length > 0) {
    lines.push(`  · left in place (no traveler named, or cancelled): ${plan.pinnedLegIds.length} leg(s)`);
  }
  for (const g of plan.duplicates) {
    lines.push(`  ! duplicate flight recorded ${g.length}×: ${g.join(', ')}  (reported, not removed)`);
  }
  return lines;
}

async function main() {
  ensureDataDirs();
  const db = openDb();

  const undoFile = arg('undo');
  if (undoFile) {
    const undo = JSON.parse(readFileSync(resolve(undoFile), 'utf8')) as RegroupUndo;
    await undoRegroup(db, undo);
    console.log(`Undone: ${undo.moves.length} move(s), ${undo.createdTrips.length} created trip(s) retired.`);
    await db.destroy();
    return;
  }

  const apply = process.argv.includes('--apply');
  const groupId = arg('group');
  const email = arg('user');
  const groupIds = new Set<string>();
  if (groupId) groupIds.add(groupId);
  if (email) {
    const rows = await db
      .selectFrom('group_members as gm')
      .innerJoin('users as u', 'u.id', 'gm.user_id')
      .select('gm.group_id')
      .where((eb) => eb(eb.fn('lower', ['u.email']), '=', email.toLowerCase()))
      .execute();
    if (rows.length === 0) {
      console.error(`No groups found for ${email}`);
      process.exit(1);
    }
    for (const r of rows) groupIds.add(r.group_id);
  }

  const input = await loadRegroupInput(db);
  const outDir = join(process.cwd(), 'regroup-undo');
  let changed = 0;
  for (const [gid, trips] of input) {
    if (groupIds.size > 0 && !groupIds.has(gid)) continue;
    const plan = planGroupRegroup(gid, trips);
    if (plan.ops.length === 0 && plan.duplicates.length === 0) continue;
    console.log(`\nGroup ${gid}  (${trips.length} trip(s))`);
    for (const line of describePlan(plan, trips)) console.log(line);
    if (plan.ops.length === 0) continue;
    changed++;
    if (apply) {
      const undo = await applyRegroupPlan(db, plan);
      mkdirSync(outDir, { recursive: true });
      const file = join(outDir, `regroup-${gid}-${Date.now()}.json`);
      writeFileSync(file, JSON.stringify(undo, null, 2));
      console.log(`  applied. undo: ${file}`);
    }
  }
  console.log(
    apply
      ? `\nDone: ${changed} group(s) regrouped.`
      : `\nPlan only — ${changed} group(s) would change. Re-run with --apply to write.`,
  );
  await db.destroy();
}

// Importing the trip services drags in the SSE hub, which opens Redis pub/sub
// connections when REDIS_URL is set (prod). Nothing here closes them, so
// without an explicit exit the process prints its result and then never ends.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
