import { NextRequest, NextResponse } from "next/server";
import { getLivePayload } from "@/lib/liveTracker";
import type { IndexSymbol } from "@/lib/types";

export const dynamic = "force-dynamic";

function parseIndex(value: string | null): IndexSymbol {
  if (value?.toUpperCase() === "BANKNIFTY") {
    return "BANKNIFTY";
  }
  return "NIFTY";
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const search = request.nextUrl.searchParams;

    const index = parseIndex(search.get("index"));
    const strikeParam = search.get("strike");
    const tradeDateParam = search.get("tradeDate") ?? undefined;
    const expiryDateParam = search.get("expiryDate") ?? undefined;

    const strike = strikeParam ? Number(strikeParam) : undefined;

    const payload = await getLivePayload({
      index,
      strike: Number.isFinite(strike) ? strike : undefined,
      tradeDate: tradeDateParam,
      expiryDate: expiryDateParam
    });

    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Live route failed";
    return NextResponse.json(
      {
        error: message
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" }
      }
    );
  }
}
