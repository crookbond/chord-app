/**
 * ADR 0231 — App Store subscriptions through RevenueCat (iOS only).
 *
 * RevenueCat's SDK is a native module, so a build made before it was added
 * simply doesn't have it, and an OTA update must never take such a build down.
 * Everything here therefore loads the module lazily inside a try/catch and
 * answers "unsupported" when it isn't there; the Settings screen then falls
 * back to the web checkout, exactly as it did before this existed.
 *
 * The app only ever tells RevenueCat WHO is buying (the Chord user id, so the
 * webhook can attribute the purchase) and WHICH product. What the purchase
 * grants is decided on the server from RevenueCat's webhook — the client's
 * word is never trusted for entitlement.
 */
import { NativeModules, Platform } from 'react-native';

import { nativeModuleInBuild } from './optional-native';

// Public SDK key (it identifies the app to RevenueCat; it grants nothing).
const IOS_KEY = process.env.EXPO_PUBLIC_REVENUECAT_IOS_KEY ?? '';

// The module's types would make every call here depend on its exact version;
// the surface used is five calls, each guarded.
let purchases: any | null | undefined;
let configuredFor: string | null = null;

function sdk(): any | null {
  if (Platform.OS !== 'ios' || !IOS_KEY) return null;
  if (purchases !== undefined) return purchases;
  // The package builds an event emitter over its native module while loading,
  // which throws when the build lacks it, and Metro reports that as fatal
  // before any catch runs (ADR 0258 addendum). It is a bridge module, so ask
  // NativeModules as well as the Expo registry.
  if (NativeModules.RNPurchases == null && !nativeModuleInBuild('RNPurchases')) {
    purchases = null;
    return purchases;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('react-native-purchases');
    purchases = mod.default ?? mod;
  } catch {
    purchases = null;
  }
  return purchases;
}

/** True when this build can sell through the App Store. */
export function iapSupported(): boolean {
  return sdk() !== null;
}

async function ready(userId: string): Promise<any> {
  const p = sdk();
  if (!p) throw new Error('iap_unsupported');
  if (configuredFor === null) {
    p.configure({ apiKey: IOS_KEY, appUserID: userId });
    configuredFor = userId;
  } else if (configuredFor !== userId) {
    await p.logIn(userId);
    configuredFor = userId;
  }
  return p;
}

export interface IapProduct {
  productId: string;
  /** Localized, as the App Store will charge it ("$7.99"). */
  priceString: string;
  raw: unknown;
}

export async function iapProducts(userId: string, ids: string[]): Promise<Record<string, IapProduct>> {
  const p = await ready(userId);
  const found: any[] = await p.getProducts(ids, p.PRODUCT_CATEGORY?.SUBSCRIPTION);
  const out: Record<string, IapProduct> = {};
  for (const prod of found) {
    out[prod.identifier] = { productId: prod.identifier, priceString: prod.priceString, raw: prod };
  }
  return out;
}

export type IapPurchaseResult = 'purchased' | 'cancelled';

export async function iapPurchase(userId: string, product: IapProduct): Promise<IapPurchaseResult> {
  const p = await ready(userId);
  try {
    await p.purchaseStoreProduct(product.raw);
    return 'purchased';
  } catch (e) {
    if ((e as { userCancelled?: boolean }).userCancelled) return 'cancelled';
    throw e;
  }
}

/** App Review requires a way to get a purchase back on a new device. */
export async function iapRestore(userId: string): Promise<void> {
  const p = await ready(userId);
  await p.restorePurchases();
}

/** Apple's own offer-code sheet (codes generated in App Store Connect). */
export async function iapRedeemCode(userId: string): Promise<void> {
  const p = await ready(userId);
  await p.presentCodeRedemptionSheet();
}

/** Where an App Store subscription is managed, cancelled or changed. */
export const APPLE_MANAGE_SUBSCRIPTIONS_URL = 'https://apps.apple.com/account/subscriptions';
