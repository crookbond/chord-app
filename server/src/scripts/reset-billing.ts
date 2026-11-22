/**
 * Put ONE account's billing back to "never subscribed" so every purchase
 * scenario can be walked again (ADR 0236 addendum). Dry run unless `--apply`.
 *
 * It checks Stripe first: clearing our columns does not stop Stripe renewing,
 * and a renewal would re-grant the plan, so a still-renewing subscription is
 * refused unless you pass `--cancel-in-stripe`.
 *
 * Usage (on the VM):  cd /srv/chord && chord-with-env npm run billing:reset --workspace=server -- <flags>
 *   --email <address> | --user <userId>      who (required)
 *   --apply                                  write (default: report only)
 *   --cancel-in-stripe                       end a still-renewing subscription now
 *   --drop-customer                          also forget the Stripe customer id
 *   --clear-grandfather                      also remove the free founding-member allowance
 *   --created-at fresh|<ISO date>            move the sign-up time (fresh = now, which gives the
 *                                            free token allowance back); prints the old value
 *   --force                                  go ahead although Stripe could not be asked
 *   --allow-live                             permit an sk_live_ key
 */
import { openDb } from '../db/index.js';
import { ensureDataDirs } from '../db/paths.js';
import { resetBilling } from '../services/billing-reset.service.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(name);

const REFUSALS: Record<string, string> = {
  no_user: 'No such user. Pass --email <address> or --user <userId>.',
  bad_created_at: '--created-at must be fresh or an ISO date.',
  live_key: 'STRIPE_SECRET_KEY is a LIVE key. Pass --allow-live if you really mean it.',
  apple_active:
    'This plan is billed by Apple and still in its paid period; only the device can end it. Cancel it in iPhone Settings first, or pass --force.',
  stripe_unverified:
    'Could not read the Stripe subscription, so it is unknown whether it will renew. Re-run, or pass --force / --cancel-in-stripe.',
};

async function main(): Promise<void> {
  ensureDataDirs();
  const db = openDb();
  try {
    const userId = arg('--user');
    const email = arg('--email');
    if (!userId && !email) {
      console.error('usage: --email <address> | --user <userId>  [--apply] [--cancel-in-stripe] [--drop-customer] [--clear-grandfather] [--created-at fresh|<ISO>]');
      process.exitCode = 1;
      return;
    }
    const out = await resetBilling(db, { userId, email }, {
      apply: flag('--apply'),
      cancelInStripe: flag('--cancel-in-stripe'),
      dropCustomer: flag('--drop-customer'),
      clearGrandfather: flag('--clear-grandfather'),
      createdAt: arg('--created-at'),
      force: flag('--force'),
      allowLive: flag('--allow-live'),
    });
    if (!out.ok) {
      if (out.reason === 'stripe_renewing') {
        console.error(
          `Stripe says this subscription is "${out.stripeStatus}" and WILL renew. Clearing it here would not stop Stripe, and the next invoice would grant the plan again. Re-run with --cancel-in-stripe to end it now.`,
        );
      } else {
        console.error(REFUSALS[out.reason] ?? out.reason);
      }
      process.exitCode = 1;
      return;
    }
    console.log(`${out.username} (${out.userId})`);
    console.log(
      `stripe subscription: ${out.stripe.subscriptionId ?? 'none'}` +
        (out.stripe.status ? ` - ${out.stripe.status}${out.stripe.cancelsAtPeriodEnd ? ', ends at period end' : ''}` : ''),
    );
    if (out.changes.length === 0) console.log('nothing to change - already clean');
    for (const c of out.changes) console.log(`  ${c.field}: ${c.from ?? 'null'} -> ${c.to ?? 'null'}`);
    console.log(
      `left alone: stripe customer ${out.untouched.stripeCustomerId ?? 'none'}, ` +
        `grandfathered ${out.untouched.grandfatheredAt ?? 'no'}, family members ${out.untouched.familyMembers}`,
    );
    if (out.stripe.endedNow) console.log('ended the Stripe subscription now');
    console.log(out.applied ? 'applied' : 'dry run - pass --apply to write');
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
