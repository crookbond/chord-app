/**
 * Companies whose name phishing mail borrows, and the domains their real
 * mail comes from (ADR 0294). Curated in-repo like the airline table (ADR
 * 0138); a brand not listed is simply never claimed.
 *
 * `distinctive: false` marks a name that is also an ordinary word or a
 * person's name (Chase, Apple, Target, Discover). Such a name counts as a
 * claim only when the display name is the brand plus service words ("Chase",
 * "Chase Alerts", "Apple Support") — never for "Chase Miller".
 */

export interface Brand {
  name: string;
  /** Whole words (lower case) that, in a display name, claim this brand. */
  names: string[];
  /** Registrable domains the brand really sends from. */
  domains: string[];
  distinctive: boolean;
  /** `<label>.<country>` is also the brand (amazon.de, paypal.co.uk). */
  countryDomains?: boolean;
}

export const BRANDS: Brand[] = [
  { name: 'Robinhood', names: ['robinhood'], domains: ['robinhood.com'], distinctive: true },
  { name: 'PayPal', names: ['paypal'], domains: ['paypal.com', 'paypal.me'], distinctive: true, countryDomains: true },
  { name: 'Venmo', names: ['venmo'], domains: ['venmo.com'], distinctive: true },
  { name: 'Coinbase', names: ['coinbase'], domains: ['coinbase.com'], distinctive: true },
  { name: 'Zelle', names: ['zelle'], domains: ['zellepay.com', 'zelle.com'], distinctive: true },
  { name: 'Cash App', names: ['cash app', 'cashapp'], domains: ['cash.app', 'square.com', 'squareup.com'], distinctive: true },
  { name: 'Netflix', names: ['netflix'], domains: ['netflix.com'], distinctive: true },
  { name: 'Amazon', names: ['amazon', 'amazon.com', 'prime video'], domains: ['amazon.com', 'amazonaws.com', 'primevideo.com', 'audible.com'], distinctive: false, countryDomains: true },
  { name: 'Apple', names: ['apple', 'icloud', 'itunes', 'app store', 'apple id'], domains: ['apple.com', 'itunes.com'], distinctive: false },
  { name: 'Microsoft', names: ['microsoft', 'office 365', 'microsoft 365', 'outlook', 'onedrive', 'xbox'], domains: ['microsoft.com', 'microsoftonline.com', 'office.com', 'xbox.com', 'onedrive.com', 'office365.com'], distinctive: true },
  { name: 'Google', names: ['google', 'gmail', 'google workspace'], domains: ['google.com', 'youtube.com'], distinctive: false },
  { name: 'Meta', names: ['facebook', 'instagram', 'whatsapp', 'meta'], domains: ['facebook.com', 'facebookmail.com', 'instagram.com', 'whatsapp.com', 'meta.com'], distinctive: false },
  { name: 'Chase', names: ['chase', 'jpmorgan', 'jp morgan'], domains: ['chase.com', 'jpmorgan.com', 'jpmchase.com'], distinctive: false },
  { name: 'Bank of America', names: ['bank of america', 'bankofamerica'], domains: ['bankofamerica.com', 'bofa.com'], distinctive: true },
  { name: 'Wells Fargo', names: ['wells fargo', 'wellsfargo'], domains: ['wellsfargo.com', 'wf.com'], distinctive: true },
  { name: 'Citi', names: ['citibank', 'citi'], domains: ['citi.com', 'citibank.com', 'citicards.com'], distinctive: false },
  { name: 'Capital One', names: ['capital one', 'capitalone'], domains: ['capitalone.com'], distinctive: true },
  { name: 'American Express', names: ['american express', 'amex'], domains: ['americanexpress.com', 'aexp.com', 'amex.com'], distinctive: true },
  { name: 'Discover', names: ['discover'], domains: ['discover.com', 'discovercard.com'], distinctive: false },
  { name: 'Fidelity', names: ['fidelity'], domains: ['fidelity.com', 'fmr.com'], distinctive: false },
  { name: 'Vanguard', names: ['vanguard'], domains: ['vanguard.com'], distinctive: false },
  { name: 'Charles Schwab', names: ['schwab', 'charles schwab'], domains: ['schwab.com'], distinctive: true },
  { name: 'IRS', names: ['irs', 'internal revenue service'], domains: ['irs.gov'], distinctive: true },
  { name: 'Social Security', names: ['social security', 'ssa'], domains: ['ssa.gov'], distinctive: false },
  { name: 'USPS', names: ['usps', 'postal service'], domains: ['usps.com', 'usps.gov'], distinctive: true },
  { name: 'UPS', names: ['ups'], domains: ['ups.com'], distinctive: false },
  { name: 'FedEx', names: ['fedex'], domains: ['fedex.com'], distinctive: true },
  { name: 'DHL', names: ['dhl'], domains: ['dhl.com'], distinctive: true, countryDomains: true },
  { name: 'DocuSign', names: ['docusign'], domains: ['docusign.com', 'docusign.net'], distinctive: true },
  { name: 'Dropbox', names: ['dropbox'], domains: ['dropbox.com', 'dropboxmail.com'], distinctive: true },
  { name: 'LinkedIn', names: ['linkedin'], domains: ['linkedin.com'], distinctive: true },
  { name: 'Norton', names: ['norton', 'norton lifelock', 'lifelock'], domains: ['norton.com', 'nortonlifelock.com', 'gen.com'], distinctive: false },
  { name: 'McAfee', names: ['mcafee'], domains: ['mcafee.com'], distinctive: true },
  { name: 'Geek Squad', names: ['geek squad', 'geeksquad'], domains: ['bestbuy.com', 'geeksquad.com'], distinctive: true },
  { name: 'Walmart', names: ['walmart'], domains: ['walmart.com'], distinctive: true },
  { name: 'Costco', names: ['costco'], domains: ['costco.com'], distinctive: true },
  { name: 'Target', names: ['target'], domains: ['target.com'], distinctive: false },
  { name: 'eBay', names: ['ebay'], domains: ['ebay.com'], distinctive: true, countryDomains: true },
  { name: 'Binance', names: ['binance'], domains: ['binance.com', 'binance.us'], distinctive: true },
  { name: 'Kraken', names: ['kraken'], domains: ['kraken.com'], distinctive: false },
  { name: 'Delta', names: ['delta', 'delta air lines'], domains: ['delta.com'], distinctive: false },
  { name: 'Verizon', names: ['verizon'], domains: ['verizon.com', 'verizonwireless.com'], distinctive: true },
  { name: 'AT&T', names: ['at&t', 'att'], domains: ['att.com', 'att.net'], distinctive: false },
  { name: 'T-Mobile', names: ['t-mobile', 'tmobile'], domains: ['t-mobile.com'], distinctive: true },
  { name: 'Comcast Xfinity', names: ['xfinity', 'comcast'], domains: ['xfinity.com', 'comcast.net', 'comcast.com'], distinctive: true },
];

/** Words that may stand beside a non-distinctive brand without making it a person. */
export const SERVICE_WORDS = new Set([
  'support', 'team', 'security', 'alert', 'alerts', 'account', 'accounts', 'billing', 'service',
  'services', 'customer', 'customers', 'care', 'notification', 'notifications', 'noreply',
  'no-reply', 'help', 'helpdesk', 'bank', 'card', 'cards', 'online', 'center', 'centre',
  'update', 'updates', 'payment', 'payments', 'fraud', 'verification', 'verify', 'id', 'rewards',
  'inc', 'inc.', 'llc', 'official', 'store', 'shop', 'prime', 'mail', 'email', 'admin', 'desk',
  'department', 'dept', 'protection', 'renewal', 'subscription', 'subscriptions', 'order',
  'orders', 'delivery', 'shipping', 'tracking', 'refund', 'refunds', 'claims', 'wallet', 'pay',
  'us', 'usa', 'the', 'from', 'via', '-', '|', 'and', '&', 'airlines', 'air', 'lines', 'wireless',
]);
