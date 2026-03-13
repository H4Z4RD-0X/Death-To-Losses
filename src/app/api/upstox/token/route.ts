import { NextRequest, NextResponse } from "next/server";
import { probeUpstoxAccessToken } from "@/lib/brokers/upstox";
import {
  clearRuntimeToken,
  getRuntimeToken,
  parseAccessTokenExpiryMs,
  setRuntimeToken
} from "@/lib/brokerTokenStore";

export const dynamic = "force-dynamic";

type TokenSource = "runtime" | "env" | "none";

function minutesRemaining(expiresAtMs: number | null): number | null {
  if (expiresAtMs === null) {
    return null;
  }
  return Math.floor((expiresAtMs - Date.now()) / 60_000);
}

function statusPayload(input: {
  source: TokenSource;
  expiresAtMs: number | null;
  updatedAtIso?: string | null;
  note: string;
}): {
  source: TokenSource;
  configured: boolean;
  expiresAtIso: string | null;
  expiresInMinutes: number | null;
  updatedAtIso: string | null;
  note: string;
} {
  const expiresInMinutes = minutesRemaining(input.expiresAtMs);
  const configured = expiresInMinutes === null ? input.source !== "none" : expiresInMinutes > 0;

  return {
    source: input.source,
    configured,
    expiresAtIso: input.expiresAtMs === null ? null : new Date(input.expiresAtMs).toISOString(),
    expiresInMinutes,
    updatedAtIso: input.updatedAtIso ?? null,
    note: input.note
  };
}

async function resolveTokenStatus(broker: string) {
  const runtime = await getRuntimeToken(broker);
  if (runtime) {
    return statusPayload({
      source: "runtime",
      expiresAtMs: runtime.expiresAt,
      updatedAtIso: runtime.updatedAtIso,
      note: `Using pasted ${broker} token from dashboard.`
    });
  }

  const envVarName = `${broker.toUpperCase()}_ACCESS_TOKEN`;
  const envToken = process.env[envVarName]?.trim();
  if (envToken) {
    const envExpiry = parseAccessTokenExpiryMs(envToken);
    const expiresIn = minutesRemaining(envExpiry);

    if (envExpiry !== null && (expiresIn ?? -1) <= 0) {
      return statusPayload({
        source: "env",
        expiresAtMs: envExpiry,
        note: `Token in .env.local (${envVarName}) is expired. Paste a fresh token.`
      });
    }

    return statusPayload({
      source: "env",
      expiresAtMs: envExpiry,
      note: `Using token from .env.local (${envVarName}).`
    });
  }

  return statusPayload({
    source: "none",
    expiresAtMs: null,
    note: `No ${broker} token configured yet.`
  });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const broker = searchParams.get("broker") || "upstox";
  const payload = await resolveTokenStatus(broker);
  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = (await request.json()) as { accessToken?: string; broker?: string };
    const accessToken = (body.accessToken ?? "").trim();
    const broker = body.broker || "upstox";

    if (accessToken.length < 40) {
      return NextResponse.json({ error: `Please paste a valid ${broker} access token.` }, { status: 400 });
    }

    // Only Upstox has a probe for now
    if (broker === "upstox") {
      const probe = await probeUpstoxAccessToken(accessToken);
      if (!probe.ok) {
        return NextResponse.json({ error: probe.error }, { status: 400 });
      }
    }

    const saved = await setRuntimeToken(broker, accessToken);
    const payload = statusPayload({
      source: "runtime",
      expiresAtMs: saved.expiresAt,
      updatedAtIso: saved.updatedAtIso,
      note: "Token validated and saved."
    });

    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "Could not save token."
      },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const broker = searchParams.get("broker") || "upstox";
  await clearRuntimeToken(broker);
  return NextResponse.json(
    statusPayload({
      source: "none",
      expiresAtMs: null,
      note: "Pasted token cleared. If .env token exists, app may use that next."
    }),
    { headers: { "Cache-Control": "no-store" } }
  );
}
