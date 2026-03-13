import { promises as fs } from "node:fs";
import path from "node:path";

interface RuntimeTokenFile {
  accessToken: string;
  expiresAt: number | null;
  updatedAtIso: string;
}

export interface RuntimeTokenState {
  accessToken: string;
  expiresAt: number | null;
  updatedAtIso: string;
}

const getRuntimeTokenPath = (brokerId: string) =>
  process.env[`${brokerId.toUpperCase()}_RUNTIME_TOKEN_FILE`] ?? 
  path.join(process.cwd(), "data", "runtime", `${brokerId}-token.json`);

const runtimeCache = new Map<string, RuntimeTokenFile | null>();

export function parseAccessTokenExpiryMs(accessToken: string): number | null {
  const parts = accessToken.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { exp?: number };
    if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= 0) {
      return null;
    }
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

async function readRuntimeTokenFile(brokerId: string): Promise<RuntimeTokenFile | null> {
  if (runtimeCache.has(brokerId)) {
    return runtimeCache.get(brokerId)!;
  }

  try {
    const tokenPath = getRuntimeTokenPath(brokerId);
    const content = await fs.readFile(tokenPath, "utf8");
    const parsed = JSON.parse(content) as RuntimeTokenFile;

    if (!parsed || typeof parsed.accessToken !== "string" || parsed.accessToken.trim().length === 0) {
      runtimeCache.set(brokerId, null);
      return null;
    }

    const value = {
      accessToken: parsed.accessToken,
      expiresAt: typeof parsed.expiresAt === "number" && Number.isFinite(parsed.expiresAt) ? parsed.expiresAt : null,
      updatedAtIso: typeof parsed.updatedAtIso === "string" ? parsed.updatedAtIso : new Date().toISOString()
    };
    runtimeCache.set(brokerId, value);
    return value;
  } catch {
    runtimeCache.set(brokerId, null);
    return null;
  }
}

async function writeRuntimeTokenFile(brokerId: string, value: RuntimeTokenFile | null): Promise<void> {
  runtimeCache.set(brokerId, value);

  const tokenPath = getRuntimeTokenPath(brokerId);

  if (!value) {
    try {
      await fs.unlink(tokenPath);
    } catch {
      // Ignore missing file and deletion errors.
    }
    return;
  }

  await fs.mkdir(path.dirname(tokenPath), { recursive: true });
  await fs.writeFile(tokenPath, JSON.stringify(value, null, 2), "utf8");
}

function isExpired(expiresAt: number | null): boolean {
  if (expiresAt === null) {
    return false;
  }
  return Date.now() >= expiresAt - 60_000;
}

export async function getRuntimeToken(brokerId: string): Promise<RuntimeTokenState | null> {
  const value = await readRuntimeTokenFile(brokerId);
  if (!value) {
    return null;
  }

  if (isExpired(value.expiresAt)) {
    await writeRuntimeTokenFile(brokerId, null);
    return null;
  }

  return {
    accessToken: value.accessToken,
    expiresAt: value.expiresAt,
    updatedAtIso: value.updatedAtIso
  };
}

export async function setRuntimeToken(brokerId: string, accessToken: string): Promise<RuntimeTokenState> {
  const trimmed = accessToken.trim();
  const payload: RuntimeTokenFile = {
    accessToken: trimmed,
    expiresAt: parseAccessTokenExpiryMs(trimmed),
    updatedAtIso: new Date().toISOString()
  };

  await writeRuntimeTokenFile(brokerId, payload);

  return {
    accessToken: payload.accessToken,
    expiresAt: payload.expiresAt,
    updatedAtIso: payload.updatedAtIso
  };
}

export async function clearRuntimeToken(brokerId: string): Promise<void> {
  await writeRuntimeTokenFile(brokerId, null);
}
