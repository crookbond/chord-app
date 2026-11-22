/**
 * To-do and list-item writes from several writers at once (ADR 0311
 * addendum): two people in one family, and one person on two devices, each
 * sending what it saw before anyone changed anything. Every pair is sent at
 * several gaps; the rule must hold at all of them.
 */
import { API } from '@chord/kernel';

import { Checks, call, newKey, pair, signIn, tally, together, type Reply, type Scenario } from './harness.js';

const GAPS_MS = [0, 2, 10, 50, 250];

export const todoSync: Scenario = {
  name: 'todo-sync',
  about: 'two people and one person on two devices editing one list and its to-dos',
  async run(checks: Checks) {
    const phone = await signIn('conc-alex');
    const laptop = await signIn('conc-alex');
    const sam = await signIn('conc-sam');

    const group = await call(phone, 'POST', API.groups, { name: `Concurrency test ${Date.now()}`, kind: 'group' });
    if (group.status >= 300) throw new Error(`create group: ${group.status} ${JSON.stringify(group.body)}`);
    const groupId = group.body.id as string;
    try {
      await call(sam, 'POST', API.groupJoin, { inviteCode: group.body.inviteCode });
      const list = await call(phone, 'POST', API.groupLists(groupId), { name: 'Groceries' });
      const listId = list.body.id as string;

      const sync = (token: string, op: unknown): Promise<Reply> => call(token, 'POST', API.meTodoSync, { op }, newKey());
      const out = (r: Reply) => (r.status === 200 ? (r.body.outcome as string) : `HTTP ${r.status}`);
      const addItem = async (text: string) => (await call(phone, 'POST', API.listItems(listId), { text })).body as { id: string; text: string };
      const readList = async () => ((await call(phone, 'GET', API.meLists)).body as any[]).find((l) => l.id === listId);
      const readItem = async (id: string) => (await readList())?.items.find((i: any) => i.id === id) ?? null;
      const readTask = async (id: string) => ((await call(phone, 'GET', API.meTasks)).body as any[]).find((t) => t.id === id);
      const newTask = async (title: string) => (await call(phone, 'POST', API.groupTasks(groupId), { title })).body as { id: string; status: string };

      for (const [who, second] of [['two people', sam], ['one person, two devices', laptop]] as const) {
        for (const gap of GAPS_MS) {
          const tag = `${who}, ${gap} ms`;
          const s = `${who === 'two people' ? 'p' : 'd'}${gap}`;

          const eggs = await addItem(`eggs ${s}`);
          const [a1, b1] = await pair(gap,
            () => sync(phone, { type: 'item.update', itemId: eggs.id, set: { text: `12 eggs ${s}` }, expected: { text: eggs.text } }),
            () => sync(second, { type: 'item.update', itemId: eggs.id, set: { text: `free-range eggs ${s}` }, expected: { text: eggs.text } }));
          const kept = (await readItem(eggs.id))?.text;
          const winner = out(a1) === 'applied' ? `12 eggs ${s}` : `free-range eggs ${s}`;
          checks.expect(`${tag}: rename both - one kept, other asked`,
            [out(a1), out(b1)].sort().join() === 'applied,conflict' && kept === winner, `${out(a1)}|${out(b1)} -> ${kept}`);

          const milk = await addItem(`milk ${s}`);
          const tick = { type: 'item.update', itemId: milk.id, set: { checked: true }, expected: { checked: false } };
          const [a2, b2] = await pair(gap, () => sync(phone, tick), () => sync(second, tick));
          checks.expect(`${tag}: tick both - done once, nobody asked`,
            out(a2) === 'applied' && out(b2) === 'applied' && (await readItem(milk.id))?.checked === true, `${out(a2)}|${out(b2)}`);

          const bread = await addItem(`bread ${s}`);
          const [a3, b3] = await pair(gap,
            () => sync(phone, { type: 'item.update', itemId: bread.id, set: { checked: true }, expected: { checked: false } }),
            () => sync(second, { type: 'item.update', itemId: bread.id, set: { text: `sourdough ${s}` }, expected: { text: bread.text } }));
          const b3row = await readItem(bread.id);
          checks.expect(`${tag}: tick + rename - both land`,
            out(a3) === 'applied' && out(b3) === 'applied' && b3row?.text === `sourdough ${s}` && b3row?.checked === true, `${out(a3)}|${out(b3)}`);

          const apples = await addItem(`apples ${s}`);
          const [a4, b4] = await pair(gap,
            () => sync(phone, { type: 'item.update', itemId: apples.id, set: { text: `green apples ${s}` }, expected: { text: apples.text } }),
            () => sync(second, { type: 'item.delete', itemId: apples.id, expected: { text: apples.text, checked: false } }));
          const a4row = await readItem(apples.id);
          checks.expect(`${tag}: rename then delete - delete is asked, rename kept`,
            a4row ? out(a4) === 'applied' && out(b4) === 'conflict' && a4row.text === `green apples ${s}` : out(a4) === 'gone' && out(b4) === 'applied',
            `${out(a4)}|${out(b4)} -> ${a4row?.text ?? 'deleted'}`);

          const pears = await addItem(`pears ${s}`);
          const [a5, b5] = await pair(gap,
            () => sync(phone, { type: 'item.delete', itemId: pears.id, expected: { text: pears.text, checked: false } }),
            () => sync(second, { type: 'item.update', itemId: pears.id, set: { text: `bosc pears ${s}` }, expected: { text: pears.text } }));
          const a5row = await readItem(pears.id);
          checks.expect(`${tag}: delete then rename - never deleted over an unseen rename`,
            a5row ? out(a5) === 'conflict' && out(b5) === 'applied' : out(a5) === 'applied' && out(b5) === 'gone',
            `${out(a5)}|${out(b5)} -> ${a5row?.text ?? 'deleted'}`);

          await pair(gap,
            () => sync(phone, { type: 'item.add', tempId: `tmp_a${s}`, listId, text: `coffee ${s}` }),
            () => sync(second, { type: 'item.add', tempId: `tmp_b${s}`, listId, text: `coffee ${s}` }));
          const coffees = (await readList()).items.filter((i: any) => i.text === `coffee ${s}`).length;
          checks.expect(`${tag}: add the same item - one item`, coffees === 1, `${coffees} items`);

          const bill = await newTask(`Pay bill ${s}`);
          const [a8, b8] = await pair(gap,
            () => sync(phone, { type: 'task.update', taskId: bill.id, set: { dueAt: '2026-11-12T17:00:00.000Z' }, expected: { dueAt: null } }),
            () => sync(second, { type: 'task.update', taskId: bill.id, set: { title: `Pay water bill ${s}` }, expected: { title: `Pay bill ${s}` } }));
          const t8 = await readTask(bill.id);
          checks.expect(`${tag}: due date + title - both land`,
            out(a8) === 'applied' && out(b8) === 'applied' && t8?.title === `Pay water bill ${s}` && t8?.dueAt === '2026-11-12T17:00:00.000Z',
            `${out(a8)}|${out(b8)}`);

          const permit = await newTask(`Renew permit ${s}`);
          const [a9, b9] = await pair(gap,
            () => sync(phone, { type: 'task.update', taskId: permit.id, set: { status: 'done' }, expected: { status: permit.status } }),
            () => sync(second, { type: 'task.update', taskId: permit.id, set: { status: 'archived' }, expected: { status: permit.status } }));
          const status = (await readTask(permit.id))?.status;
          checks.expect(`${tag}: done vs dropped - one kept, other asked`,
            [out(a9), out(b9)].sort().join() === 'applied,conflict' && status === (out(a9) === 'applied' ? 'done' : 'archived'),
            `${out(a9)}|${out(b9)} -> ${status}`);

          await pair(gap,
            () => sync(phone, { type: 'task.create', tempId: `tmp_ta${s}`, groupId, title: `Call plumber ${s}` }),
            () => sync(second, { type: 'task.create', tempId: `tmp_tb${s}`, groupId, title: `Call plumber ${s}` }));
          const plumbers = ((await call(phone, 'GET', API.meTasks)).body as any[]).filter((t) => t.title === `Call plumber ${s}`).length;
          // App creates are not folded (ADR 0095); this records the current behaviour.
          checks.expect(`${tag}: add the same to-do - two to-dos (known, not folded)`, plumbers === 2, `${plumbers} to-dos`);
        }
      }

      const eggs = await addItem('race eggs');
      const renames = await together(20, (n) =>
        sync([phone, laptop, sam][n % 3], { type: 'item.update', itemId: eggs.id, set: { text: `race eggs ${n}` }, expected: { text: 'race eggs' } }));
      const rt = tally(renames.map(out));
      checks.expect('20 renames at once - exactly one kept', rt.applied === 1 && rt.conflict === 19, JSON.stringify(rt));

      const milk = await addItem('race milk');
      await sync(phone, { type: 'item.update', itemId: milk.id, set: { checked: true }, expected: { checked: false } });
      const unticks = await together(20, (n) =>
        sync([phone, laptop, sam][n % 3], { type: 'item.update', itemId: milk.id, set: { checked: false }, expected: { checked: true } }));
      const ut = tally(unticks.map(out));
      checks.expect('20 unticks at once - all applied', ut.applied === 20, JSON.stringify(ut));

      const key = newKey();
      const creates = await together(10, () =>
        call(phone, 'POST', API.meTodoSync, { op: { type: 'task.create', tempId: 'tmp_race', groupId, title: 'Race create' } }, key));
      const ct = tally(creates.map(out));
      const made = ((await call(phone, 'GET', API.meTasks)).body as any[]).filter((t) => t.title === 'Race create').length;
      checks.expect('one create sent 10 times with one key - one to-do', made === 1 && (ct.applied ?? 0) >= 1, `${JSON.stringify(ct)} -> ${made}`);
    } finally {
      await call(phone, 'DELETE', API.group(groupId));
    }
  },
};
