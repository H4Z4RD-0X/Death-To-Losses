import { getIstDate } from "./time";
import type { OptionType } from "./types";

interface AccessTokenState {
  token: string;
  expiresAt: number;
}

interface ChainStrike {
  strike: number;
  ceLtp: number | null;
  peLtp: number | null;
}

export interface OptionPriceRequest {
  symbol: string;
  strike: number;
  optionType: OptionType;
  expiryDate: string | null;
}

export interface OptionPriceResult {
  ltp: number;
  expiryDate: string;
}

const DEFAULT_INSTRUMENT_MAP: Record<string, string> = {
  NIFTY: "NSE_INDEX|Nifty 50",
  BANKNIFTY: "NSE_INDEX|Nifty Bank",
  FINNIFTY: "NSE_INDEX|Nifty Fin Service",
  MIDCPNIFTY: "NSE_INDEX|NIFTY MID SELECT"
};

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = Number(value.trim().replaceAll(",", ""));
    if (Number.isFinite(normalized)) {
      return normalized;
    }
  }
  return null;
}

function isDateLike(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value.trim());
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

function normalizeChainRows(input: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(input)) {
    return input as Array<Record<string, unknown>>;
  }

  if (!input || typeof input !== "object") {
    return [];
  }

  const inputObject = input as Record<string, unknown>;
  if (Array.isArray(inputObject.data)) {
    return inputObject.data as Array<Record<string, unknown>>;
  }

  const records = inputObject.records as Record<string, unknown> | undefined;
  if (records && Array.isArray(records.data)) {
    return records.data as Array<Record<string, unknown>>;
  }

  return [];
}

function parseInstrumentMap(rawValue: string | undefined): Record<string, string> {
  const map = { ...DEFAULT_INSTRUMENT_MAP };

  if (!rawValue) {
    return map;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawValue);
  } catch {
    throw new Error("UPSTOX_UNDERLYING_INSTRUMENT_MAP must be valid JSON.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("UPSTOX_UNDERLYING_INSTRUMENT_MAP must be a JSON object.");
  }

  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    map[key.toUpperCase()] = value.trim();
  }

  return map;
}

function normalizeExpiryList(values: Iterable<string>): string[] {
  const today = getIstDate();
  return [...new Set(values)]
    .filter((value) => isDateLike(value) && value >= today)
    .sort((a, b) => a.localeCompare(b));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

export class UpstoxMarketData {
  private readonly instrumentMap = parseInstrumentMap(process.env.UPSTOX_UNDERLYING_INSTRUMENT_MAP);
  private tokenState: AccessTokenState | null = null;
  private readonly expiryCache = new Map<string, { expiry: string; expiresAt: number }>();
  private readonly contractCache = new Map<string, { expiries: string[]; expiresAt: number }>();
  private readonly chainCache = new Map<string, { rows: ChainStrike[]; expiresAt: number }>();

  private requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
      throw new Error(`Missing ${name}. Add it to .env.local.`);
    }
    return value;
  }

  private resolveInstrument(symbol: string): string {
    const key = this.instrumentMap[symbol.toUpperCase()];
    if (!key) {
      throw new Error(
        `No instrument key configured for ${symbol}. Set it in UPSTOX_UNDERLYING_INSTRUMENT_MAP (JSON object).`
      );
    }
    return key;
  }

  private async fetchAccessToken(): Promise<string> {
    if (process.env.UPSTOX_ACCESS_TOKEN) {
      return process.env.UPSTOX_ACCESS_TOKEN;
    }

    if (this.tokenState && Date.now() < this.tokenState.expiresAt - 60_000) {
      return this.tokenState.token;
    }

    const endpoint = process.env.UPSTOX_TOKEN_ENDPOINT ?? "https://api.upstox.com/v2/login/authorization/token";
    const body = new URLSearchParams();
    body.set("client_id", this.requireEnv("UPSTOX_API_KEY"));
    body.set("client_secret", this.requireEnv("UPSTOX_API_SECRET"));

    if (process.env.UPSTOX_REFRESH_TOKEN) {
      body.set("grant_type", "refresh_token");
      body.set("refresh_token", process.env.UPSTOX_REFRESH_TOKEN);
    } else {
      body.set("grant_type", "authorization_code");
      body.set("code", this.requireEnv("UPSTOX_AUTH_CODE"));
      body.set("redirect_uri", this.requireEnv("UPSTOX_REDIRECT_URI"));
    }

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: body.toString(),
      cache: "no-store"
    });

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`Upstox token fetch failed (${response.status}): ${message}`);
    }

    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) {
      throw new Error("Upstox token response did not include access_token.");
    }

    this.tokenState = {
      token: payload.access_token,
      expiresAt: Date.now() + (payload.expires_in ?? 24 * 60 * 60) * 1000
    };

    return payload.access_token;
  }

  private async fetchAvailableExpiries(accessToken: string, instrumentKey: string): Promise<string[]> {
    const cached = this.contractCache.get(instrumentKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.expiries;
    }

    const endpoint = process.env.UPSTOX_OPTION_CONTRACT_ENDPOINT ?? "https://api.upstox.com/v2/option/contract";
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
      const message = await response.text();
      throw new Error(`Upstox option contract request failed (${response.status}): ${message}`);
    }

    const payload = (await response.json()) as unknown;
    const collected = new Set<string>();
    collectExpiryDates(payload, collected);

    const expiries = normalizeExpiryList(collected);
    this.contractCache.set(instrumentKey, {
      expiries,
      expiresAt: Date.now() + 10 * 60 * 1000
    });

    return expiries;
  }

  private async resolveExpiryDate(accessToken: string, instrumentKey: string, preferred: string | null): Promise<string> {
    const today = getIstDate();
    if (preferred && isDateLike(preferred) && preferred >= today) {
      return preferred;
    }

    const cached = this.expiryCache.get(instrumentKey);
    if (cached && Date.now() < cached.expiresAt && cached.expiry >= today) {
      return cached.expiry;
    }

    const expiries = await this.fetchAvailableExpiries(accessToken, instrumentKey);
    const resolved = expiries[0];
    if (!resolved) {
      throw new Error(`No valid expiries returned by Upstox for instrument ${instrumentKey}.`);
    }

    this.expiryCache.set(instrumentKey, {
      expiry: resolved,
      expiresAt: Date.now() + 60 * 60 * 1000
    });

    return resolved;
  }

  private extractLegLtp(leg: unknown): number | null {
    if (!isRecord(leg)) {
      return null;
    }

    const market = isRecord(leg.market_data) ? leg.market_data : {};
    return toNumber(market.ltp ?? market.last_price);
  }

  private async fetchOptionChain(accessToken: string, instrumentKey: string, expiryDate: string): Promise<ChainStrike[]> {
    const cacheKey = `${instrumentKey}|${expiryDate}`;
    const cached = this.chainCache.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.rows;
    }

    const endpoint = process.env.UPSTOX_OPTION_CHAIN_ENDPOINT ?? "https://api.upstox.com/v2/option/chain";
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
      const message = await response.text();
      throw new Error(`Upstox option chain request failed (${response.status}) for ${expiryDate}: ${message}`);
    }

    const payload = (await response.json()) as unknown;
    const payloadObject = isRecord(payload) ? payload : {};
    const rowsRaw = normalizeChainRows(payloadObject.data ?? payload);

    const rows = rowsRaw
      .map((row) => {
        const strike = toNumber(row.strike_price);
        if (strike === null) {
          return null;
        }

        return {
          strike,
          ceLtp: this.extractLegLtp(row.call_options),
          peLtp: this.extractLegLtp(row.put_options)
        } satisfies ChainStrike;
      })
      .filter((row): row is ChainStrike => row !== null)
      .sort((a, b) => a.strike - b.strike);

    this.chainCache.set(cacheKey, {
      rows,
      expiresAt: Date.now() + 8_000
    });

    return rows;
  }

  private pickStrikeRow(rows: ChainStrike[], strike: number): ChainStrike | null {
    const exact = rows.find((row) => Math.abs(row.strike - strike) < 0.0001);
    if (exact) {
      return exact;
    }

    let nearest: ChainStrike | null = null;
    let nearestDiff = Number.POSITIVE_INFINITY;

    for (const row of rows) {
      const diff = Math.abs(row.strike - strike);
      if (diff < nearestDiff) {
        nearest = row;
        nearestDiff = diff;
      }
    }

    if (!nearest || nearestDiff > 300) {
      return null;
    }

    return nearest;
  }

  async getOptionLtp(request: OptionPriceRequest): Promise<OptionPriceResult> {
    const accessToken = await this.fetchAccessToken();
    const instrumentKey = this.resolveInstrument(request.symbol);
    const expiryDate = await this.resolveExpiryDate(accessToken, instrumentKey, request.expiryDate);
    const chain = await this.fetchOptionChain(accessToken, instrumentKey, expiryDate);

    const strikeRow = this.pickStrikeRow(chain, request.strike);
    if (!strikeRow) {
      throw new Error(`No strike row found around ${request.strike} for ${request.symbol} ${expiryDate}.`);
    }

    const ltp = request.optionType === "CE" ? strikeRow.ceLtp : strikeRow.peLtp;
    if (ltp === null) {
      throw new Error(`LTP unavailable for ${request.symbol} ${request.strike} ${request.optionType} (${expiryDate}).`);
    }

    return { ltp, expiryDate };
  }
}
