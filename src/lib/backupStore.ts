import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  BackupInfo,
  EodParticipantIntel,
  EodCorrelation,
  EodTally,
  IndexSymbol,
  IntradaySummary,
  ParticipantsSummary,
  SmartMoneyRadar,
  SmartMoneyEvent,
  SnapshotRow,
  VibeAnalysis
} from "@/lib/types";

interface BackupSession {
  key: string;
  index: IndexSymbol;
  strike: number;
  expiryDate: string | null;
  underlyingSpot: number | null;
  tradeDate: string;
  updatedAt: string;
  lastUpdatedIso: string;
  pollCount: number;
  refreshCount: number;
  rows: SnapshotRow[];
  events: SmartMoneyEvent[];
  radar: SmartMoneyRadar;
  vibe: VibeAnalysis;
  intradaySummary: IntradaySummary;
  eodCorrelation: EodCorrelation;
  eodTally: EodTally;
  participantsSummary: ParticipantsSummary | null;
  participantIntel: EodParticipantIntel;
}

interface BackupFileShape {
  tradeDate: string;
  updatedAt: string;
  sessions: Record<string, BackupSession>;
}

const BACKUP_RETENTION_DAYS = Math.max(3, Number(process.env.BACKUP_RETENTION_DAYS ?? 10));
const BACKUP_DIR = process.env.BACKUP_DIR ?? path.join(process.cwd(), "data", "backups");
let writeQueue: Promise<void> = Promise.resolve();

function sessionKey(index: IndexSymbol, strike: number, expiryDate: string | null): string {
  return `${index}:${strike}:${expiryDate ?? "AUTO"}`;
}

function backupFilePath(tradeDate: string): string {
  return path.join(BACKUP_DIR, `${tradeDate}.json`);
}

async function ensureBackupDir(): Promise<void> {
  await fs.mkdir(BACKUP_DIR, { recursive: true });
}

async function readBackupFile(tradeDate: string): Promise<BackupFileShape> {
  const filePath = backupFilePath(tradeDate);

  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as BackupFileShape;
    if (!parsed || typeof parsed !== "object" || typeof parsed.sessions !== "object") {
      throw new Error("Invalid backup JSON");
    }
    return parsed;
  } catch {
    return {
      tradeDate,
      updatedAt: new Date().toISOString(),
      sessions: {}
    };
  }
}

async function writeBackupFile(tradeDate: string, payload: BackupFileShape): Promise<void> {
  const filePath = backupFilePath(tradeDate);
  const tempPath = `${filePath}.tmp`;

  await fs.writeFile(tempPath, JSON.stringify(payload, null, 2), "utf8");
  await fs.rename(tempPath, filePath);
}

async function pruneBackups(): Promise<number> {
  await ensureBackupDir();
  const files = await fs.readdir(BACKUP_DIR);

  const jsonFiles = files
    .filter((file) => /^\d{4}-\d{2}-\d{2}\.json$/.test(file))
    .sort((a, b) => b.localeCompare(a));

  const keep = jsonFiles.slice(0, BACKUP_RETENTION_DAYS);
  const remove = jsonFiles.slice(BACKUP_RETENTION_DAYS);

  await Promise.all(
    remove.map(async (file) => {
      try {
        await fs.unlink(path.join(BACKUP_DIR, file));
      } catch {
        // Ignore deletion errors.
      }
    })
  );

  return keep.length;
}

async function persistLiveBackupInternal(input: {
  index: IndexSymbol;
  strike: number;
  expiryDate: string | null;
  underlyingSpot: number | null;
  tradeDate: string;
  pollCount: number;
  refreshCount: number;
  lastUpdatedIso: string;
  rows: SnapshotRow[];
  events: SmartMoneyEvent[];
  radar: SmartMoneyRadar;
  vibe: VibeAnalysis;
  intradaySummary: IntradaySummary;
  participantsSummary: ParticipantsSummary | null;
  participantIntel: EodParticipantIntel;
  eodCorrelation: EodCorrelation;
  eodTally: EodTally;
}): Promise<BackupInfo> {
  await ensureBackupDir();

  const key = sessionKey(input.index, input.strike, input.expiryDate);
  const filePayload = await readBackupFile(input.tradeDate);

  const updatedAt = new Date().toISOString();
  filePayload.updatedAt = updatedAt;
  filePayload.sessions[key] = {
    key,
    index: input.index,
    strike: input.strike,
    expiryDate: input.expiryDate,
    underlyingSpot: input.underlyingSpot,
    tradeDate: input.tradeDate,
    updatedAt,
    lastUpdatedIso: input.lastUpdatedIso,
    pollCount: input.pollCount,
    refreshCount: input.refreshCount,
    rows: input.rows,
    events: input.events,
    radar: input.radar,
    vibe: input.vibe,
    intradaySummary: input.intradaySummary,
    eodCorrelation: input.eodCorrelation,
    eodTally: input.eodTally,
    participantsSummary: input.participantsSummary,
    participantIntel: input.participantIntel
  };

  await writeBackupFile(input.tradeDate, filePayload);
  const totalBackups = await pruneBackups();

  return {
    updatedAt,
    path: backupFilePath(input.tradeDate),
    retainedDays: BACKUP_RETENTION_DAYS,
    totalBackups,
    sessionKey: key
  };
}

export async function readLiveBackupSession(
  tradeDate: string,
  index: IndexSymbol,
  strike: number,
  expiryDate: string | null
): Promise<BackupSession | null> {
  try {
    const filePayload = await readBackupFile(tradeDate);
    const key = sessionKey(index, strike, expiryDate);
    if (filePayload.sessions && filePayload.sessions[key]) {
      return filePayload.sessions[key];
    }
    // Also try checking for just the index/strike prefix if expiry isn't perfectly matched,
    // or just return the first session if any exists so that we return something for the date.
    const sessionValues = Object.values(filePayload.sessions);
    if (sessionValues.length > 0) {
      // Find one matching strike and index
      const match = sessionValues.find((s) => s.index === index && s.strike === strike);
      return match ?? sessionValues[0];
    }
    return null;
  } catch (err) {
    return null;
  }
}

export async function persistLiveBackup(input: {
  index: IndexSymbol;
  strike: number;
  expiryDate: string | null;
  underlyingSpot: number | null;
  tradeDate: string;
  pollCount: number;
  refreshCount: number;
  lastUpdatedIso: string;
  rows: SnapshotRow[];
  events: SmartMoneyEvent[];
  radar: SmartMoneyRadar;
  vibe: VibeAnalysis;
  intradaySummary: IntradaySummary;
  participantsSummary: ParticipantsSummary | null;
  participantIntel: EodParticipantIntel;
  eodCorrelation: EodCorrelation;
  eodTally: EodTally;
}): Promise<BackupInfo> {
  let result: BackupInfo | null = null;

  const scheduled = writeQueue.then(async () => {
    result = await persistLiveBackupInternal(input);
  });

  writeQueue = scheduled.catch(() => undefined);
  await scheduled;

  if (!result) {
    throw new Error("Backup persistence did not return a result.");
  }

  return result;
}
