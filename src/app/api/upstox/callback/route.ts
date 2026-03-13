import { NextRequest, NextResponse } from "next/server";
import { exchangeUpstoxAuthorizationCode } from "@/lib/brokers/upstox";
import { setRuntimeToken } from "@/lib/brokerTokenStore";

export const dynamic = "force-dynamic";

const OAUTH_STATE_COOKIE = "upstox_oauth_state";

function appRedirect(
  request: NextRequest,
  params: {
    auth: "success" | "error";
    message?: string;
  }
): NextResponse {
  const url = new URL("/", request.url);
  url.searchParams.set("auth", params.auth);
  if (params.message) {
    url.searchParams.set("message", params.message);
  }
  return NextResponse.redirect(url);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const redirectUri = process.env.UPSTOX_REDIRECT_URI?.trim();
  if (!redirectUri) {
    return appRedirect(request, { auth: "error", message: "Missing UPSTOX_REDIRECT_URI in server env." });
  }

  const query = request.nextUrl.searchParams;
  const code = query.get("code");
  const state = query.get("state");
  const upstreamError = query.get("error");
  const upstreamDescription = query.get("error_description");

  if (upstreamError) {
    return appRedirect(request, {
      auth: "error",
      message: `${upstreamError}${upstreamDescription ? `: ${upstreamDescription}` : ""}`
    });
  }

  const cookieState = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!state || !cookieState || state !== cookieState) {
    return appRedirect(request, { auth: "error", message: "OAuth state mismatch. Try Authorize Upstox again." });
  }

  if (!code) {
    return appRedirect(request, { auth: "error", message: "Upstox callback did not return authorization code." });
  }

  try {
    const exchanged = await exchangeUpstoxAuthorizationCode({
      code,
      redirectUri
    });
    await setRuntimeToken("upstox", exchanged.accessToken);

    const response = appRedirect(request, { auth: "success" });
    response.cookies.set({
      name: OAUTH_STATE_COOKIE,
      value: "",
      maxAge: 0,
      path: "/"
    });
    return response;
  } catch (error) {
    return appRedirect(request, {
      auth: "error",
      message: error instanceof Error ? error.message : "Token exchange failed."
    });
  }
}
