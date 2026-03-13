#!/usr/bin/env python3
"""
NIFTY Dashboard — Upstox Auto-Login (Playwright edition)
=========================================================
Uses a headless Chromium browser to drive the real Upstox login page —
this works regardless of internal API changes because it uses the actual UI.

Flow:  auth dialog → enter mobile → enter TOTP → enter PIN → capture auth_code → exchange for token

Requires:
    pip3 install playwright pyotp
    playwright install chromium --with-deps

Cron (8:55am IST = 3:25am UTC, weekdays):
    25 3 * * 1-5  cd /opt/nifty && python3 scripts/auto-login.py >> logs/auto-login.log 2>&1
    35 3 * * 1-5  cd /opt/nifty && python3 scripts/auto-login.py >> logs/auto-login.log 2>&1
"""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# ── Dependency checks ─────────────────────────────────────────────────────────
try:
    import pyotp
except ImportError:
    print("[ERROR] pyotp not installed.  Run:  pip3 install pyotp playwright && playwright install chromium --with-deps")
    sys.exit(1)

try:
    from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout
except ImportError:
    print("[ERROR] playwright not installed.  Run:  pip3 install playwright && playwright install chromium --with-deps")
    sys.exit(1)

# ── Load .env files ───────────────────────────────────────────────────────────
def load_env_file(path: str) -> None:
    try:
        with open(path) as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key   = key.strip()
                value = value.strip().strip('"').strip("'")
                if key and key not in os.environ:
                    os.environ[key] = value
    except FileNotFoundError:
        pass


script_dir   = Path(__file__).parent
project_root = script_dir.parent
load_env_file(str(project_root / ".env.local"))
load_env_file(str(script_dir / ".env"))


def require(key: str) -> str:
    val = os.environ.get(key, "").strip()
    if not val:
        print(f"[ERROR] Missing required environment variable: {key}")
        sys.exit(1)
    return val


API_KEY      = require("UPSTOX_API_KEY")
API_SECRET   = require("UPSTOX_API_SECRET")
REDIRECT_URI = require("UPSTOX_REDIRECT_URI")
MOBILE       = require("UPSTOX_MOBILE")       # 10-digit mobile, e.g. 9876543210
PIN          = require("UPSTOX_PIN")           # 6-digit login PIN
TOTP_SECRET  = require("UPSTOX_TOTP_SECRET")   # base32 key from authenticator app

TOKEN_FILE = os.environ.get(
    "UPSTOX_RUNTIME_TOKEN_FILE",
    str(project_root / "data" / "runtime" / "upstox-token.json"),
)

AUTH_URL = (
    "https://api-v2.upstox.com/login/authorization/dialog"
    f"?response_type=code&client_id={API_KEY}&redirect_uri={urllib.parse.quote(REDIRECT_URI, safe='')}"
)


# ── Helpers ───────────────────────────────────────────────────────────────────
def screenshot(page, name: str) -> None:
    """Save a debug screenshot to logs/ — helpful when debugging failures."""
    try:
        path = project_root / "logs" / f"login-debug-{name}.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(path=str(path))
        print(f"  [debug screenshot saved: logs/login-debug-{name}.png]")
    except Exception:
        pass


def fill_and_continue(page, selector: str, value: str, step_name: str) -> None:
    """Fill an input field and click the submit/continue button."""
    try:
        page.wait_for_selector(selector, timeout=15_000)
        page.fill(selector, value)
        # Click the primary/submit button — try multiple common selectors
        for btn in [
            "button[type='submit']",
            "button.btn-primary",
            "button.submit-btn",
            "button:has-text('Continue')",
            "button:has-text('Get OTP')",
            "button:has-text('Verify')",
            "button:has-text('Login')",
        ]:
            try:
                page.click(btn, timeout=3_000)
                print(f"  [{step_name}] submitted via {btn}")
                return
            except PWTimeout:
                continue
        # Last resort: press Enter
        page.press(selector, "Enter")
        print(f"  [{step_name}] submitted via Enter key")
    except Exception as e:
        screenshot(page, step_name.replace(" ", "-"))
        raise RuntimeError(f"Step '{step_name}' failed: {e}") from e


def exchange_code_for_token(auth_code: str) -> str:
    """POST auth_code → Upstox token endpoint → return access_token string."""
    post_params = {
        "code":          auth_code,
        "client_id":     API_KEY,
        "client_secret": API_SECRET,
        "redirect_uri":  REDIRECT_URI,
        "grant_type":    "authorization_code",
    }
    body = urllib.parse.urlencode(post_params).encode("utf-8")

    # Debug: print POST params (redact secret) so redirect_uri mismatch is obvious
    print(f"  [token exchange] POST to https://api-v2.upstox.com/v2/login/authorization/token")
    print(f"  [token exchange] client_id    = {API_KEY}")
    print(f"  [token exchange] redirect_uri = {REDIRECT_URI}")
    print(f"  [token exchange] code         = {auth_code[:8]}...")

    req = urllib.request.Request(
        "https://api-v2.upstox.com/v2/login/authorization/token",
        data=body,
        headers={
            "Content-Type":    "application/x-www-form-urlencoded",
            "Accept":          "application/json",
            "User-Agent":      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
            "Origin":          "https://api-v2.upstox.com",
            "Referer":         "https://api-v2.upstox.com/login/authorization/dialog",
            "Accept-Language": "en-US,en;q=0.9",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        # Read the full error body — Upstox includes a specific error message
        try:
            err_body = e.read().decode("utf-8")
        except Exception:
            err_body = "(could not read response body)"
        raise RuntimeError(
            f"Token exchange HTTP {e.code} {e.reason}\n"
            f"  Response body: {err_body}\n"
            f"  → Most common causes:\n"
            f"    403: wrong token endpoint URL (should be api-v2.upstox.com not api.upstox.com)\n"
            f"    403: redirect_uri doesn't EXACTLY match Upstox developer portal\n"
            f"    403: UPSTOX_API_SECRET is wrong or blank\n"
            f"    400: auth_code already used or expired (re-run the script)\n"
            f"  → Your redirect_uri was: {REDIRECT_URI}"
        ) from e

    token = result.get("access_token")
    if not token:
        raise RuntimeError(f"Token exchange returned no access_token: {result}")
    return token


def write_token(access_token: str) -> None:
    """Write token to the JSON file the Next.js app reads."""
    expires_at = None
    try:
        import base64
        parts = access_token.split(".")
        if len(parts) >= 2:
            padded = parts[1] + "=" * (4 - len(parts[1]) % 4)
            payload = json.loads(base64.urlsafe_b64decode(padded).decode("utf-8"))
            exp = payload.get("exp")
            if isinstance(exp, (int, float)) and exp > 0:
                expires_at = int(exp * 1000)
    except Exception:
        pass

    token_data = {
        "accessToken":  access_token,
        "expiresAt":    expires_at,
        "updatedAtIso": datetime.now(timezone.utc).isoformat(),
    }
    path = Path(TOKEN_FILE)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(token_data, indent=2), encoding="utf-8")

    exp_str = ""
    if expires_at:
        exp_dt = datetime.fromtimestamp(expires_at / 1000, tz=timezone.utc)
        exp_str = f" (expires {exp_dt.strftime('%Y-%m-%d %H:%M UTC')})"
    print(f"[✓] Token written → {TOKEN_FILE}{exp_str}")


# ── Main login flow (Playwright) ──────────────────────────────────────────────
def run_login() -> None:
    print(f"[→] Opening Upstox auth page...")
    print(f"    {AUTH_URL[:80]}...")

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            headless=True,
            args=["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
        )
        context = browser.new_context(
            # Intercept our own redirect URI so we can capture the auth code
            # without needing a running server
        )

        auth_code_holder: list[str] = []

        page = context.new_page()

        # Capture auth_code the moment any frame navigates to a URL containing code=
        # This fires BEFORE the page tries to load the destination — works even if
        # port 3000 is down or the redirect causes a connection error.
        def on_navigated(frame) -> None:
            try:
                url = frame.url
                if "code=" in url:
                    parsed = urllib.parse.urlparse(url)
                    params = urllib.parse.parse_qs(parsed.query)
                    code = params.get("code", [None])[0]
                    if code and not auth_code_holder:
                        auth_code_holder.append(code)
                        print(f"  [captured auth_code via frame navigation]")
            except Exception:
                pass

        page.on("framenavigated", on_navigated)

        # Also watch all responses for the code in case of JS-based redirect
        def on_response(response) -> None:
            try:
                url = response.url
                if "code=" in url:
                    parsed = urllib.parse.urlparse(url)
                    params = urllib.parse.parse_qs(parsed.query)
                    code = params.get("code", [None])[0]
                    if code and not auth_code_holder:
                        auth_code_holder.append(code)
                        print(f"  [captured auth_code via response URL]")
            except Exception:
                pass

        page.on("response", on_response)

        # ── Step 1: Open the auth dialog ──────────────────────────────────────
        page.goto(AUTH_URL, wait_until="domcontentloaded", timeout=30_000)
        page.wait_for_timeout(2_000)   # let JS render
        screenshot(page, "1-auth-dialog")

        # ── Step 2: Enter mobile number ───────────────────────────────────────
        # Screenshot shows: input with "+91" prefix, "Get OTP" button
        print("[1/3] Entering mobile number...")
        try:
            # The page has a single tel input next to the "+91" prefix label
            page.wait_for_selector("input", timeout=10_000)
            page.click("input")
            page.fill("input", MOBILE)
            print(f"  filled mobile number")
        except PWTimeout:
            screenshot(page, "2-mobile-not-found")
            raise RuntimeError("Could not find mobile input. See logs/login-debug-2-mobile-not-found.png")

        # Click "Get OTP" button
        try:
            page.click("button:has-text('Get OTP')", timeout=8_000)
            print("  clicked 'Get OTP'")
        except PWTimeout:
            page.press("input", "Enter")
            print("  submitted via Enter")

        # Wait for OTP page to load ("Verify your number" screen)
        page.wait_for_timeout(4_000)
        screenshot(page, "3-after-mobile")

        # ── Step 3: Enter TOTP ────────────────────────────────────────────────
        # Screenshot shows: single plain input with label "Enter OTP or TOTP"
        # NO mode-switch button needed — the same input accepts both OTP and TOTP directly
        print("[2/3] Entering TOTP code...")

        # Generate TOTP — do this AFTER the page loads to keep the code fresh
        totp_code = pyotp.TOTP(TOTP_SECRET).now()
        seconds_left = 30 - (int(time.time()) % 30)
        print(f"  generated TOTP: {totp_code[:2]}**** ({seconds_left}s until expiry)")

        # If less than 5 seconds left on this TOTP window, wait for the next one
        # to avoid a race condition where the code expires mid-submit
        if seconds_left < 5:
            print(f"  waiting {seconds_left + 1}s for fresh TOTP window...")
            time.sleep(seconds_left + 1)
            totp_code = pyotp.TOTP(TOTP_SECRET).now()
            print(f"  refreshed TOTP: {totp_code[:2]}****")

        try:
            # The OTP/TOTP input is the only visible input on this page
            page.wait_for_selector("input", timeout=10_000)
            page.click("input")
            page.fill("input", totp_code)
            print("  filled TOTP code")
        except PWTimeout:
            screenshot(page, "4-otp-not-found")
            raise RuntimeError("Could not find OTP/TOTP input. See logs/login-debug-4-otp-not-found.png")

        # Click "Continue" button
        try:
            page.click("button:has-text('Continue')", timeout=8_000)
            print("  clicked 'Continue'")
        except PWTimeout:
            page.press("input", "Enter")
            print("  submitted via Enter")

        # Wait for PIN page to appear — give it up to 10s (Upstox can be slow)
        try:
            page.wait_for_function("document.body.innerText.includes('PIN')", timeout=10_000)
            print("  PIN page detected")
        except PWTimeout:
            pass  # screenshot will show where we are
        page.wait_for_timeout(1_000)
        screenshot(page, "5-after-totp")

        # ── Step 4: Enter PIN ─────────────────────────────────────────────────
        # After TOTP, Upstox shows a PIN entry page
        print("[3/3] Entering PIN...")
        try:
            page.wait_for_selector("input", timeout=10_000)
            page.click("input")
            page.fill("input", PIN)
            print("  filled PIN")
        except PWTimeout:
            screenshot(page, "6-pin-not-found")
            raise RuntimeError("Could not find PIN input. See logs/login-debug-6-pin-not-found.png")

        # Click the final login/continue button
        for btn_text in ["Continue", "Login", "Verify", "Submit"]:
            try:
                page.click(f"button:has-text('{btn_text}')", timeout=5_000)
                print(f"  clicked '{btn_text}'")
                break
            except PWTimeout:
                continue
        else:
            page.press("input", "Enter")

        # ── Step 5: Wait for redirect with auth_code ──────────────────────────
        print("  waiting for auth redirect...")
        deadline = time.time() + 30
        while not auth_code_holder and time.time() < deadline:
            # Also check if URL changed to our redirect URI
            current_url = page.url
            if REDIRECT_URI in current_url and "code=" in current_url:
                parsed = urllib.parse.urlparse(current_url)
                params = urllib.parse.parse_qs(parsed.query)
                code = params.get("code", [None])[0]
                if code:
                    auth_code_holder.append(code)
                    break
            time.sleep(0.5)

        screenshot(page, "7-final")
        browser.close()

    if not auth_code_holder:
        raise RuntimeError(
            "Login completed but no auth_code was captured. "
            "Possible reasons: wrong credentials, Upstox UI changed, or redirect URI mismatch. "
            "Check debug screenshots in logs/"
        )

    return auth_code_holder[0]


# ── Entry point ───────────────────────────────────────────────────────────────
def main() -> None:
    start = time.time()
    now   = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"\n{'='*60}")
    print(f"  Upstox Auto-Login  —  {now}")
    print(f"{'='*60}")

    try:
        auth_code    = run_login()
        access_token = exchange_code_for_token(auth_code)
        write_token(access_token)
        elapsed = time.time() - start
        print(f"[✓] Done in {elapsed:.1f}s\n")
    except Exception as e:
        elapsed = time.time() - start
        print(f"\n[FAILED after {elapsed:.1f}s] {e}")
        print("→ Debug screenshots saved in logs/  (check login-debug-*.png)")
        print("→ Common fixes:")
        print("   - Wrong TOTP secret: re-export from Upstox app → Profile → Security")
        print("   - Wrong PIN: the 6-digit login PIN (not trading PIN)")
        print("   - Wrong mobile: 10 digits, no +91")
        print("   - REDIRECT_URI mismatch: must exactly match Upstox developer portal setting\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
