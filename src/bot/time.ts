const IST_TIME_ZONE = "Asia/Kolkata";

const WEEKDAY_TO_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6
};

function readPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

export function getIstDate(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: IST_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const year = readPart(parts, "year");
  const month = readPart(parts, "month");
  const day = readPart(parts, "day");
  return `${year}-${month}-${day}`;
}

export function getIstClock(date = new Date()): { date: string; hour: number; minute: number; weekday: number } {
  const dateValue = getIstDate(date);
  const timeParts = new Intl.DateTimeFormat("en-US", {
    timeZone: IST_TIME_ZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(date);

  const hour = Number(readPart(timeParts, "hour"));
  const minute = Number(readPart(timeParts, "minute"));
  const weekdayLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: IST_TIME_ZONE,
    weekday: "short"
  }).format(date);

  return {
    date: dateValue,
    hour: Number.isFinite(hour) ? hour : 0,
    minute: Number.isFinite(minute) ? minute : 0,
    weekday: WEEKDAY_TO_INDEX[weekdayLabel] ?? 0
  };
}

export function isIstWeekday(weekday: number): boolean {
  return weekday >= 1 && weekday <= 5;
}

export function formatIstTime(isoTime: string): string {
  return new Date(isoTime).toLocaleTimeString("en-IN", {
    timeZone: IST_TIME_ZONE,
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

export function parseIstTimeConfig(
  value: string | undefined,
  fallback: { hour: number; minute: number }
): { hour: number; minute: number } {
  if (!value) {
    return fallback;
  }

  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return fallback;
  }

  const hour = Number(match[1]);
  const minute = Number(match[2]);

  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return fallback;
  }

  return { hour, minute };
}

export function formatDateTimeForSummary(isoTime: string): string {
  return new Date(isoTime).toLocaleString("en-IN", {
    timeZone: IST_TIME_ZONE,
    hour12: false,
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
}
