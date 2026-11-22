/**
 * ADR 0231 — the AI Plan card: pick Individual or Family, monthly or annual,
 * and buy it the way this device is meant to (App Store on iOS, Stripe
 * checkout on web). Also shows what you already have and how to change it.
 *
 * Two rules decide most of what's drawn:
 *  - one seller per device: an iPhone build that can sell through the App
 *    Store never also shows a card form; web never shows the App Store.
 *  - the server owns prices, which products exist and what is purchasable
 *    (`BillingStatus.prices` / `checkoutPlans` / `appleProducts`), so a price
 *    change or a half-configured deploy needs no app release.
 *
 * ADR 0340 - an iPhone sells through the App Store (`IOS_IN_APP_PURCHASE`);
 * a plan bought on the web is reported there with one browser link, and a
 * build or server that cannot sell through the store falls back to ADR
 * 0241's report-only card. ADR 0263 - Android only reports the plan and
 * manages it in the browser, behind `ANDROID_BILLING_LINK_OUT`.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Linking,
  Platform,
  Pressable,
  Text,
  View,
} from 'react-native';
import { TextInput } from '@/text-input';
import * as WebBrowser from 'expo-web-browser';
import { router } from 'expo-router';

import {
  billingCardModel,
  formatPlanPrice,
  freeAllowanceHeadline,
  PLAN_LABEL,
  type BillingInterval,
  type BillingStatus,
  type SellablePlan,
  type SubscriptionPlan,
} from '@chord/kernel';

import {
  changeBillingPlan,
  createBillingCheckout,
  createBillingPortal,
  getBilling,
  setBillingRenewal,
  webSettingsUrl,
} from '@/api';
import { confirmDestructive } from '@/confirm';
import {
  APPLE_MANAGE_SUBSCRIPTIONS_URL,
  iapPurchase,
  iapProducts,
  iapRedeemCode,
  iapRestore,
  iapSupported,
  type IapProduct,
} from '@/iap';
import { colors, themed } from '@/theme';

// Stripe checkout (ADR 0075/0195) on native: the success/cancel redirect the
// server builds (platform: 'native') targets exactly this URL, so
// `WebBrowser.openAuthSessionAsync` recognizes it and auto-closes the in-app
// browser instead of stranding the user on a web page with no way back.
const NATIVE_CHECKOUT_RETURN_URL = 'chord://settings';

/**
 * ADR 0340 (reverses 0241) - an iPhone sells plans through the App Store.
 * App Review requires anything sold on the web to be buyable by In-App
 * Purchase too (guideline 3.1.1). Only when this build or server cannot sell
 * through the store does the card fall back to reporting the plan with a
 * browser link.
 */
export const IOS_IN_APP_PURCHASE = true;
/**
 * Connect OpenRouter (ADR 0235) still leaves the app for the browser on a
 * phone: it is OpenRouter's own sign-in and credit page, not a Chord sale.
 */
const IOS_BILLING_LINK_OUT = true;
/**
 * ADR 0263 - the same on Android: Google Play requires Play Billing for a
 * subscription sold inside the app, and Chord has none. False brings back the
 * in-app Stripe checkout, which Play would reject.
 */
export const ANDROID_BILLING_LINK_OUT = true;
/** True when this device sends OpenRouter's connect to the browser (and, off iOS, billing). */
export const BILLING_LINK_OUT =
  Platform.OS === 'ios' ? IOS_BILLING_LINK_OUT : Platform.OS === 'android' ? ANDROID_BILLING_LINK_OUT : false;

// The webhook that actually grants the subscription can land a moment after
// the redirect / the App Store sheet closes, so one `getBilling()` read right
// after is a race, not a confirmation - poll briefly instead. `isPaid` lets
// the caller say which state means "it landed".
export async function pollBillingAfterCheckout(
  isPaid: (status: BillingStatus) => boolean,
): Promise<BillingStatus | null> {
  const delaysMs = [800, 1200, 1800, 2500, 3500, 5000];
  let last: BillingStatus | null = null;
  for (const delayMs of delaysMs) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    last = await getBilling().catch(() => null);
    if (last && isPaid(last)) return last;
  }
  return last;
}

const isLive = (s: BillingStatus) => s.entitlement === 'tokens' || s.entitlement === 'byok';
export const isSubscriptionPaid = (plan: SubscriptionPlan) => (s: BillingStatus) =>
  isLive(s) && (plan === 'byok_base' ? s.entitlement === 'byok' : s.plan === plan);
/** The web redirect doesn't say which plan was bought; any live one counts. */
export const isEitherSubscriptionPaid = isLive;

const ERROR_TEXT: Record<string, string> = {
  invalid_code: "That code isn't valid. Check it and try again.",
  code_used: 'That code has already been used.',
  code_expired: 'That code has expired.',
  already_subscribed: 'You already have a plan. Use Manage to change it.',
  billing_unavailable: 'Purchasing is not available right now.',
  stripe_error: "That didn't go through and nothing changed. Try again in a moment.",
  no_subscription: "There's no paid plan of your own to change here.",
  payment_failed: 'Your card was declined, so nothing changed. Update your card and try again.',
  same_plan: 'That is already your plan.',
  not_switchable: "This plan can't be switched here.",
  apple: 'This plan is billed by Apple. Cancel it on your iPhone: Settings → Apple ID → Subscriptions.',
  iap_unsupported: 'This version of the app cannot buy through the App Store yet. Update the app and try again.',
};
const errorText = (e: unknown): string => {
  const m = (e as Error).message;
  return ERROR_TEXT[m] ?? m;
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

interface Props {
  billing: BillingStatus;
  userId: string;
  /** True while the web redirect return is still being confirmed. */
  confirming: boolean;
  onBilling: (b: BillingStatus | null) => void;
  /** ADR 0252 - drop the user's own key so a Chord plan applies. Settings owns the key. */
  onUseChordPlan?: () => void;
}

export function PlanCard({ billing, userId, confirming, onBilling, onUseChordPlan }: Props) {
  const [plan, setPlan] = useState<SellablePlan>('system');
  const [interval, setInterval_] = useState<BillingInterval>('year');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<null | 'buy' | 'portal' | 'restore' | 'redeem' | 'renew' | 'switch'>(null);
  // ADR 0236 - the in-app plan switcher; reuses `plan`/`interval` as its selection.
  const [changing, setChanging] = useState(false);
  // What just happened, so the card never leaves them guessing which plan they are on.
  const [notice, setNotice] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [store, setStore] = useState<Record<string, IapProduct>>({});

  const byok = billing.tier === 'byok' || billing.entitlement === 'byok_unpaid';
  const ios = Platform.OS === 'ios';
  // One seller per device: an iPhone that can sell through the App Store does,
  // and never shows Stripe's checkout; one that cannot only reports the plan.
  const useApple = ios && IOS_IN_APP_PURCHASE && !!billing.appleAvailable && iapSupported();
  const linkOut = ios ? !useApple : BILLING_LINK_OUT;
  // A plan bought on the web is managed on the web, even from an iPhone that
  // sells through the App Store: no Stripe charge or card form inside the app.
  const stripePlanOnIos = ios && billing.source !== 'apple';
  const prices = billing.prices;
  const hasPlan = !!billing.plan && !!billing.periodEnd && Date.parse(billing.periodEnd) > Date.now();

  // Store prices are localized and are what Apple will actually charge, so
  // they replace the configured display price once loaded.
  useEffect(() => {
    if (!useApple || !billing.appleProducts) return;
    // A bring-your-own-key user is only ever shown the base plan's product.
    const ids = byok
      ? billing.appleByokProduct
        ? [billing.appleByokProduct]
        : []
      : Object.values(billing.appleProducts).flatMap((p) => [p.month, p.year]);
    if (ids.length === 0) return;
    let cancelled = false;
    void iapProducts(userId, ids)
      .then((found) => {
        if (!cancelled) setStore(found);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [useApple, billing.appleProducts, billing.appleByokProduct, userId, byok]);

  const available = useCallback(
    (p: SellablePlan, i: BillingInterval) =>
      useApple ? true : !!billing.checkoutPlans?.[p]?.[i],
    [useApple, billing.checkoutPlans],
  );
  const priceLabel = (p: SellablePlan, i: BillingInterval): string => {
    const storeId = billing.appleProducts?.[p]?.[i];
    const fromStore = useApple && storeId ? store[storeId]?.priceString : undefined;
    if (fromStore) return `${fromStore}/${i === 'month' ? 'mo' : 'yr'}`;
    return prices ? formatPlanPrice(prices, p, i) : '';
  };

  // The interval/plan someone has selected may not be sellable on this
  // deploy; fall back to one that is rather than showing a dead button.
  useEffect(() => {
    if (available(plan, interval)) return;
    const alt = (['year', 'month'] as BillingInterval[]).find((i) => available(plan, i));
    if (alt) setInterval_(alt);
  }, [plan, interval, available]);

  const settle = useCallback(
    async (paid: (s: BillingStatus) => boolean) => {
      setWaiting(true);
      try {
        onBilling(await pollBillingAfterCheckout(paid));
      } finally {
        setWaiting(false);
      }
    },
    [onBilling],
  );

  const subscribeStripe = useCallback(
    async (p: SubscriptionPlan, i: BillingInterval, promo?: string) => {
      const { url } = await createBillingCheckout(p, Platform.OS === 'web' ? 'web' : 'native', {
        interval: i,
        code: promo,
      });
      if (Platform.OS === 'web') {
        window.location.href = url;
        return; // navigating away; the reloaded page re-fetches billing on mount
      }
      const result = await WebBrowser.openAuthSessionAsync(url, NATIVE_CHECKOUT_RETURN_URL);
      if (result.type !== 'success') return; // cancelled/dismissed - nothing changed
      if (new URL(result.url).searchParams.get('checkout') !== 'success') return;
      await settle(isSubscriptionPaid(p));
    },
    [settle],
  );

  const buy = useCallback(async () => {
    setBusy('buy');
    setErr(null);
    try {
      if (useApple) {
        const id = billing.appleProducts?.[plan]?.[interval];
        const product = id ? store[id] : undefined;
        if (!product) throw new Error('That plan is not available in the App Store yet. Try again in a moment.');
        if ((await iapPurchase(userId, product)) === 'purchased') await settle(isSubscriptionPaid(plan));
      } else {
        await subscribeStripe(plan, interval, code);
      }
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }, [useApple, billing.appleProducts, plan, interval, store, userId, settle, subscribeStripe, code]);

  const buyBase = useCallback(async () => {
    setBusy('buy');
    setErr(null);
    try {
      if (useApple) {
        const id = billing.appleByokProduct;
        const product = id ? store[id] : undefined;
        if (!product) throw new Error('That plan is not available in the App Store yet. Try again in a moment.');
        if ((await iapPurchase(userId, product)) === 'purchased') await settle(isSubscriptionPaid('byok_base'));
      } else {
        await subscribeStripe('byok_base', 'month');
      }
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }, [useApple, billing.appleByokProduct, store, userId, settle, subscribeStripe]);

  const manage = useCallback(async () => {
    setBusy('portal');
    setErr(null);
    try {
      if (billing.source === 'apple') {
        await Linking.openURL(APPLE_MANAGE_SUBSCRIPTIONS_URL);
        return;
      }
      const { url } = await createBillingPortal(Platform.OS === 'web' ? 'web' : 'native');
      if (Platform.OS === 'web') window.location.href = url;
      else {
        await WebBrowser.openAuthSessionAsync(url, NATIVE_CHECKOUT_RETURN_URL);
        onBilling(await getBilling().catch(() => null));
      }
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }, [billing.source, onBilling]);

  // ADR 0236 - cancel / resume without leaving the app. "Cancel" only stops the
  // next renewal; the plan works until the end of the period already paid for.
  const setRenewal = useCallback(
    async (renew: boolean) => {
      setBusy('renew');
      setErr(null);
      try {
        await setBillingRenewal(renew);
        const fresh = await getBilling().catch(() => null);
        if (fresh) onBilling(fresh);
        setNotice(renew ? 'Your plan will keep renewing.' : null);
      } catch (e) {
        setErr(errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [onBilling],
  );

  const confirmCancel = useCallback(() => {
    const until = billing.periodEnd ? formatDate(billing.periodEnd) : 'the end of this period';
    confirmDestructive(
      'Cancel your plan?',
      `Your plan keeps working until ${until}, then stops. You won't be charged again, and you can resume any time before then.`,
      () => void setRenewal(false),
      { confirmLabel: 'Cancel plan', cancelLabel: 'Keep plan' },
    );
  }, [billing.periodEnd, setRenewal]);

  const currentPlan = billing.plan === 'family' ? 'family' : 'system';
  const currentInterval: BillingInterval = billing.interval === 'year' ? 'year' : 'month';
  const isCurrent = (p: SellablePlan, i: BillingInterval) => p === currentPlan && i === currentInterval;

  // Open the switcher on the first option that is NOT what they already have.
  const openChange = useCallback(() => {
    const combos: Array<[SellablePlan, BillingInterval]> = [
      ['family', 'year'],
      ['family', 'month'],
      ['system', 'year'],
      ['system', 'month'],
    ];
    const first = combos.find(([p, i]) => !isCurrent(p, i) && available(p, i)) ?? combos[0]!;
    setPlan(first[0]);
    setInterval_(first[1]);
    setErr(null);
    setChanging(true);
    setNotice(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, currentPlan, currentInterval]);

  const doSwitch = useCallback(async () => {
    setBusy('switch');
    setErr(null);
    try {
      await changeBillingPlan(plan, interval);
      setChanging(false);
      // The server writes the new plan as soon as Stripe accepts it, so one read
      // shows it - no waiting on the webhook. A later read picks up the new
      // period dates once the invoice lands.
      const fresh = await getBilling().catch(() => null);
      if (fresh) onBilling(fresh);
      setNotice(`Switched to ${PLAN_LABEL[plan]} · ${interval === 'year' ? 'annual' : 'monthly'}.`);
      setTimeout(() => {
        void getBilling()
          .then((b) => onBilling(b))
          .catch(() => {});
      }, 4000);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }, [plan, interval, onBilling]);

  const confirmSwitch = useCallback(() => {
    const losesFamily = currentPlan === 'family' && plan === 'system' && (billing.family?.seatsUsed ?? 1) > 1;
    confirmDestructive(
      `Switch to ${PLAN_LABEL[plan]} (${interval === 'year' ? 'annual' : 'monthly'})?`,
      `The difference is charged or credited to your card now, and the new plan starts straight away.` +
        (billing.cancelsAtPeriodEnd ? ' Your cancelled plan is resumed.' : '') +
        (losesFamily ? ' The people on your family plan will no longer be covered.' : ''),
      () => void doSwitch(),
      { confirmLabel: 'Switch plan', cancelLabel: 'Keep my plan' },
    );
  }, [billing.cancelsAtPeriodEnd, billing.family?.seatsUsed, currentPlan, plan, interval, doSwitch]);

  const restore = useCallback(async () => {
    setBusy('restore');
    setErr(null);
    try {
      await iapRestore(userId);
      await settle(isLive);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }, [userId, settle]);

  const redeem = useCallback(async () => {
    setBusy('redeem');
    setErr(null);
    try {
      await iapRedeemCode(userId);
      await settle(isLive);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(null);
    }
  }, [userId, settle]);

  // ADR 0241 - one button for everything billing: a subscriber lands on their
  // billing page, anyone else on the web app's Settings. Always the browser.
  const manageOnWeb = useCallback(
    async (target: 'portal' | 'apple' | 'web') => {
      setBusy('portal');
      setErr(null);
      try {
        if (target === 'apple') {
          await Linking.openURL(APPLE_MANAGE_SUBSCRIPTIONS_URL);
        } else if (target === 'portal') {
          const { url } = await createBillingPortal('native');
          await Linking.openURL(url);
        } else {
          await Linking.openURL(webSettingsUrl());
        }
      } catch (e) {
        setErr(errorText(e));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  // Coming back from the browser, show what changed there.
  useEffect(() => {
    if (!linkOut && !(stripePlanOnIos && hasPlan)) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active') return;
      void getBilling()
        .then((b) => onBilling(b))
        .catch(() => {});
    });
    return () => sub.remove();
  }, [linkOut, stripePlanOnIos, hasPlan, onBilling]);

  const working = busy !== null || waiting || confirming;

  // A web-bought plan seen on an iPhone that sells through the App Store.
  const manageWebPlan = (
    <>
      <Pressable
        style={[s.ghost, working && s.disabled]}
        disabled={working}
        accessibilityRole="link"
        onPress={() => void manageOnWeb('portal')}
      >
        <Text style={s.ghostText}>{busy === 'portal' ? 'Opening…' : 'Manage billing ↗'}</Text>
      </Pressable>
      <Text style={s.caption}>This plan was bought on chordapp.ai, so it is changed in your browser.</Text>
    </>
  );

  // App Store guideline 3.1.2: the purchase screen says it renews and links the terms.
  const appleTerms = (
    <Text style={s.caption}>
      Payment is charged to your Apple Account. The subscription renews automatically unless you cancel
      it at least 24 hours before the period ends; manage or cancel it in your Apple Account settings.{' '}
      <Text style={s.inlineLink} accessibilityRole="link" onPress={() => router.push('/tos')}>
        Terms of Use
      </Text>
      {' · '}
      <Text style={s.inlineLink} accessibilityRole="link" onPress={() => router.push('/privacy')}>
        Privacy Policy
      </Text>
    </Text>
  );

  // ── Phones: report the plan, send every billing action to the browser ──
  if (linkOut) {
    const m = billingCardModel(billing, Date.now());
    return (
      <View style={s.card}>
        <Text style={s.label}>{m.label}</Text>
        <Text style={s.status}>{m.headline}</Text>
        {m.period ? (
          m.period.kind === 'cancelled' ? (
            <Text style={s.warn}>
              Cancelled - your plan works until {formatDate(m.period.until)}, then stops.
            </Text>
          ) : (
            <Text style={s.muted}>
              {m.period.kind === 'renews' ? 'Renews' : 'Renews or ends'} {formatDate(m.period.until)}
              {m.period.viaApple ? ' · billed by Apple' : ''}
            </Text>
          )
        ) : null}
        {m.note ? <Text style={s.muted}>{m.note}</Text> : null}
        {m.tokensSpent ? (
          <Text style={s.warn}>
            {m.tokensSpent.family ? "The family's" : 'Your'} tokens for this month are all used. They
            refill on {formatDate(m.tokensSpent.refillsAt)}.
          </Text>
        ) : null}
        {m.manage ? (
          <>
            <Pressable
              style={[s.btn, working && s.disabled]}
              disabled={working}
              accessibilityRole="link"
              onPress={() => void manageOnWeb(m.manage!.target)}
            >
              <Text style={s.btnText}>{busy === 'portal' ? 'Opening…' : 'Manage billing ↗'}</Text>
            </Pressable>
            <Text style={s.caption}>Opens in your browser</Text>
          </>
        ) : null}
        {err ? <Text style={s.err}>{err}</Text> : null}
      </View>
    );
  }

  // ── bring-your-own-key users pay only the base fee ────────────────────
  if (byok) {
    // ADR 0251 - the server sends the base price only while a base fee is
    // charged; without it BYOK is free and there is nothing to buy or manage.
    if (billing.byokPriceUsd == null && !hasPlan) {
      return (
        <View style={s.card}>
          <Text style={s.label}>Chord plan</Text>
          <Text style={s.status}>Using your own key - free</Text>
          <Text style={s.muted}>Chord does not charge for the AI when you use your own model key.</Text>
          {billing.byokKeyIssue ? <Text style={s.warn}>{billing.byokKeyIssue.message}</Text> : null}
          {billing.byokKeyIssue?.fallback === 'plan' && onUseChordPlan ? (
            <Pressable style={s.ghost} onPress={onUseChordPlan}>
              <Text style={s.ghostText}>Use a Chord plan instead</Text>
            </Pressable>
          ) : null}
        </View>
      );
    }
    // What it costs: the store's own localized string on iOS, else the configured price.
    const storePrice = useApple && billing.appleByokProduct ? store[billing.appleByokProduct]?.priceString : undefined;
    const basePrice = storePrice
      ? `${storePrice}/mo`
      : billing.byokPriceUsd
        ? `$${billing.byokPriceUsd.toFixed(2)}/mo`
        : '';
    // The base plan is theirs to end only when they pay for it themselves.
    const ownBase = hasPlan && billing.plan === 'byok_base' && billing.family?.role !== 'member';
    const canSubscribe = (billing.byokCheckoutAvailable || useApple) && billing.entitlement !== 'byok';
    return (
      <View style={s.card}>
        <Text style={s.label}>Chord base plan</Text>
        <Text style={s.muted}>
          Using your own model key needs a small base plan - it covers Chord&apos;s own hosting and
          messaging costs, not AI usage.
        </Text>
        <Text style={s.status}>
          {billing.entitlement === 'byok_unpaid'
            ? 'Subscribe to the base plan'
            : 'Using your own key - subscribed'}
        </Text>
        {notice ? <Text style={s.ok}>{notice}</Text> : null}
        {ownBase && billing.periodEnd ? (
          billing.cancelsAtPeriodEnd ? (
            <Text style={s.warn}>
              Cancelled - your base plan works until {formatDate(billing.periodEnd)}, then stops.
            </Text>
          ) : (
            <Text style={s.muted}>
              {billing.cancelsAtPeriodEnd === false ? 'Renews' : 'Renews or ends'} {formatDate(billing.periodEnd)}
              {billing.source === 'apple' ? ' · billed by Apple' : ''}
            </Text>
          )
        ) : null}
        {ownBase && stripePlanOnIos ? manageWebPlan : null}
        {ownBase && billing.source !== 'apple' && !ios ? (
          billing.cancelsAtPeriodEnd ? (
            <Pressable style={[s.btn, working && s.disabled]} disabled={working} onPress={() => void setRenewal(true)}>
              <Text style={s.btnText}>{busy === 'renew' ? 'Resuming…' : 'Resume plan'}</Text>
            </Pressable>
          ) : (
            <>
              <Pressable style={[s.ghost, working && s.disabled]} disabled={working} onPress={confirmCancel}>
                <Text style={s.ghostText}>{busy === 'renew' ? 'Cancelling…' : 'Cancel plan'}</Text>
              </Pressable>
              <Pressable disabled={working} onPress={() => void manage()}>
                <Text style={s.link}>{busy === 'portal' ? 'Opening…' : 'Update payment card'}</Text>
              </Pressable>
            </>
          )
        ) : null}
        {ownBase && billing.source === 'apple' ? (
          <Pressable style={[s.ghost, working && s.disabled]} disabled={working} onPress={() => void manage()}>
            <Text style={s.ghostText}>{busy === 'portal' ? 'Opening…' : 'Manage in the App Store'}</Text>
          </Pressable>
        ) : null}
        {canSubscribe ? (
          <>
            <Pressable style={[s.btn, working && s.disabled]} disabled={working} onPress={() => void buyBase()}>
              <Text style={s.btnText}>
                {confirming || waiting
                  ? 'Confirming subscription…'
                  : busy === 'buy'
                    ? 'Opening…'
                    : `${useApple ? 'Subscribe with the App Store' : 'Subscribe'}${basePrice ? ` · ${basePrice}` : ''}`}
              </Text>
            </Pressable>
            {useApple ? (
              <>
                <View style={s.row}>
                  <Pressable style={[s.ghost, working && s.disabled]} disabled={working} onPress={() => void redeem()}>
                    <Text style={s.ghostText}>Redeem a code</Text>
                  </Pressable>
                  <Pressable style={[s.ghost, working && s.disabled]} disabled={working} onPress={() => void restore()}>
                    <Text style={s.ghostText}>Restore purchases</Text>
                  </Pressable>
                </View>
                {appleTerms}
              </>
            ) : null}
          </>
        ) : null}
        {err ? <Text style={s.err}>{err}</Text> : null}
      </View>
    );
  }

  // ── already covered: say by what, and how to change it ────────────────
  const covered = billing.family?.role === 'member';
  const headline = covered
    ? `Covered by ${billing.family?.ownerName ?? 'a family member'}'s family plan`
    : hasPlan && billing.plan && billing.plan !== 'byok_base'
      ? `${PLAN_LABEL[billing.plan]} · ${billing.interval === 'year' ? 'annual' : 'monthly'}`
      : billing.entitlement === 'grandfathered'
        ? 'Founding member - your monthly allowance is free'
        : billing.entitlement === 'billing_off'
          ? 'Everything is free on this server'
          : billing.entitlement === 'free'
            ? freeAllowanceHeadline(billing)
            : `${freeAllowanceHeadline(billing)} - subscribe to keep Chord going`;
  const canBuy =
    !hasPlan && !covered && billing.entitlement !== 'billing_off' && billing.entitlement !== 'grandfathered';

  return (
    <View style={s.card}>
      <Text style={s.label}>Chord plan</Text>
      <Text style={s.status}>{headline}</Text>
      {notice ? <Text style={s.ok}>{notice}</Text> : null}
      {hasPlan && billing.periodEnd ? (
        billing.cancelsAtPeriodEnd ? (
          <Text style={s.warn}>
            Cancelled - your plan works until {formatDate(billing.periodEnd)}, then stops.
          </Text>
        ) : (
          <Text style={s.muted}>
            {billing.cancelsAtPeriodEnd === false ? 'Renews' : 'Renews or ends'} {formatDate(billing.periodEnd)}
            {billing.source === 'apple' ? ' · billed by Apple' : ''}
          </Text>
        )
      ) : null}
      {covered ? (
        <Text style={s.muted}>
          Your tokens are shared with the rest of the family, so when one person uses a lot there is
          less for the others.
        </Text>
      ) : null}
      {(hasPlan || covered || billing.entitlement === 'grandfathered' || billing.allowanceResetsAt) &&
      billing.entitlement === 'none' &&
      billing.allowanceResetsAt ? (
        <Text style={s.warn}>
          {covered || billing.family ? "The family's" : 'Your'} tokens for this month are all used.
          They refill on {formatDate(billing.allowanceResetsAt)}.
        </Text>
      ) : null}

      {hasPlan && !covered && stripePlanOnIos ? manageWebPlan : null}

      {hasPlan && !covered && billing.source !== 'apple' && !ios ? (
        billing.cancelsAtPeriodEnd ? (
          <Pressable style={[s.btn, working && s.disabled]} disabled={working} onPress={() => void setRenewal(true)}>
            <Text style={s.btnText}>{busy === 'renew' ? 'Resuming…' : 'Resume plan'}</Text>
          </Pressable>
        ) : (
          <Pressable style={[s.ghost, working && s.disabled]} disabled={working} onPress={confirmCancel}>
            <Text style={s.ghostText}>{busy === 'renew' ? 'Cancelling…' : 'Cancel plan'}</Text>
          </Pressable>
        )
      ) : null}

      {hasPlan && !covered && billing.source !== 'apple' && !ios && prices ? (
        changing ? (
          <>
            <Text style={s.muted}>
              Now on {PLAN_LABEL[currentPlan]} · {currentInterval === 'year' ? 'annual' : 'monthly'}. Pick
              what to switch to.
            </Text>
            <View style={s.row}>
              {(['system', 'family'] as SellablePlan[]).map((p) => (
                <Pressable key={p} style={[s.seg, plan === p && s.segOn]} onPress={() => setPlan(p)}>
                  <Text style={[s.segText, plan === p && s.segTextOn]}>{PLAN_LABEL[p]}</Text>
                  <Text style={[s.segSub, plan === p && s.segTextOn]}>{priceLabel(p, 'month')}</Text>
                </Pressable>
              ))}
            </View>
            <View style={s.row}>
              {(['month', 'year'] as BillingInterval[]).map((i) => (
                <Pressable
                  key={i}
                  disabled={!available(plan, i)}
                  style={[s.seg, interval === i && s.segOn, !available(plan, i) && s.disabled]}
                  onPress={() => setInterval_(i)}
                >
                  <Text style={[s.segText, interval === i && s.segTextOn]}>
                    {i === 'month' ? 'Monthly' : 'Annual'}
                  </Text>
                  <Text style={[s.segSub, interval === i && s.segTextOn]}>{priceLabel(plan, i)}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable
              style={[s.btn, (working || isCurrent(plan, interval) || !available(plan, interval)) && s.disabled]}
              disabled={working || isCurrent(plan, interval) || !available(plan, interval)}
              onPress={confirmSwitch}
            >
              <Text style={s.btnText}>
                {busy === 'switch' || waiting
                  ? 'Switching…'
                  : isCurrent(plan, interval)
                    ? 'This is your current plan'
                    : `Switch to ${PLAN_LABEL[plan]} · ${priceLabel(plan, interval)}`}
              </Text>
            </Pressable>
            <Pressable style={[s.ghost, working && s.disabled]} disabled={working} onPress={() => setChanging(false)}>
              <Text style={s.ghostText}>Keep my plan</Text>
            </Pressable>
          </>
        ) : (
          <>
            {billing.plan !== 'byok_base' ? (
              <Pressable style={[s.ghost, working && s.disabled]} disabled={working} onPress={openChange}>
                <Text style={s.ghostText}>Change plan</Text>
              </Pressable>
            ) : null}
            <Pressable disabled={working} onPress={() => void manage()}>
              <Text style={s.link}>{busy === 'portal' ? 'Opening…' : 'Update payment card'}</Text>
            </Pressable>
          </>
        )
      ) : null}

      {hasPlan && !covered && billing.source === 'apple' ? (
        <Pressable style={[s.ghost, working && s.disabled]} disabled={working} onPress={() => void manage()}>
          <Text style={s.ghostText}>{busy === 'portal' ? 'Opening…' : 'Manage in the App Store'}</Text>
        </Pressable>
      ) : null}

      {canBuy && prices ? (
        <>
          <Text style={s.muted}>
            Replies, email insights and briefings share one monthly token allowance that resets every
            month. A family plan shares one pool between up to 4 people - when one is out, the others
            keep going until the whole family is used up.
          </Text>
          <View style={s.row}>
            {(['system', 'family'] as SellablePlan[]).map((p) => (
              <Pressable key={p} style={[s.seg, plan === p && s.segOn]} onPress={() => setPlan(p)}>
                <Text style={[s.segText, plan === p && s.segTextOn]}>{PLAN_LABEL[p]}</Text>
                <Text style={[s.segSub, plan === p && s.segTextOn]}>{priceLabel(p, 'month')}</Text>
              </Pressable>
            ))}
          </View>
          <View style={s.row}>
            {(['month', 'year'] as BillingInterval[]).map((i) => (
              <Pressable
                key={i}
                disabled={!available(plan, i)}
                style={[s.seg, interval === i && s.segOn, !available(plan, i) && s.disabled]}
                onPress={() => setInterval_(i)}
              >
                <Text style={[s.segText, interval === i && s.segTextOn]}>
                  {i === 'month' ? 'Monthly' : 'Annual'}
                </Text>
                <Text style={[s.segSub, interval === i && s.segTextOn]}>{priceLabel(plan, i)}</Text>
              </Pressable>
            ))}
          </View>
          <Text style={s.caption}>Annual is twelve months for the price of eleven.</Text>

          {!useApple ? (
            <TextInput
              style={s.input}
              value={code}
              onChangeText={setCode}
              placeholder="Promo code (optional)"
              placeholderTextColor={colors.muted}
              autoCapitalize="characters"
              autoCorrect={false}
            />
          ) : null}
          {!useApple && code.trim() ? (
            <Text style={s.muted}>The first month is free; your card is charged when it ends.</Text>
          ) : null}

          <Pressable
            style={[s.btn, (working || !available(plan, interval)) && s.disabled]}
            disabled={working || !available(plan, interval)}
            onPress={() => void buy()}
          >
            {working ? (
              <View style={s.busyRow}>
                <ActivityIndicator color={colors.onAccent} />
                <Text style={s.btnText}>
                  {confirming || waiting ? 'Confirming subscription…' : 'Opening…'}
                </Text>
              </View>
            ) : (
              <Text style={s.btnText}>
                {useApple ? 'Subscribe with the App Store' : 'Subscribe'} · {priceLabel(plan, interval)}
              </Text>
            )}
          </Pressable>

          {useApple ? (
            <>
              <View style={s.row}>
                <Pressable style={[s.ghost, working && s.disabled]} disabled={working} onPress={() => void redeem()}>
                  <Text style={s.ghostText}>Redeem a code</Text>
                </Pressable>
                <Pressable style={[s.ghost, working && s.disabled]} disabled={working} onPress={() => void restore()}>
                  <Text style={s.ghostText}>Restore purchases</Text>
                </Pressable>
              </View>
              {appleTerms}
            </>
          ) : null}
        </>
      ) : null}
      {err ? <Text style={s.err}>{err}</Text> : null}
    </View>
  );
}

const s = themed((colors) => ({
  card: {
    backgroundColor: colors.card,
    borderRadius: 12,
    padding: 16,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: 16,
  },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.6 },
  status: { color: colors.text, fontSize: 15, fontWeight: '600', marginTop: 6 },
  muted: { color: colors.muted, fontSize: 13, marginTop: 6 },
  // Choices and actions are content-width pills, not bars stretched across the
  // screen: a picker and a buy button are small decisions, and a full-width
  // button reads as the page's one big action even when it is not.
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  // All four choices share one fixed size (label over price), so the two rows
  // line up whatever the text says.
  seg: {
    width: 128,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 16,
    paddingVertical: 7,
    alignItems: 'center',
  },
  segOn: { borderColor: colors.accent, backgroundColor: colors.accentLight },
  segText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  segSub: { color: colors.muted, fontSize: 12, marginTop: 1 },
  segTextOn: { color: colors.accentDark },
  caption: { color: colors.muted, fontSize: 12, marginTop: 8 },
  input: {
    backgroundColor: colors.bg,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    color: colors.text,
    fontSize: 13,
    marginTop: 12,
    alignSelf: 'flex-start',
    width: 220,
    maxWidth: '100%',
  },
  btn: {
    backgroundColor: colors.accent,
    paddingHorizontal: 18,
    paddingVertical: 9,
    borderRadius: 16,
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginTop: 12,
  },
  btnText: { color: colors.onAccent, fontSize: 13, fontWeight: '600' },
  busyRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  ghost: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: 'center',
    alignSelf: 'flex-start',
    marginTop: 12,
  },
  ghostText: { color: colors.accent, fontSize: 13, fontWeight: '600' },
  link: { color: colors.accent, fontSize: 13, marginTop: 12, textDecorationLine: 'underline' },
  inlineLink: { color: colors.accent, textDecorationLine: 'underline' },
  disabled: { opacity: 0.4 },
  err: { color: colors.red, fontSize: 13, marginTop: 10 },
  warn: { color: colors.warn, fontSize: 13, marginTop: 8 },
  ok: { color: colors.accent, fontSize: 13, fontWeight: '600', marginTop: 4 },
}));
