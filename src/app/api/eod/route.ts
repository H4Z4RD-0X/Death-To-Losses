import { NextRequest, NextResponse } from "next/server";
import { getParticipantsSummary } from "@/lib/participants";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const tradeDate = request.nextUrl.searchParams.get("tradeDate") ?? undefined;
  const { summary, warning } = await getParticipantsSummary(tradeDate);

  return NextResponse.json(
    {
      summary,
      warning
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
