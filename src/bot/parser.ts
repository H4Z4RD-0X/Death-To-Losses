import { getIstDate } from "./time";
import type { InstrumentHint, OptionType, ParsedNewTradeSignal, ParsedTargetHit, ParsedTradeUpdate, TradeSide } from "./types";

const HEADER_REGEX = /\b(BUY|SELL)\s+#?([A-Z0-9]+)\s+(\d+(?:\.\d+)?)\s+(CE|PE)\b/i;
const INSTRUMENT_HINT_REGEX = /(?:\b(?:BUY|SELL)\s+)?#?([A-Z0-9]+)\s+(\d+(?:\.\d+)?)\s+(CE|PE)\b/i;
const TARGET_LINE_REGEX = /\b(?:TARGETS?|TGT)\b/i;
const EXPIRY_REGEX = /\b(\d{1,2})(?:ST|ND|RD|TH)?\s+([A-Z]{3,9})(?:\s+(\d{2,4}))?\b/i;

const MONTHS: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12
};

function toNumber(value: string | undefined): number | null {
  if (!value) {
    return null;
  }

  const numeric = Number(value.trim());
  return Number.isFinite(numeric) ? numeric : null;
}

function extractLines(rawText: string): string[] {
  return rawText
    .replaceAll("\r", "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function parseInstrumentHint(rawText: string): InstrumentHint | null {
  const match = rawText.toUpperCase().match(INSTRUMENT_HINT_REGEX);
  if (!match) {
    return null;
  }

  const strike = toNumber(match[2]);
  if (strike === null) {
    return null;
  }

  return {
    symbol: match[1].toUpperCase(),
    strike,
    optionType: match[3].toUpperCase() as OptionType
  };
}

function parseEntryRange(rawText: string): { low: number | null; high: number | null } {
  const match = rawText.match(/\b(?:AT|CMP)\s*[:\-]?\s*(\d+(?:\.\d+)?)(?:\s*(?:-|\/|TO)\s*(\d+(?:\.\d+)?))?/i);
  if (!match) {
    return { low: null, high: null };
  }

  const first = toNumber(match[1]);
  const second = toNumber(match[2]);

  if (first === null) {
    return { low: null, high: null };
  }

  if (second === null) {
    return { low: first, high: first };
  }

  return {
    low: Math.min(first, second),
    high: Math.max(first, second)
  };
}

function parseStopLoss(rawText: string): number | null {
  const match = rawText.match(/\b(?:SL|STOP\s*LOSS|STOPLOSS)\s*[:\-]?\s*(\d+(?:\.\d+)?)/i);
  return toNumber(match?.[1]);
}

function parseTargets(lines: string[], side: TradeSide): number[] {
  const values: number[] = [];

  for (const line of lines) {
    const upperLine = line.toUpperCase();
    if (!TARGET_LINE_REGEX.test(upperLine) || /\bHITS?\b/.test(upperLine)) {
      continue;
    }

    const clipped = line.split(/\b(?:BUY|SELL)\b/i)[0] ?? line;
    const matches = clipped.matchAll(/(\d+(?:\.\d+)?)/g);
    for (const match of matches) {
      const numberValue = toNumber(match[1]);
      if (numberValue !== null) {
        values.push(numberValue);
      }
    }
  }

  const unique = [...new Set(values)];
  unique.sort((a, b) => (side === "BUY" ? a - b : b - a));
  return unique;
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  const test = new Date(Date.UTC(year, month - 1, day));
  return test.getUTCFullYear() === year && test.getUTCMonth() === month - 1 && test.getUTCDate() === day;
}

function parseExpiryDate(line: string): string | null {
  const match = line.toUpperCase().match(EXPIRY_REGEX);
  if (!match) {
    return null;
  }

  const day = Number(match[1]);
  const month = MONTHS[(match[2] ?? "").slice(0, 3)];
  if (!Number.isFinite(day) || !month) {
    return null;
  }

  const today = getIstDate();
  const currentYear = Number(today.slice(0, 4));
  const yearToken = match[3];

  let year = yearToken ? Number(yearToken) : currentYear;
  if (!Number.isFinite(year)) {
    return null;
  }

  if (year < 100) {
    year += 2000;
  }

  if (!isValidDateParts(year, month, day)) {
    return null;
  }

  let iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (!yearToken && iso < today) {
    const nextYear = year + 1;
    if (isValidDateParts(nextYear, month, day)) {
      iso = `${nextYear}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  return iso;
}

function parseTargetHitLine(line: string): ParsedTargetHit | null {
  const upper = line.toUpperCase();
  if (!/\b(?:TGT|TARGET)\b/.test(upper) || !/\bHITS?\b/.test(upper)) {
    return null;
  }

  const indexMatch = upper.match(/\b(?:TGT|TARGET)\s*(\d+)\b/);
  const targetIndex = toNumber(indexMatch?.[1]);

  const afterColon = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line;
  let price = toNumber(afterColon.match(/(\d+(?:\.\d+)?)/)?.[1]);

  if (price === null) {
    const numbers = [...line.matchAll(/(\d+(?:\.\d+)?)/g)]
      .map((match) => toNumber(match[1]))
      .filter((value): value is number => value !== null);

    if (numbers.length > 0) {
      price = targetIndex !== null && numbers.length > 1 ? numbers[1] : numbers[numbers.length - 1];
    }
  }

  return {
    targetIndex,
    price
  };
}

export function parseNewTradeSignal(rawText: string): ParsedNewTradeSignal | null {
  const normalized = rawText.replaceAll("\r", "").trim();
  if (normalized.length === 0) {
    return null;
  }

  const headerMatch = normalized.toUpperCase().match(HEADER_REGEX);
  if (!headerMatch) {
    return null;
  }

  const side = headerMatch[1].toUpperCase() as TradeSide;
  const symbol = headerMatch[2].toUpperCase();
  const strike = toNumber(headerMatch[3]);
  const optionType = headerMatch[4].toUpperCase() as OptionType;

  if (strike === null) {
    return null;
  }

  const lines = extractLines(normalized);
  const firstLine = lines[0] ?? normalized;
  const entry = parseEntryRange(normalized);
  const sl = parseStopLoss(normalized);
  const targets = parseTargets(lines, side);

  return {
    rawText: normalized,
    side,
    symbol,
    strike,
    optionType,
    expiryDate: parseExpiryDate(firstLine),
    entryLow: entry.low,
    entryHigh: entry.high,
    sl,
    targets
  };
}

export function parseTradeUpdate(rawText: string): ParsedTradeUpdate | null {
  const normalized = rawText.replaceAll("\r", "").trim();
  if (normalized.length === 0) {
    return null;
  }

  const lines = extractLines(normalized);
  const targetHits: ParsedTargetHit[] = [];
  let newTsl: number | null = null;
  let holdFor: number | null = null;
  let closeSignal: "SL" | "TSL" | "MANUAL" | null = null;

  for (const line of lines) {
    const targetHit = parseTargetHitLine(line);
    if (targetHit) {
      targetHits.push(targetHit);
    }

    const tslMatch = line.match(/\b(?:NEW\s+)?TSL(?:\s+TO\s+COST)?\s*[:\-]?\s*(\d+(?:\.\d+)?)/i);
    if (tslMatch) {
      newTsl = toNumber(tslMatch[1]);
    }

    const holdMatch = line.match(/\bHOLD\s+FOR\s+(\d+(?:\.\d+)?)\+?/i);
    if (holdMatch) {
      holdFor = toNumber(holdMatch[1]);
    }

    const upper = line.toUpperCase();
    if (/\bTSL\b.*\bHIT\b/.test(upper)) {
      closeSignal = "TSL";
    } else if (/\b(?:SL|STOP\s*LOSS|STOPLOSS)\b.*\bHIT\b/.test(upper)) {
      closeSignal = "SL";
    } else if (closeSignal === null && /\b(?:EXIT|BOOK(?:ED|ING)?)\b/.test(upper)) {
      closeSignal = "MANUAL";
    }
  }

  if (targetHits.length === 0 && newTsl === null && holdFor === null && closeSignal === null) {
    return null;
  }

  return {
    instrumentHint: parseInstrumentHint(normalized),
    targetHits,
    newTsl,
    holdFor,
    closeSignal,
    rawText: normalized
  };
}
