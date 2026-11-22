/**
 * ADR 0063 — billing status for the settings UI. `GET /me/billing`.
 */
import type { PlanPrices } from '../billing-plans';

export type LlmTier = 'byok' | 'premium' | 'oss';

/** ADR 0195/0231 — which subscription a checkout/plan is for. `system` is the
 *  individual plan; `family` is one payer covering up to FAMILY_SEATS people
 *  from a pooled allowance; `byok_base` is the bring-your-own-key base fee. */
export type SubscriptionPlan = 'system' | 'family' | 'byok_base';

/** ADR 0231 — monthly, or annual (twelve months for the price of eleven). */
export type BillingInterval = 'month' | 'year';

/** ADR 0231 — who sold the subscription. Decides where "manage" goes. */
export type SubscriptionSource = 'stripe' | 'apple';

export type PlanAvailabilityMap<T> = Record<'system' | 'family', Record<BillingInterval, T>>;

/** One price on the plan picker: is it purchasable on this deploy right now? */
export type PlanAvailability = Record<Exclude<SubscriptionPlan, 'byok_base'>, Record<BillingInterval, boolean>>;

/** ADR 0231 — the shape of the viewer's family plan, when they are on one. */
export interface FamilyStatus {
  /** `owner` pays; `member` is covered by someone else's plan. */
  role: 'owner' | 'member';
  /** People the plan covers, owner included. */
  seats: number;
  /** Seats taken or reserved by a pending invite, owner included. */
  seatsUsed: number;
  /** For a member: whose plan covers them. */
  ownerName?: string;
}

export interface BillingStatus {
  /** ADR 0194 — prepaid AI tokens remaining, debited by each premium turn's
   *  actual cost (not a flat per-turn rate). Reset (not added to) at the
   *  start of each billing period (ADR 0195) — always 0 for a pure BYOK
   *  user, who never touches this balance. */
  balance: number;
  /** Which model the user's turns run on right now. */
  tier: LlmTier;
  /** Human-readable model name for that tier. */
  model: string;
  /** False on a team/dev deploy — turns run on the premium model, never debited. */
  billingEnabled: boolean;
  /** ADR 0075/0195 — the system-key subscription's Stripe price is
   *  configured; the "Subscribe" button on that plan shows. */
  checkoutAvailable: boolean;
  /** ADR 0195 — the BYOK base plan's Stripe price is configured; only then
   *  does a BYOK user need (or get offered) a subscription at all. */
  byokCheckoutAvailable: boolean;
  /** ADR 0079/0195/0325 — why the user currently has (or lacks) AI access.
   *  `free` = still inside the one-time free token allowance.
   *  `byok_unpaid` is distinct from `none`: it means the BYOK base plan is
   *  configured and this user hasn't subscribed to it. */
  entitlement?: 'billing_off' | 'free' | 'tokens' | 'grandfathered' | 'byok' | 'byok_unpaid' | 'none';
  /** ADR 0325 — the one-time free allowance and how much of it is spent.
   *  Sent with `free`, and with `none` once it is used up; never for BYOK. */
  freeTokens?: { allowance: number; used: number };
  /**
   * ADR 0193 — token usage counter, visibility only (does not gate access;
   * `balance`/`entitlement` above still do that). Both omitted when
   * `tier === 'byok'` — the user's own key, their own cost, nothing for
   * Chord to show a total against.
   */
  tokensUsedThisMonth?: number;
  tokensQuotaPerMonth?: number;
  /** ADR 0231 — the subscription behind the entitlement, when there is one. */
  plan?: SubscriptionPlan;
  interval?: BillingInterval;
  source?: SubscriptionSource;
  /** ISO — when the current paid period ends (renews or lapses). */
  periodEnd?: string;
  /** ADR 0236 — a Stripe subscription that has been told not to renew: the
   *  plan keeps working until `periodEnd` and then lapses. Omitted when the
   *  state is unknown (App Store, no subscription, Stripe unreachable). */
  cancelsAtPeriodEnd?: boolean;
  /** ISO — when the monthly allowance next refills. Set when a plan or comp
   *  exists; the interesting case is a plan whose tokens are all used. */
  allowanceResetsAt?: string;
  /** ADR 0231 — present when the viewer owns or is covered by a family plan.
   *  For a family the used/quota above are the POOL's, not the viewer's own. */
  family?: FamilyStatus;
  /** ADR 0231 — the prices to display (configuration, not a client constant). */
  prices?: PlanPrices;
  /** ADR 0231 — which (plan, interval) pairs the web checkout can sell now. */
  checkoutPlans?: PlanAvailability;
  /** ADR 0231 — the app can sell through the App Store (RevenueCat is set up). */
  appleAvailable?: boolean;
  /** ADR 0231 — the App Store product id for each (plan, interval), as named
   *  in App Store Connect. Server-owned so the app never hardcodes them. */
  appleProducts?: PlanAvailabilityMap<string>;
  /** ADR 0238 - the BYOK base plan's monthly price as displayed (USD). */
  byokPriceUsd?: number;
  /** ADR 0238 - the App Store product id of the BYOK base plan. */
  appleByokProduct?: string;
  /** ADR 0252 - present while the user's own model key is failing in a way they
   *  can fix; absent when it works (or they have no key). */
  byokKeyIssue?: ByokKeyIssue;
}

/** ADR 0252 - the user's own AI key is out of credit or was rejected. */
export interface ByokKeyIssue {
  kind: 'credit' | 'auth';
  /** One plain sentence pair: what is wrong, and what is paused until it is fixed. */
  message: string;
  /** Where to add credit, when the provider has one. */
  topUpUrl?: string;
  /** Another way to get AI that is real on this deploy: `plan` = Chord sells plans; `system` =
   *  billing is off and Chord's own AI is free to use once the key is dropped. Absent = none. */
  fallback?: 'plan' | 'system';
  /** When this outage was first seen. */
  since: string;
}

/** ADR 0075/0195 — `POST /me/billing/checkout` request: which subscription.
 *  `platform` picks the success/cancel redirect shape — `'native'` deep-links
 *  back into the app (`chord://settings?checkout=…`) so the in-app browser
 *  closes itself instead of stranding the user on a web page; omitted/`'web'`
 *  keeps the `${WEB_ORIGIN}/settings?checkout=…` redirect. */
export interface CheckoutSessionRequest {
  plan: SubscriptionPlan;
  /** ADR 0231 — omitted = monthly. */
  interval?: BillingInterval;
  /** ADR 0231 — a single-use promo code; the first month is free. */
  code?: string;
  platform?: 'web' | 'native';
}

/** ADR 0231 — `POST /me/billing/portal` response: Stripe's hosted page for
 *  changing plan, updating the card, or cancelling. */
export interface BillingPortalResponse {
  url: string;
}

/** ADR 0236 — `POST /me/billing/renewal`: `renew: false` cancels at the end of
 *  the paid period (the plan works until then), `renew: true` undoes that. */
export interface SetRenewalRequest {
  renew: boolean;
}

export interface SetRenewalResponse {
  cancelsAtPeriodEnd: boolean;
  /** ISO — when the plan stops (cancel) or next renews (resume). */
  periodEnd: string | null;
}

/** ADR 0236 — `POST /me/billing/plan`: move the live Stripe subscription to
 *  another plan/interval. Charged now for the difference, and it resumes a
 *  subscription that was set to cancel. */
export interface ChangePlanRequest {
  plan: Exclude<SubscriptionPlan, 'byok_base'>;
  interval: BillingInterval;
}

export interface ChangePlanResponse {
  plan: Exclude<SubscriptionPlan, 'byok_base'>;
  interval: BillingInterval;
}

/** ADR 0075 — `POST /me/billing/checkout` response: the hosted Stripe URL. */
export interface CheckoutSessionResponse {
  url: string;
}
