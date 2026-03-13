import { istTradeDate, toNumber } from "@/lib/math";
import type { BrokerClient } from "./interface";
import { getRuntimeToken, parseAccessTokenExpiryMs } from "@/lib/brokerTokenStore";
import type { IndexSymbol, UpstoxChainResponseRaw, UpstoxChainRowRaw, UpstoxLegRaw } from "@/lib/types";

interface AccessTokenState {
  token: string;
  expiresAt: number;
}

interface ExpiryCacheEntry {
  expiryDate: string;
  expiresAt: number;
}

interface LotSizeCacheEntry {
  lotSize: number;
  expiresAt: number;
}

const tokenState: { value: AccessTokenState | null } = {
  value: null
};

const expiryState = new Map<IndexSymbol, ExpiryCacheEntry>();
const lotSizeState = new Map<string, LotSizeCacheEntry>();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name}. Add it in .env.local.`);
  }
  return value;
}

function resolveInstrument(index: IndexSymbol): string {
  if (index === "BANKNIFTY") {
    return process.env.UPSTOX_BANKNIFTY_INSTRUMENT_KEY ?? "NSE_INDEX|Nifty Bank";
  }
  return process.env.UPSTOX_NIFTY_INSTRUMENT_KEY ?? "NSE_INDEX|Nifty 50";
}

function normalizeChainRows(input: unknown): UpstoxChainRowRaw[] {
  if (Array.isArray(input)) {
    return input as UpstoxChainRowRaw[];
  }

  if (!input || typeof input !== "object") {
    return [];
  }

  const objectInput = input as Record<string, unknown>;

  if (Array.isArray(objectInput.data)) {
    return objectInput.data as UpstoxChainRowRaw[];
  }

  const nestedRecords = objectInput.records as Record<string, unknown> | undefined;
  if (nestedRecords && Array.isArray(nestedRecords.data)) {
    return nestedRecords.data as UpstoxChainRowRaw[];
  }

  return [];
}

function isDateLike(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
}

function appendUnique(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function parseDateOrNull(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  const normalized = value.trim();
  if (!isDateLike(normalized)) {
    return null;
  }
  return normalized;
}

function collectExpiryDates(input: unknown, output: Set<string>, depth = 0): void {
  if (depth > 10 || input === null || input === undefined) {
    return;
  }

  if (typeof input === "string") {
    if (isDateLike(input)) {
      output.add(input);
    }
    return;
  }

  if (Array.isArray(input)) {
    for (const item of input) {
      collectExpiryDates(item, output, depth + 1);
    }
    return;
  }

  if (typeof input !== "object") {
    return;
  }

  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string" && isDateLike(value) && /expir|date/i.test(key)) {
      output.add(value);
      continue;
    }
    collectExpiryDates(value, output, depth + 1);
  }
}

function normalizeExpiryList(expiries: Iterable<string>): string[] {
  const today = istTradeDate();
  return [...new Set(expiries)]
    .filter((value) => isDateLike(value) && value >= today)
    .sort((a, b) => a.localeCompare(b));
}

function generateFallbackExpiries(index: IndexSymbol, limit = 12): string[] {
  const targetDay = index === "BANKNIFTY" ? 3 : 4;
  const start = new Date(`${istTradeDate()}T00:00:00Z`);

  const result: string[] = [];
  const cursor = new Date(start);

  for (let guard = 0; guard < 90 && result.length < limit; guard += 1) {
    if (cursor.getUTCDay() === targetDay) {
      const iso = cursor.toISOString().slice(0, 10);
      appendUnique(result, iso);

      // Fallback for holiday-adjusted expiry where NSE shifts to previous day.
      const prior = new Date(cursor);
      prior.setUTCDate(prior.getUTCDate() - 1);
      appendUnique(result, prior.toISOString().slice(0, 10));
    }

    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return result;
}

async function fetchAccessToken(): Promise<string> {
  const runtimeToken = await getRuntimeToken("upstox");
  if (runtimeToken?.accessToken) {
    return runtimeToken.accessToken;
  }

  const envToken = process.env.UPSTOX_ACCESS_TOKEN;
  if (envToken) {
    const expiryMs = parseAccessTokenExpiryMs(envToken);
    if (expiryMs === null || Date.now() < expiryMs - 60_000) {
      return envToken;
    }
  }

  const cached = tokenState.value;
  if (cached && Date.now() < cached.expiresAt - 60_000) {
    return cached.token;
  }

  const clientId = requireEnv("UPSTOX_API_KEY");
  const clientSecret = requireEnv("UPSTOX_API_SECRET");

  const url = process.env.UPSTOX_TOKEN_ENDPOINT ?? "https://api.upstox.com/v2/login/authorization/token";
  const body = new URLSearchParams();
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);

  if (process.env.UPSTOX_REFRESH_TOKEN) {
    body.set("grant_type", "refresh_token");
    body.set("refresh_token", process.env.UPSTOX_REFRESH_TOKEN);
  } else {
    body.set("grant_type", "authorization_code");
    body.set("code", requireEnv("UPSTOX_AUTH_CODE"));
    body.set("redirect_uri", requireEnv("UPSTOX_REDIRECT_URI"));
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: body.toString(),
    cache: "no-store"
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Upstox token request failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token) {
    throw new Error("Upstox token response did not contain access_token.");
  }

  tokenState.value = {
    token: payload.access_token,
    expiresAt: Date.now() + (payload.expires_in ?? 24 * 60 * 60) * 1000
  };

  return payload.access_token;
}

export async function probeUpstoxAccessToken(accessToken: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const endpoint = process.env.UPSTOX_OPTION_CONTRACT_ENDPOINT ?? "https://api.upstox.com/v2/option/contract";
  const instrumentKey = resolveInstrument("NIFTY");

  const url = new URL(endpoint);
  url.searchParams.set("instrument_key", instrumentKey);

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "Api-Version": "2.0"
      },
      cache: "no-store"
    });

    if (response.ok) {
      return { ok: true };
    }

    const message = await response.text();
    return {
      ok: false,
      error: `Upstox rejected token (${response.status}): ${message}`
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Token probe failed due to network/unknown error."
    };
  }
}

export async function exchangeUpstoxAuthorizationCode(input: {
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string; expiresAt: number | null }> {
  const clientId = requireEnv("UPSTOX_API_KEY");
  const clientSecret = requireEnv("UPSTOX_API_SECRET");
  const url = process.env.UPSTOX_TOKEN_ENDPOINT ?? "https://api.upstox.com/v2/login/authorization/token";

  const body = new URLSearchParams();
  body.set("code", input.code);
  body.set("client_id", clientId);
  body.set("client_secret", clientSecret);
  body.set("redirect_uri", input.redirectUri);
  body.set("grant_type", "authorization_code");

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json"
    },
    body: body.toString(),
    cache: "no-store"
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Upstox token exchange failed (${response.status}): ${errorText}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!payload.access_token) {
    throw new Error("Upstox token exchange response did not contain access_token.");
  }

  const expiryFromJwt = parseAccessTokenExpiryMs(payload.access_token);
  const expiresAt = expiryFromJwt ?? (payload.expires_in ? Date.now() + payload.expires_in * 1000 : null);

  return {
    accessToken: payload.access_token,
    expiresAt
  };
}

function normalizeToLots(value: number | null, lotSize: number): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isFinite(lotSize) || lotSize <= 1) {
    return value;
  }
  return Math.round(value / lotSize);
}

function shouldNormalizeToLots(): boolean {
  return (process.env.UPSTOX_NORMALIZE_TO_LOTS ?? "true").toLowerCase() === "true";
}

function extractLeg(rawLeg: UpstoxLegRaw | undefined, lotSize: number): { oi: number | null; volume: number | null; iv: number | null; ltp: number | null; numberOfTrades: number | null } {
  const market = rawLeg?.market_data as Record<string, unknown> | undefined;
  const greeks = rawLeg?.option_greeks as Record<string, unknown> | undefined;
  const normalize = shouldNormalizeToLots();
  const rawOi = toNumber(market?.oi ?? market?.open_interest);
  const rawVolume = toNumber(market?.volume ?? market?.vtt);
  // Real NT (number of trades) — Nitin Bhatia COI/Vol: intraday = (ΔCOI × lot_size) / (volume / NT)
  // Field name varies by broker/feed: no_of_trades, num_of_trades, numTrades, trades, etc.
  const rawTrades = toNumber(
    market?.no_of_trades ?? market?.num_of_trades ?? market?.numTrades ??
    market?.number_of_trades ?? market?.trades
  );

  return {
    oi: normalize ? normalizeToLots(rawOi, lotSize) : rawOi,
    volume: normalize ? normalizeToLots(rawVolume, lotSize) : rawVolume,
    iv: toNumber(greeks?.iv ?? market?.iv),
    ltp: toNumber(market?.ltp ?? market?.last_price),
    // numberOfTrades is a raw count (not normalized to lots)
    numberOfTrades: rawTrades
  };
}

export interface ParsedChainStrike {
  strike: number;
  underlying: number | null;
  ce: ReturnType<typeof extractLeg>;
  pe: ReturnType<typeof extractLeg>;
}

export interface OptionChainFetchResult {
  rows: ParsedChainStrike[];
  expiryDate: string;
}

export interface ExpiryChainPair {
  weekly: OptionChainFetchResult;
  monthly: OptionChainFetchResult;
}

async function requestAvailableExpiries(accessToken: string, index: IndexSymbol): Promise<string[]> {
  const endpoint = process.env.UPSTOX_OPTION_CONTRACT_ENDPOINT ?? "https://api.upstox.com/v2/option/contract";
  const instrumentKey = resolveInstrument(index);

  const url = new URL(endpoint);
  url.searchParams.set("instrument_key", instrumentKey);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Api-Version": "2.0"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    return [];
  }

  const payload = (await response.json()) as unknown;
  const collected = new Set<string>();
  collectExpiryDates(payload, collected);

  return normalizeExpiryList(collected);
}

async function requestOptionChain(
  accessToken: string,
  index: IndexSymbol,
  expiryDate: string,
  lotSize: number
): Promise<ParsedChainStrike[]> {
  const endpoint = process.env.UPSTOX_OPTION_CHAIN_ENDPOINT ?? "https://api.upstox.com/v2/option/chain";
  const instrumentKey = resolveInstrument(index);

  const url = new URL(endpoint);
  url.searchParams.set("instrument_key", instrumentKey);
  url.searchParams.set("expiry_date", expiryDate);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Api-Version": "2.0"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Upstox option chain failed (${response.status}) for expiry ${expiryDate}: ${errorText}`);
  }

  const payload = (await response.json()) as UpstoxChainResponseRaw;
  const rows = normalizeChainRows(payload.data ?? payload);

  return rows
    .map((row) => {
      const strike = toNumber(row.strike_price);
      if (strike === null) {
        return null;
      }

      return {
        strike,
        underlying: toNumber(row.underlying_spot_price),
        ce: extractLeg(row.call_options, lotSize),
        pe: extractLeg(row.put_options, lotSize)
      } satisfies ParsedChainStrike;
    })
    .filter((row): row is ParsedChainStrike => row !== null)
    .sort((a, b) => a.strike - b.strike);
}

function resolveConfiguredCandidates(index: IndexSymbol, override?: string): string[] {
  const candidates: string[] = [];

  const direct = parseDateOrNull(override);
  if (direct) {
    appendUnique(candidates, direct);
  }

  const envExpiry = parseDateOrNull(process.env.UPSTOX_EXPIRY_DATE);
  if (envExpiry) {
    appendUnique(candidates, envExpiry);
  }

  const cached = expiryState.get(index);
  if (cached && Date.now() < cached.expiresAt && cached.expiryDate >= istTradeDate()) {
    appendUnique(candidates, cached.expiryDate);
  }

  return candidates;
}

async function resolveCandidateExpiries(accessToken: string, index: IndexSymbol, override?: string): Promise<string[]> {
  const candidates = resolveConfiguredCandidates(index, override);

  const discovered = await requestAvailableExpiries(accessToken, index);
  for (const expiry of discovered) {
    appendUnique(candidates, expiry);
  }

  for (const fallback of generateFallbackExpiries(index)) {
    appendUnique(candidates, fallback);
  }

  return candidates;
}

function lotSizeKey(index: IndexSymbol, expiryDate: string): string {
  return `${index}:${expiryDate}`;
}

async function resolveLotSize(accessToken: string, index: IndexSymbol, expiryDate: string): Promise<number> {
  const key = lotSizeKey(index, expiryDate);
  const cached = lotSizeState.get(key);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.lotSize;
  }

  const endpoint = process.env.UPSTOX_OPTION_CONTRACT_ENDPOINT ?? "https://api.upstox.com/v2/option/contract";
  const instrumentKey = resolveInstrument(index);

  const url = new URL(endpoint);
  url.searchParams.set("instrument_key", instrumentKey);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "Api-Version": "2.0"
    },
    cache: "no-store"
  });

  if (!response.ok) {
    return 1;
  }

  const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
  const rows = Array.isArray(payload.data) ? payload.data : [];
  const match = rows.find((row) => String(row.expiry ?? "") === expiryDate);
  const lotSize = toNumber(match?.lot_size ?? match?.minimum_lot) ?? 1;
  const normalized = lotSize > 0 ? lotSize : 1;

  lotSizeState.set(key, {
    lotSize: normalized,
    expiresAt: Date.now() + 6 * 60 * 60 * 1000
  });

  return normalized;
}

export function resolveWeekAndMonthExpiry(expiries: string[], tradeDate = istTradeDate()): { weekly: string; monthly: string } {
  const future = expiries.filter((expiry) => isDateLike(expiry) && expiry >= tradeDate).sort((a, b) => a.localeCompare(b));
  if (future.length === 0) {
    throw new Error("No valid future expiry dates available.");
  }

  const weekly = future[0];
  const tradeMonth = tradeDate.slice(0, 7);
  const weeklyMonth = weekly.slice(0, 7);

  const monthCandidates = future.filter((expiry) => expiry.startsWith(tradeMonth));
  const fallbackMonthCandidates = future.filter((expiry) => expiry.startsWith(weeklyMonth));
  const monthly = (monthCandidates.length > 0 ? monthCandidates : fallbackMonthCandidates).slice(-1)[0] ?? weekly;

  return {
    weekly,
    monthly
  };
}

export async function fetchAvailableExpiries(index: IndexSymbol): Promise<string[]> {
  const accessToken = await fetchAccessToken();
  const discovered = await requestAvailableExpiries(accessToken, index);
  const fallback = generateFallbackExpiries(index);
  return normalizeExpiryList([...discovered, ...fallback]);
}

export async function fetchOptionChainForExpiry(index: IndexSymbol, expiryDate: string): Promise<OptionChainFetchResult> {
  const accessToken = await fetchAccessToken();
  const lotSize = await resolveLotSize(accessToken, index, expiryDate);
  const rows = await requestOptionChain(accessToken, index, expiryDate, lotSize);
  if (rows.length === 0) {
    throw new Error(`Expiry ${expiryDate} returned empty chain.`);
  }
  expiryState.set(index, {
    expiryDate,
    expiresAt: Date.now() + 6 * 60 * 60 * 1000
  });

  return {
    rows,
    expiryDate
  };
}

export async function fetchNiftyWeekMonthChains(tradeDate = istTradeDate()): Promise<ExpiryChainPair> {
  const index: IndexSymbol = "NIFTY";
  const expiries = await fetchAvailableExpiries(index);
  const future = expiries.filter((expiry) => expiry >= tradeDate).sort((a, b) => a.localeCompare(b));
  const weeklyCandidates = future.length > 0 ? future : expiries;

  const tradeMonth = tradeDate.slice(0, 7);
  const monthEndCandidates = weeklyCandidates.filter((expiry) => expiry.startsWith(tradeMonth)).sort((a, b) => b.localeCompare(a));
  const monthlyCandidates = monthEndCandidates.length > 0 ? monthEndCandidates : [...weeklyCandidates].sort((a, b) => b.localeCompare(a));

  async function firstWorkingExpiry(candidates: string[]): Promise<OptionChainFetchResult> {
    const errors: string[] = [];
    for (const candidate of candidates) {
      try {
        const result = await fetchOptionChainForExpiry(index, candidate);
        if (result.rows.length > 0) {
          return result;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "option chain fetch failed";
        errors.push(`${candidate}: ${message}`);
      }
    }

    throw new Error(errors[0] ?? "Unable to resolve working expiry.");
  }

  const weekly = await firstWorkingExpiry(weeklyCandidates);
  const monthly =
    monthlyCandidates.includes(weekly.expiryDate) && monthlyCandidates.length === 1
      ? weekly
      : await firstWorkingExpiry([...(new Set(monthlyCandidates.filter((expiry) => expiry !== weekly.expiryDate))), weekly.expiryDate]);

  return {
    weekly,
    monthly
  };
}

export async function fetchOptionChain(index: IndexSymbol, expiryDate?: string): Promise<OptionChainFetchResult> {
  const accessToken = await fetchAccessToken();
  const candidates = await resolveCandidateExpiries(accessToken, index, expiryDate);

  if (candidates.length === 0) {
    throw new Error("Could not resolve any valid expiry_date for Upstox option chain.");
  }

  const errors: string[] = [];

  for (const candidate of candidates) {
    try {
      const lotSize = await resolveLotSize(accessToken, index, candidate);
      const rows = await requestOptionChain(accessToken, index, candidate, lotSize);
      if (rows.length === 0) {
        errors.push(`Expiry ${candidate} returned empty chain.`);
        continue;
      }

      expiryState.set(index, {
        expiryDate: candidate,
        expiresAt: Date.now() + 6 * 60 * 60 * 1000
      });

      return {
        rows,
        expiryDate: candidate
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Option chain request failed";
      errors.push(message);
    }
  }

  throw new Error(`Unable to fetch Upstox option chain after trying ${candidates.length} expiry dates: ${errors[0] ?? "unknown error"}`);
}

export const upstoxBroker: BrokerClient = {
  id: "upstox",
  name: "Upstox",
  fetchOptionChain,
  fetchNiftyWeekMonthChains,
  probeAccessToken: probeUpstoxAccessToken,
  exchangeAuthorizationCode: exchangeUpstoxAuthorizationCode
};
