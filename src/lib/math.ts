export function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const normalized = Number(value.replaceAll(",", "").trim());
    if (Number.isFinite(normalized)) {
      return normalized;
    }
  }
  return null;
}

export function safeDiff(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) {
    return null;
  }
  return current - previous;
}

export function safeRoc(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) {
    return null;
  }
  return ((current - previous) / Math.abs(previous)) * 100;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function weightedAverage(parts: Array<{ value: number; weight: number }>): number {
  const totalWeight = parts.reduce((sum, part) => sum + part.weight, 0);
  if (totalWeight === 0) {
    return 0;
  }

  const total = parts.reduce((sum, part) => sum + part.value * part.weight, 0);
  return total / totalWeight;
}

export function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function quantile(values: number[], q: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const boundedQ = clamp(q, 0, 1);
  const position = (sorted.length - 1) * boundedQ;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);

  if (lowerIndex === upperIndex) {
    return sorted[lowerIndex];
  }

  const weight = position - lowerIndex;
  return sorted[lowerIndex] * (1 - weight) + sorted[upperIndex] * weight;
}

export function stdDev(values: number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const avg = mean(values);
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

export function directionScore(
  value: number | null,
  expected: "increase" | "decrease",
  adaptiveThreshold: number
): number {
  if (value === null) {
    return 0.45;
  }

  const signed = expected === "increase" ? value : -value;
  const normalized = signed / Math.max(adaptiveThreshold, 0.001);
  const mapped = 0.5 + normalized / 4;
  return clamp(mapped, 0, 1);
}

export function formatSigned(value: number | null, precision = 2): string {
  if (value === null || Number.isNaN(value)) {
    return "nan";
  }
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(precision)}`;
}

export function compactDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const year = String(date.getUTCFullYear());
  return `${day}${month}${year}`;
}

export function toIstIso(date = new Date()): string {
  return date.toISOString();
}

export function istTradeDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

export function istDisplayTime(isoTime: string): string {
  return new Date(isoTime).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}
