import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const OAUTH_STATE_COOKIE = "upstox_oauth_state";

function appRedirectWithError(request: NextRequest, message: string): NextResponse {
  const appUrl = new URL("/", request.url);
  appUrl.searchParams.set("auth", "error");
  appUrl.searchParams.set("message", message);
  return NextResponse.redirect(appUrl);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const clientId = process.env.UPSTOX_API_KEY?.trim();
  const redirectUri = process.env.UPSTOX_REDIRECT_URI?.trim();

  if (!clientId || !redirectUri) {
    return appRedirectWithError(request, "Set UPSTOX_API_KEY and UPSTOX_REDIRECT_URI in server env.");
  }

  const state = randomBytes(24).toString("hex");
  const authEndpoint =
    process.env.UPSTOX_AUTHORIZE_DIALOG_ENDPOINT ?? "https://api-v2.upstox.com/login/authorization/dialog";

  const target = new URL(authEndpoint);
  target.searchParams.set("response_type", "code");
  target.searchParams.set("client_id", clientId);
  target.searchParams.set("redirect_uri", redirectUri);
  target.searchParams.set("state", state);

  const response = NextResponse.redirect(target);
  response.cookies.set({
    name: OAUTH_STATE_COOKIE,
    value: state,
    httpOnly: true,
    sameSite: "lax",
    secure: request.nextUrl.protocol === "https:",
    maxAge: 10 * 60,
    path: "/"
  });

  return response;
}
