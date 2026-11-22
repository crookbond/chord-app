/**
 * Airport → IANA time zone.
 *
 * A ticket prints each time on the clock of the airport it happens at, so a
 * departure has to be anchored to the ORIGIN's zone and an arrival to the
 * DESTINATION's — never to the reader's. Keyed by the metro keys
 * `resolveMetro` returns, so anything that function recognises (an IATA code,
 * an airport name, a city) resolves here too, and every airport in one metro
 * shares one zone by construction.
 *
 * Same posture as the metro table: curated, and a place that is not here
 * yields null — "don't know" — which callers must not read as any zone.
 */
import { resolveMetro } from './airport-metro';

const METRO_ZONE: Record<string, string> = {
  nyc: 'America/New_York',
  dc: 'America/New_York',
  chicago: 'America/Chicago',
  la: 'America/Los_Angeles',
  sfbay: 'America/Los_Angeles',
  houston: 'America/Chicago',
  dallas: 'America/Chicago',
  miami: 'America/New_York',
  london: 'Europe/London',
  paris: 'Europe/Paris',
  milan: 'Europe/Rome',
  rome: 'Europe/Rome',
  tokyo: 'Asia/Tokyo',
  osaka: 'Asia/Tokyo',
  seoul: 'Asia/Seoul',
  beijing: 'Asia/Shanghai',
  shanghai: 'Asia/Shanghai',
  moscow: 'Europe/Moscow',
  toronto: 'America/Toronto',
  saopaulo: 'America/Sao_Paulo',
  buenosaires: 'America/Argentina/Buenos_Aires',
  istanbul: 'Europe/Istanbul',
  bangkok: 'Asia/Bangkok',
  stockholm: 'Europe/Stockholm',
  nairobi: 'Africa/Nairobi',

  ATL: 'America/New_York',
  DEN: 'America/Denver',
  SEA: 'America/Los_Angeles',
  PHX: 'America/Phoenix',
  DTW: 'America/Detroit',
  MSP: 'America/Chicago',
  PHL: 'America/New_York',
  CLT: 'America/New_York',
  MCO: 'America/New_York',
  LAS: 'America/Los_Angeles',
  SAN: 'America/Los_Angeles',
  PDX: 'America/Los_Angeles',
  SLC: 'America/Denver',
  BNA: 'America/Chicago',
  AUS: 'America/Chicago',
  MCI: 'America/Chicago',
  STL: 'America/Chicago',
  PIT: 'America/New_York',
  CLE: 'America/New_York',
  CVG: 'America/New_York',
  CMH: 'America/New_York',
  IND: 'America/Indiana/Indianapolis',
  RDU: 'America/New_York',
  MSY: 'America/Chicago',
  BOS: 'America/New_York',
  TPA: 'America/New_York',
  RSW: 'America/New_York',
  JAX: 'America/New_York',
  SAT: 'America/Chicago',
  OKC: 'America/Chicago',
  TUS: 'America/Phoenix',
  ABQ: 'America/Denver',
  BOI: 'America/Boise',
  ANC: 'America/Anchorage',
  HNL: 'Pacific/Honolulu',
  OGG: 'Pacific/Honolulu',
  EGE: 'America/Denver',
  ASE: 'America/Denver',
  JAC: 'America/Denver',
  HDN: 'America/Denver',
  YVR: 'America/Vancouver',
  YUL: 'America/Toronto',
  YYC: 'America/Edmonton',
  MEX: 'America/Mexico_City',
  CUN: 'America/Cancun',
  GDL: 'America/Mexico_City',
  BOG: 'America/Bogota',
  LIM: 'America/Lima',
  SCL: 'America/Santiago',
  GIG: 'America/Sao_Paulo',

  SYD: 'Australia/Sydney',
  MEL: 'Australia/Melbourne',
  BNE: 'Australia/Brisbane',
  PER: 'Australia/Perth',
  AKL: 'Pacific/Auckland',
  SIN: 'Asia/Singapore',
  HKG: 'Asia/Hong_Kong',
  DXB: 'Asia/Dubai',
  DOH: 'Asia/Qatar',
  AUH: 'Asia/Dubai',
  FRA: 'Europe/Berlin',
  MUC: 'Europe/Berlin',
  BER: 'Europe/Berlin',
  AMS: 'Europe/Amsterdam',
  ZRH: 'Europe/Zurich',
  GVA: 'Europe/Zurich',
  MAD: 'Europe/Madrid',
  BCN: 'Europe/Madrid',
  LIS: 'Europe/Lisbon',
  DUB: 'Europe/Dublin',
  VIE: 'Europe/Vienna',
  CPH: 'Europe/Copenhagen',
  OSL: 'Europe/Oslo',
  HEL: 'Europe/Helsinki',
  ATH: 'Europe/Athens',
  BOM: 'Asia/Kolkata',
  DEL: 'Asia/Kolkata',
  BLR: 'Asia/Kolkata',
  MAA: 'Asia/Kolkata',
  HYD: 'Asia/Kolkata',
  CAI: 'Africa/Cairo',
  JNB: 'Africa/Johannesburg',
  CPT: 'Africa/Johannesburg',
  ADD: 'Africa/Addis_Ababa',
  ALY: 'Africa/Cairo',
};

/** The IANA zone of an airport or city as a document would write it, or null. */
export function airportTimeZone(raw: string | null | undefined): string | null {
  const metro = resolveMetro(raw);
  return metro ? (METRO_ZONE[metro] ?? null) : null;
}

/**
 * The IANA zone of a PLACE written as free text: an airport, a city, or a
 * street address ("650 15th St, Denver, CO"), tried whole and then one
 * comma-separated part at a time. Null means the table does not know the
 * place, and a caller must then say whose clock it used instead (ADR 0245)
 * rather than present the time as local there.
 */
export function placeTimeZone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const whole = airportTimeZone(raw);
  if (whole) return whole;
  for (const part of raw.split(',')) {
    const zone = airportTimeZone(part);
    if (zone) return zone;
  }
  return null;
}
