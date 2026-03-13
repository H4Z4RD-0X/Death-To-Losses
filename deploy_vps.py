#!/usr/bin/env python3
"""
NIFTY Dashboard — One-shot VPS deploy script.
Run this ON THE VPS:  python3 deploy_vps.py
It writes all updated files and patches timers, then you just do:
  cd /opt/nifty && npm run build && pm2 restart nifty
"""
import os, sys

BASE = "/opt/nifty"

def write(rel, content):
    path = os.path.join(BASE, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    print(f"  ✓  {rel}")

def patch(rel, old, new, label=""):
    path = os.path.join(BASE, rel)
    with open(path, encoding="utf-8") as f:
        content = f.read()
    if old in content:
        with open(path, "w", encoding="utf-8") as f:
            f.write(content.replace(old, new, 1))
        print(f"  ✓  {rel} — {label or 'patched'}")
    else:
        print(f"  –  {rel} — already correct ({label}), skipping")

print("\n=== NIFTY VPS DEPLOY ===\n")

# ─────────────────────────────────────────────────────────────────────────────
# 1. Timer fixes (idempotent)
# ─────────────────────────────────────────────────────────────────────────────
print("── Timer fixes ──")
patch("src/lib/liveTracker.ts",
      "SAMPLE_FORCE_INTERVAL_MS ?? 188_000",
      "SAMPLE_FORCE_INTERVAL_MS ?? 185_000",
      "server gate → 185 s")

patch("src/app/page.tsx",
      "const REFRESH_INTERVAL_MS = 180_000",
      "const REFRESH_INTERVAL_MS = 188_000",
      "client poll → 188 s")

# ─────────────────────────────────────────────────────────────────────────────
# 2. Add DashboardChat to page.tsx (idempotent)
# ─────────────────────────────────────────────────────────────────────────────
print("\n── DashboardChat in page.tsx ──")
page_path = os.path.join(BASE, "src/app/page.tsx")
with open(page_path, encoding="utf-8") as f:
    pg = f.read()

changed = False
if 'DashboardChat' not in pg:
    # Insert import after "use client";
    pg = pg.replace(
        '"use client";\n',
        '"use client";\n\nimport { DashboardChat } from "@/components/DashboardChat";\n',
        1
    )
    changed = True
    print("  ✓  added DashboardChat import")
else:
    print("  –  DashboardChat import already present")

if '<DashboardChat' not in pg:
    # Add component just before closing </main>
    pg = pg.replace(
        '      </main>',
        '      <DashboardChat index="NIFTY" strike={payload?.strike ?? strike} />\n      </main>',
        1
    )
    changed = True
    print("  ✓  added <DashboardChat> usage")
else:
    print("  –  <DashboardChat> already present")

if changed:
    with open(page_path, "w", encoding="utf-8") as f:
        f.write(pg)

# ─────────────────────────────────────────────────────────────────────────────
# 3. src/app/api/chat/route.ts  (new file)
# ─────────────────────────────────────────────────────────────────────────────
print("\n── Chat API route ──")
write("src/app/api/chat/route.ts", r'''import { NextRequest, NextResponse } from "next/server";
import { getLivePayload } from "@/lib/liveTracker";
import type { IndexSymbol, LiveApiResponse, SnapshotRow } from "@/lib/types";

export const dynamic = "force-dynamic";

// ── Build a rich text summary of today's session for Claude ─────────────────
function buildSessionContext(index: string, strike: number | undefined, payload: LiveApiResponse | null): string {
  const rows: SnapshotRow[] = payload?.rows ?? [];
  const spot     = payload?.underlyingSpot ?? null;
  const radar    = payload?.radar;
  const summary  = payload?.intradaySummary;
  const tally    = payload?.eodTally;
  const corr     = payload?.eodCorrelation;
  const partSum  = payload?.participantsSummary;

  const lines: string[] = [];

  lines.push(`=== NIFTY SMART MONEY DASHBOARD — SESSION CONTEXT ===`);
  lines.push(`Index: ${index} | Selected Strike: ${strike ?? "auto-ATM"}`);
  lines.push(`Current Spot: ${spot != null ? spot.toLocaleString("en-IN", { minimumFractionDigits: 2 }) : "unavailable"}`);
  lines.push(`Total Captures Today: ${rows.length}`);
  lines.push("");

  // ── Signal history (most recent 20 rows) ──────────────────────────────────
  if (rows.length > 0) {
    lines.push("--- CAPTURE HISTORY (newest first, up to 20 rows) ---");
    const recent = [...rows].reverse().slice(0, 20);
    for (const r of recent) {
      const ceInt = r.ce.intraday != null ? r.ce.intraday.toFixed(3) : "—";
      const peInt = r.pe.intraday != null ? r.pe.intraday.toFixed(3) : "—";
      const cePos = (r.ce.positional ?? r.ce.coiVol) != null
        ? ((r.ce.positional ?? r.ce.coiVol)!).toFixed(2) : "—";
      const pePos = (r.pe.positional ?? r.pe.coiVol) != null
        ? ((r.pe.positional ?? r.pe.coiVol)!).toFixed(2) : "—";
      const ceDoi = r.ce.oiRoc != null ? `${r.ce.oiRoc > 0 ? "+" : ""}${r.ce.oiRoc.toFixed(1)}` : "—";
      const peDoi = r.pe.oiRoc != null ? `${r.pe.oiRoc > 0 ? "+" : ""}${r.pe.oiRoc.toFixed(1)}` : "—";
      lines.push(
        `${r.displayTime} | Spot ${r.spot?.toFixed(2) ?? "—"} | ` +
        `CE-INT:${ceInt} CE-POS:${cePos} ΔCE-OI:${ceDoi} | ` +
        `PE-INT:${peInt} PE-POS:${pePos} ΔPE-OI:${peDoi} | ` +
        `Signal: ${r.signal.kind.replaceAll("_", " ")} (${r.signal.confidence.toFixed(0)}%) | ` +
        `Chartians: ${r.chartians.verdict}`
      );
    }
    lines.push("");
  }

  // ── Intraday summary ──────────────────────────────────────────────────────
  if (summary) {
    lines.push("--- INTRADAY SUMMARY ---");
    lines.push(`Dominant Signal: ${summary.dominant.replaceAll("_", " ")}`);
    lines.push(`Dominant Confidence: ${summary.dominantConfidence.toFixed(0)}%`);
    lines.push(`Market Tone: ${summary.marketTone}`);
    lines.push(`Latest Narrative: ${summary.latestNarrative}`);
    lines.push("");
  }

  // ── Smart Money Radar ─────────────────────────────────────────────────────
  if (radar) {
    lines.push("--- SMART MONEY RADAR ---");
    lines.push(`Overall Regime: ${radar.regime} | Bullish signals: ${radar.bullishSignals} | Bearish signals: ${radar.bearishSignals}`);
    lines.push(`Summary: ${radar.summary}`);
    if (radar.activeSignals?.length) {
      lines.push("Active Signals:");
      for (const sig of radar.activeSignals.slice(0, 12)) {
        lines.push(
          `  Strike ${sig.strike} ${sig.side} | Zone: ${sig.zone} | Action: ${sig.action} | ` +
          `Bias: ${sig.bias} | Confidence: ${sig.confidence}% | ` +
          `COI/Vol: ${sig.coiVolPower?.toFixed(2) ?? "—"} | Reason: ${sig.reason}`
        );
      }
    }
    lines.push("");
  }

  // ── Participant positioning ───────────────────────────────────────────────
  if (partSum?.rows?.length) {
    lines.push("--- FII / DII / CLIENT / PRO PARTICIPANT POSITIONING ---");
    for (const p of partSum.rows) {
      const net = p.today;
      lines.push(
        `${p.participant} | IndexFut: ${net.indexFuture ?? "—"} | ` +
        `IndexCall: ${net.indexCall ?? "—"} | IndexPut: ${net.indexPut ?? "—"}`
      );
    }
    lines.push("");
  }

  // ── EOD Tally ─────────────────────────────────────────────────────────────
  if (tally) {
    lines.push("--- EOD SMART MONEY vs FII CORRELATION ---");
    lines.push(`Intraday Tone: ${tally.intradayTone} | FII Tone: ${tally.eodFiiTone}`);
    lines.push(`Match Status: ${tally.status}`);
    lines.push(`Summary: ${tally.summary}`);
    if (tally.eodSignals?.length) {
      for (const s of tally.eodSignals) lines.push(`  • ${s}`);
    }
    lines.push("");
  }

  // ── EOD Correlation ───────────────────────────────────────────────────────
  if (corr) {
    lines.push("--- EOD CORRELATION ---");
    lines.push(`Status: ${corr.status} | Score: ${corr.score}`);
    for (const note of corr.notes ?? []) lines.push(`  • ${note}`);
    lines.push("");
  }

  lines.push("=== END OF CONTEXT ===");
  return lines.join("\n");
}

// ── POST /api/chat ────────────────────────────────────────────────────────────
export async function POST(req: NextRequest): Promise<NextResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "ANTHROPIC_API_KEY not set. Add it to .env.local and rebuild." },
      { status: 500 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const userMessage: string = body.message ?? "";
  const index: IndexSymbol  = body.index === "BANKNIFTY" ? "BANKNIFTY" : "NIFTY";
  const strike: number | undefined = body.strike ? Number(body.strike) : undefined;

  if (!userMessage.trim()) {
    return NextResponse.json({ error: "No message provided" }, { status: 400 });
  }

  // Build context from live server state
  const payload = await getLivePayload({ index, strike }).catch(() => null) as LiveApiResponse | null;
  const context = buildSessionContext(index, strike, payload);

  const systemPrompt = `You are a smart options market analyst assistant embedded inside a NIFTY/BANKNIFTY options dashboard.

You have access to today's live session data: every 3-minute snapshot of Call/Put OI, IV, premium changes, smart money signals, radar findings, and FII/DII positioning.

Key terms:
- COI (Change in Open Interest): rising = new positions building, falling = closing
- C-INT / P-INT: intraday COI/Volume ratio — high = institutional conviction
- C-POS / P-POS: positional ratio — >1 = multi-day smart money positioning
- Chartians Verdict: Exchange of Hands / High Conviction Writing / Panic Covering
- Market Tone: BULLISH / BEARISH / MIXED based on dominant signal distribution

Answer in clear, direct language. Be specific about times and values from the data. Avoid jargon unless explaining it. Keep answers concise (3-6 sentences) unless the question requires depth.

Today's session data:

${context}`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type":      "application/json",
        "x-api-key":         apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model:      "claude-sonnet-4-6",
        max_tokens: 1024,
        system:     systemPrompt,
        messages: [
          ...(Array.isArray(body.history) ? body.history : []),
          { role: "user", content: userMessage },
        ],
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      return NextResponse.json(
        { error: `Anthropic API error ${response.status}: ${err}` },
        { status: 500 }
      );
    }

    const data = await response.json();
    const reply = (data.content?.[0]?.text as string) ?? "No response from model.";
    return NextResponse.json({ reply });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
''')

# ─────────────────────────────────────────────────────────────────────────────
# 4. src/components/DashboardChat.tsx  (new file)
# ─────────────────────────────────────────────────────────────────────────────
print("\n── DashboardChat component ──")
write("src/components/DashboardChat.tsx", r'''"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const QUICK_PROMPTS = [
  "What happened today so far?",
  "Where is smart money positioned?",
  "What's the overall bias — bullish or bearish?",
  "Any unusual activity I should watch?",
  "Where are the call wall and put wall?",
  "What does the FII data say?",
];

interface Props {
  index: string;
  strike: number | undefined;
}

export function DashboardChat({ index, strike }: Props) {
  const [open, setOpen]         = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput]       = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const bottomRef               = useRef<HTMLDivElement>(null);
  const inputRef                = useRef<HTMLInputElement>(null);

  // Scroll to bottom whenever messages change
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  // Focus input when opened
  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 100);
  }, [open]);

  async function send(text: string) {
    if (!text.trim() || loading) return;
    setError(null);

    const userMsg: Message = { role: "user", content: text };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: text,
          index,
          strike,
          // Pass last 6 messages as history for multi-turn context
          history: next.slice(-6).slice(0, -1).map((m) => ({
            role: m.role,
            content: m.content,
          })),
        }),
      });
      const data = await res.json();
      if (!res.ok || data.error) {
        setError(data.error ?? "Request failed");
      } else {
        setMessages((prev) => [...prev, { role: "assistant", content: data.reply }]);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setLoading(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(input); }
  }

  return (
    <>
      {/* ── Floating trigger button ── */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Ask Claude about today's session"
        style={{
          position: "fixed", bottom: 24, right: 24, zIndex: 1000,
          width: 52, height: 52, borderRadius: "50%",
          background: "var(--accent)", border: "none", cursor: "pointer",
          boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 22, transition: "transform 0.2s",
          transform: open ? "rotate(45deg)" : "rotate(0deg)",
          color: "#fff",
        }}
      >
        {open ? "✕" : "✦"}
      </button>

      {/* ── Chat panel ── */}
      {open && (
        <div style={{
          position: "fixed", bottom: 88, right: 24, zIndex: 999,
          width: 420, maxWidth: "calc(100vw - 32px)",
          height: 560, maxHeight: "calc(100vh - 120px)",
          background: "var(--bg-card)", border: "1px solid var(--line-strong)",
          borderRadius: 12, boxShadow: "0 8px 40px rgba(0,0,0,0.45)",
          display: "flex", flexDirection: "column", overflow: "hidden",
        }}>

          {/* Header */}
          <div style={{
            padding: "12px 16px", borderBottom: "1px solid var(--line-strong)",
            background: "rgba(193,95,60,0.08)",
            display: "flex", alignItems: "center", gap: 10,
          }}>
            <span style={{ fontSize: 18 }}>✦</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: 13, color: "var(--text)" }}>
                Ask Claude — Today&apos;s Session
              </div>
              <div style={{ fontSize: 10, color: "var(--muted)" }}>
                Powered by Claude Sonnet · Has full access to today&apos;s data
              </div>
            </div>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => { setMessages([]); setError(null); }}
                title="Clear chat"
                style={{
                  fontSize: 10, color: "var(--muted)", background: "transparent",
                  border: "1px solid var(--line-strong)", borderRadius: 4,
                  padding: "2px 6px", cursor: "pointer",
                }}
              >
                Clear
              </button>
            )}
          </div>

          {/* Messages */}
          <div style={{
            flex: 1, overflowY: "auto", padding: "12px 14px",
            display: "flex", flexDirection: "column", gap: 10,
          }}>
            {messages.length === 0 && (
              <div style={{ color: "var(--muted)", fontSize: 12, textAlign: "center", marginTop: 16 }}>
                <div style={{ fontSize: 28, marginBottom: 8 }}>✦</div>
                <div>Ask me anything about today&apos;s NIFTY session.</div>
                <div style={{ marginTop: 4 }}>I have full access to every 3-min capture.</div>
              </div>
            )}

            {messages.map((m, i) => (
              <div key={i} style={{
                alignSelf: m.role === "user" ? "flex-end" : "flex-start",
                maxWidth: "88%",
              }}>
                <div style={{
                  padding: "8px 12px", borderRadius: m.role === "user" ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
                  background: m.role === "user" ? "var(--accent)" : "var(--bg-row)",
                  color: m.role === "user" ? "#fff" : "var(--text)",
                  fontSize: 12.5, lineHeight: 1.55,
                  border: m.role === "assistant" ? "1px solid var(--line-strong)" : "none",
                  whiteSpace: "pre-wrap",
                }}>
                  {m.content}
                </div>
              </div>
            ))}

            {loading && (
              <div style={{ alignSelf: "flex-start", maxWidth: "88%" }}>
                <div style={{
                  padding: "8px 12px", borderRadius: "12px 12px 12px 4px",
                  background: "var(--bg-row)", border: "1px solid var(--line-strong)",
                  fontSize: 12, color: "var(--muted)",
                }}>
                  <span style={{ animation: "pulse 1.2s infinite" }}>Analysing session data…</span>
                </div>
              </div>
            )}

            {error && (
              <div style={{
                padding: "8px 12px", borderRadius: 8, background: "rgba(220,60,0,0.12)",
                border: "1px solid rgba(220,60,0,0.3)", color: "var(--bear)",
                fontSize: 11,
              }}>
                ⚠ {error}
              </div>
            )}

            <div ref={bottomRef} />
          </div>

          {/* Quick prompts */}
          {messages.length === 0 && (
            <div style={{
              padding: "8px 12px", borderTop: "1px solid var(--line-strong)",
              display: "flex", flexWrap: "wrap", gap: 6,
            }}>
              {QUICK_PROMPTS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => void send(q)}
                  disabled={loading}
                  style={{
                    fontSize: 10, padding: "4px 8px", borderRadius: 20,
                    border: "1px solid var(--accent)", background: "rgba(193,95,60,0.08)",
                    color: "var(--accent)", cursor: "pointer", lineHeight: 1.4,
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          {/* Input */}
          <div style={{
            padding: "10px 12px", borderTop: "1px solid var(--line-strong)",
            display: "flex", gap: 8, alignItems: "center",
          }}>
            <input
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKey}
              placeholder="Ask about today's session…"
              disabled={loading}
              style={{
                flex: 1, padding: "8px 12px", borderRadius: 8,
                border: "1px solid var(--line-strong)", background: "var(--bg-row)",
                color: "var(--text)", fontSize: 12.5, outline: "none",
              }}
            />
            <button
              type="button"
              onClick={() => void send(input)}
              disabled={loading || !input.trim()}
              style={{
                padding: "8px 14px", borderRadius: 8,
                background: input.trim() && !loading ? "var(--accent)" : "var(--line-strong)",
                color: "#fff", border: "none", cursor: input.trim() && !loading ? "pointer" : "not-allowed",
                fontSize: 12, fontWeight: 700, transition: "background 0.2s",
              }}
            >
              Ask
            </button>
          </div>
        </div>
      )}
    </>
  );
}
''')

# ─────────────────────────────────────────────────────────────────────────────
# 5. src/components/LiveChainTable.tsx  (SPOT removed + intensity bold)
# ─────────────────────────────────────────────────────────────────────────────
print("\n── LiveChainTable.tsx ──")
write("src/components/LiveChainTable.tsx", r'''"use client";

import { useCallback } from "react";
import type React from "react";
import type { SnapshotRow } from "@/lib/types";
import { classifyLegReading } from "@/lib/legReading";

/* ── tiny formatters ─────────────────────────────────────────────────────── */
function n(v: number | null, d = 0): string {
  if (v === null || Number.isNaN(v)) return "—";
  return v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}
function s(v: number | null, d = 1): string {
  if (v === null || Number.isNaN(v)) return "—";
  return `${v > 0 ? "+" : ""}${v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}
function ar(v: number | null): string {
  if (v === null || Math.abs(v ?? 0) < 0.000001) return "•";
  return v! > 0 ? "▲" : "▼";
}
function arCls(v: number | null): string {
  if (v === null || Math.abs(v ?? 0) < 0.000001) return "arrow-flat";
  return v! > 0 ? "arrow-up" : "arrow-down";
}
function vc(v: number | null): string {
  if (v === null) return "cell-neutral";
  return v > 0 ? "cell-pos" : v < 0 ? "cell-neg" : "cell-neutral";
}
function pc(v: number | null): string {
  if (v === null) return "";
  return Math.abs(v) < 1 ? "efficiency-noise" : Math.abs(v) > 4 ? "efficiency-alert" : "";
}
function posOf(leg: SnapshotRow["ce"]): number | null {
  return leg.positional ?? leg.halchalRatio ?? leg.coiVol ?? null;
}

/* ── Intensity gradient ───────────────────────────────────────────────────── */
// Computes a 0-1 "action intensity" score for each row.
// Drivers: signal confidence + intraday pressure + positional conviction.
// Higher = brighter amber glow on the row so hot rows pop out instantly.
function rowIntensity(row: SnapshotRow): number {
  const conf    = (row.signal.confidence ?? 0) / 100;                          // 0-1
  const ceI     = Math.min(Math.abs(row.ce.intraday ?? 0), 25) / 25;           // intraday, cap 25
  const peI     = Math.min(Math.abs(row.pe.intraday ?? 0), 25) / 25;
  const ceP     = Math.min(Math.abs(posOf(row.ce) ?? 0), 12) / 12;             // positional, cap 12
  const peP     = Math.min(Math.abs(posOf(row.pe) ?? 0), 12) / 12;
  const pressure   = Math.max(ceI, peI);
  const positional = Math.max(ceP, peP);
  return Math.min(1, conf * 0.35 + pressure * 0.40 + positional * 0.25);
}

// Row stays white — intensity is shown via bold/vivid text on the key cells only.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function intensityStyle(_score: number): React.CSSProperties { return {}; }

// Applied to C-INT, P-INT, C-POS, P-POS and signal cells.
// Low activity = normal weight. High activity = bold + accent colour.
function keyMetricStyle(score: number): React.CSSProperties {
  if (score < 0.30) return {};
  if (score < 0.55) return { fontWeight: 600 };
  if (score < 0.75) return { fontWeight: 700, color: "var(--accent)" };
  return               { fontWeight: 800, color: "var(--accent)", textShadow: "0 0 6px rgba(193,95,60,0.35)" };
}

/* ── CSV export ──────────────────────────────────────────────────────────── */
function exportToCsv(rows: SnapshotRow[], strike: number) {
  const H = [
    "Time","Strike","Spot",
    "CE OI","CE OI-ROC","CE Volume","CE Vol-ROC","CE IV","CE IV-ROC","CE LTP","CE Positional","CE Intraday","CE Reading",
    "PE OI","PE OI-ROC","PE Volume","PE Vol-ROC","PE IV","PE IV-ROC","PE LTP","PE Positional","PE Intraday","PE Reading",
    "Signal","Confidence %","Chartians Verdict",
  ].join(",");

  const csv = [
    H,
    ...rows.map((r) => {
      const ceR = classifyLegReading("CE", r.ce);
      const peR = classifyLegReading("PE", r.pe);
      const esc = (v: string) => v.includes(",") ? `"${v.replace(/"/g, '""')}"` : v;
      return [
        r.displayTime, r.strike, r.spot ?? "",
        r.ce.oi ?? "", r.ce.oiRoc ?? "", r.ce.volume ?? "", r.ce.volumeRoc ?? "",
        r.ce.iv ?? "", r.ce.ivRoc ?? "", r.ce.ltp ?? "", posOf(r.ce) ?? "", r.ce.intraday ?? "", esc(ceR),
        r.pe.oi ?? "", r.pe.oiRoc ?? "", r.pe.volume ?? "", r.pe.volumeRoc ?? "",
        r.pe.iv ?? "", r.pe.ivRoc ?? "", r.pe.ltp ?? "", posOf(r.pe) ?? "", r.pe.intraday ?? "", esc(peR),
        esc(r.signal.kind.replaceAll("_"," ")), r.signal.confidence.toFixed(1), esc(r.chartians.verdict),
      ].join(",");
    }),
  ].join("\n");

  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `NIFTY-${strike}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/* ── Component ────────────────────────────────────────────────────────────── */
export function LiveChainTable({ rows, strike = 0 }: { rows: SnapshotRow[]; strike?: number }) {
  const doExport = useCallback(() => exportToCsv(rows, strike), [rows, strike]);

  return (
    <div className="lct-wrap">
      {/* toolbar */}
      <div className="lct-toolbar">
        <span className="lct-count">{rows.length} captures</span>
        <button
          type="button"
          className="export-btn"
          onClick={doExport}
          disabled={rows.length === 0}
          title="Download all rows as CSV — opens in Excel"
        >
          ⬇ Export CSV
        </button>
      </div>

      <div className="table-shell lct-shell">
        <table className="chain-table timeline-table lct-table">
          <thead>
            <tr>
              {/* CE side */}
              <th title="Time of capture">TIME</th>
              <th title="Call OI: total open contracts. Arrow = direction vs last capture">C-OI ↕</th>
              <th title="Change in Call OI % vs last capture. + = new contracts opened (smart money entering)">ΔC-OI</th>
              <th title="Call Volume traded in this window">C-VOL</th>
              <th title="Call Implied Volatility — higher IV = more uncertainty priced in">C-IV</th>
              <th title="Change in Call IV. Negative = IV falling while OI rising = calm conviction">ΔC-IV</th>
              <th title="Call Last Traded Price">C-LTP</th>
              <th title="CE Positional Ratio — >1 = smart money building long-term positions, not just day-trading">C-POS</th>
              <th title="CE Intraday pressure ratio">C-INT</th>
              <th title="Smart money reading for Call side at this capture">CE SIGNAL</th>
              {/* PE side */}
              <th title="Put OI: total open contracts. Arrow = direction vs last capture">P-OI ↕</th>
              <th title="Change in Put OI % vs last capture. + = new hedges/puts being built">ΔP-OI</th>
              <th title="Put Volume traded in this window">P-VOL</th>
              <th title="Put Implied Volatility">P-IV</th>
              <th title="Change in Put IV">ΔP-IV</th>
              <th title="Put Last Traded Price">P-LTP</th>
              <th title="PE Positional Ratio">P-POS</th>
              <th title="PE Intraday pressure ratio">P-INT</th>
              <th title="Smart money reading for Put side">PE SIGNAL</th>
              {/* Combined */}
              <th title="Strike price + overall signal + Chartians verdict">STRIKE / VERDICT</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={20} style={{ textAlign: "center", padding: "20px", color: "var(--muted)" }}>
                  No captures yet for this session. Data appears every ~3 minutes once market is open.
                </td>
              </tr>
            ) : rows.map((row) => {
              const ceR    = classifyLegReading("CE", row.ce);
              const peR    = classifyLegReading("PE", row.pe);
              const ceP    = posOf(row.ce);
              const peP    = posOf(row.pe);
              const intensity = rowIntensity(row);
              const km        = keyMetricStyle(intensity);
              return (
                <tr key={row.id}>
                  <td className="time-col">{row.displayTime}</td>

                  {/* CE OI */}
                  <td className={`timeline-arrow-cell ${vc(row.ce.oi)}`}>
                    <span className="timeline-arrow-wrap">
                      <span className={`arrow-icon ${arCls(row.ce.oiRoc)}`}>{ar(row.ce.oiRoc)}</span>
                      <span>{n(row.ce.oi)}</span>
                    </span>
                  </td>
                  <td className={vc(row.ce.oiRoc)}>{s(row.ce.oiRoc)}</td>
                  <td className={vc(row.ce.volume)}>{n(row.ce.volume)}</td>
                  <td>{n(row.ce.iv, 2)}</td>
                  <td className={vc(row.ce.ivRoc)}>{s(row.ce.ivRoc)}</td>
                  <td className={vc(row.ce.ltp)}>{n(row.ce.ltp, 2)}</td>
                  <td className={`${vc(ceP)} ${pc(ceP)}`} style={km}>{s(ceP, 2)}</td>
                  <td className={`timeline-arrow-cell ${vc(row.ce.intraday)}`} style={km}>
                    <span className="timeline-arrow-wrap">
                      <span className={`arrow-icon ${arCls(row.ce.intraday)}`}>{ar(row.ce.intraday)}</span>
                      <span>{s(row.ce.intraday, 3)}</span>
                    </span>
                  </td>
                  <td className="timeline-side-reading ce-reading" style={km}>{ceR}</td>

                  {/* PE OI */}
                  <td className={`timeline-arrow-cell ${vc(row.pe.oi)}`}>
                    <span className="timeline-arrow-wrap">
                      <span className={`arrow-icon ${arCls(row.pe.oiRoc)}`}>{ar(row.pe.oiRoc)}</span>
                      <span>{n(row.pe.oi)}</span>
                    </span>
                  </td>
                  <td className={vc(row.pe.oiRoc)}>{s(row.pe.oiRoc)}</td>
                  <td className={vc(row.pe.volume)}>{n(row.pe.volume)}</td>
                  <td>{n(row.pe.iv, 2)}</td>
                  <td className={vc(row.pe.ivRoc)}>{s(row.pe.ivRoc)}</td>
                  <td className={vc(row.pe.ltp)}>{n(row.pe.ltp, 2)}</td>
                  <td className={`${vc(peP)} ${pc(peP)}`} style={km}>{s(peP, 2)}</td>
                  <td className={`timeline-arrow-cell ${vc(row.pe.intraday)}`} style={km}>
                    <span className="timeline-arrow-wrap">
                      <span className={`arrow-icon ${arCls(row.pe.intraday)}`}>{ar(row.pe.intraday)}</span>
                      <span>{s(row.pe.intraday, 3)}</span>
                    </span>
                  </td>
                  <td className="timeline-side-reading pe-reading" style={km}>{peR}</td>

                  {/* Signal */}
                  <td className="timeline-reading-cell" style={km}>
                    <span className="lct-strike">{row.strike}</span>
                    <strong className="lct-signal">{row.signal.kind.replaceAll("_", " ")}</strong>
                    <small className="lct-verdict">{row.chartians.verdict}</small>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
''')

# ─────────────────────────────────────────────────────────────────────────────
# 6. src/components/CenteredExpiryTable.tsx  (SPOT column removed)
# ─────────────────────────────────────────────────────────────────────────────
print("\n── CenteredExpiryTable.tsx ──")
write("src/components/CenteredExpiryTable.tsx", r'''"use client";
import { useState } from "react";
import type { ChainDisplaySnapshot, ChainDisplayRow } from "@/lib/types";

function numberCell(value: number | null, digits = 2): string {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function integerCell(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "--";
  }
  return value.toLocaleString("en-IN", { maximumFractionDigits: 0 });
}

function signedIntCell(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "--";
  const s = Math.abs(value).toLocaleString("en-IN", { maximumFractionDigits: 0 });
  return value > 0 ? `+${s}` : value < 0 ? `-${s}` : s;
}

/** COI/Volume ratio — how much OI is changing per unit of volume traded.
 *  > 1.0  : Heavy position building (smart money accumulating)
 *  0–1.0  : Normal intraday activity
 *  Negative: Unwinding positions
 */
function coiVolCell(coi: number | null, volume: number | null): string {
  if (coi === null || volume === null || volume <= 0) return "--";
  const ratio = coi / volume;
  return ratio.toFixed(2);
}

function coiClass(coi: number | null): string {
  if (coi === null || !Number.isFinite(coi)) return "";
  if (coi > 0) return "chain-coi-bull";
  if (coi < 0) return "chain-coi-bear";
  return "";
}

function coiVolClass(coi: number | null, volume: number | null): string {
  if (coi === null || volume === null || volume <= 0) return "";
  const ratio = coi / volume;
  if (ratio > 0.5) return "chain-coi-bull";
  if (ratio < -0.5) return "chain-coi-bear";
  return "";
}

type SortMode = "strike" | "ce_oi" | "pe_oi" | "ce_coi" | "pe_coi";

function sortRows(rows: ChainDisplayRow[], mode: SortMode): ChainDisplayRow[] {
  if (mode === "strike") return [...rows].sort((a, b) => a.strike - b.strike);
  if (mode === "ce_oi")  return [...rows].sort((a, b) => (b.ce.oi ?? 0) - (a.ce.oi ?? 0));
  if (mode === "pe_oi")  return [...rows].sort((a, b) => (b.pe.oi ?? 0) - (a.pe.oi ?? 0));
  if (mode === "ce_coi") return [...rows].sort((a, b) => Math.abs(b.ce.coi ?? 0) - Math.abs(a.ce.coi ?? 0));
  if (mode === "pe_coi") return [...rows].sort((a, b) => Math.abs(b.pe.coi ?? 0) - Math.abs(a.pe.coi ?? 0));
  return rows;
}

export function CenteredExpiryTable({ title, snapshot }: { title: string; snapshot: ChainDisplaySnapshot }) {
  const [sortMode, setSortMode] = useState<SortMode>("strike");
  const displayRows = sortRows(snapshot.rows, sortMode);

  return (
    <section className="centered-chain-section">
      <h2>{title}</h2>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, margin: "4px 0 8px" }}>
        <span style={{ fontSize: 11, color: "var(--muted)", fontWeight: 600 }}>Sort by:</span>
        {(["strike", "ce_oi", "pe_oi", "ce_coi", "pe_coi"] as SortMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setSortMode(m)}
            style={{
              fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 4,
              border: `1px solid ${sortMode === m ? "var(--accent)" : "var(--line-strong)"}`,
              background: sortMode === m ? "rgba(193,95,60,0.12)" : "transparent",
              color: sortMode === m ? "var(--accent)" : "var(--muted)",
              cursor: "pointer",
            }}
          >
            {m === "strike" ? "Strike (default)" : m === "ce_oi" ? "↓ Call OI" : m === "pe_oi" ? "↓ Put OI" : m === "ce_coi" ? "↓ Call COI" : "↓ Put COI"}
          </button>
        ))}
        <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 4 }}>
          Expiry: <strong style={{ color: "var(--text)" }}>{snapshot.expiryDate ?? "--"}</strong>
          {" "}· Spot: <strong style={{ color: "var(--accent)" }}>{numberCell(snapshot.spot, 2)}</strong>
          {" "}· <em>COI/Vol &gt; 0.5 = Smart Money Building</em>
        </span>
      </div>

      <div className="centered-chain-shell">
        <table className="centered-chain-table">
          <thead>
            <tr>
              <th title="COI ÷ Volume. >0.5 = smart money building. Green = bullish activity. Red = bearish.">CE COI/Vol</th>
              <th title="Change in Call OI since today's open. Positive = new call positions added.">CE COI</th>
              <th title="Total Call open interest — how many call contracts exist at this strike.">CE OI</th>
              <th title="Calls traded today. High volume = active interest.">CE Vol</th>
              <th title="Implied Volatility for call. High IV = expensive option.">CE IV</th>
              <th title="Last traded price of the call option.">CE LTP</th>
              <th className="strike-col" title="The strike price.">Strike</th>
              <th title="Last traded price of the put option.">PE LTP</th>
              <th title="Implied Volatility for put. High IV = expensive option.">PE IV</th>
              <th title="Puts traded today. High volume = active interest.">PE Vol</th>
              <th title="Total Put open interest — how many put contracts exist at this strike.">PE OI</th>
              <th title="Change in Put OI since today's open. Positive = new put positions added.">PE COI</th>
              <th title="COI ÷ Volume. >0.5 = smart money building. Green = bullish activity. Red = bearish.">PE COI/Vol</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.rows.length === 0 ? (
              <tr>
                <td colSpan={13} className="chain-empty-row">
                  Chain data unavailable — waiting for first live snapshot.
                </td>
              </tr>
            ) : null}
            {displayRows.map((row) => (
              <tr key={row.strike} className={row.isSpotRow ? "spot-anchor-row" : ""}>
                <td className={coiVolClass(row.ce.coi ?? null, row.ce.volume)}>{coiVolCell(row.ce.coi ?? null, row.ce.volume)}</td>
                <td className={coiClass(row.ce.coi ?? null)}>{signedIntCell(row.ce.coi ?? null)}</td>
                <td>{integerCell(row.ce.oi)}</td>
                <td>{integerCell(row.ce.volume)}</td>
                <td>{numberCell(row.ce.iv, 2)}</td>
                <td>{numberCell(row.ce.ltp, 2)}</td>
                <td className="strike-col">{row.strike}</td>
                <td>{numberCell(row.pe.ltp, 2)}</td>
                <td>{numberCell(row.pe.iv, 2)}</td>
                <td>{integerCell(row.pe.volume)}</td>
                <td>{integerCell(row.pe.oi)}</td>
                <td className={coiClass(row.pe.coi ?? null)}>{signedIntCell(row.pe.coi ?? null)}</td>
                <td className={coiVolClass(row.pe.coi ?? null, row.pe.volume)}>{coiVolCell(row.pe.coi ?? null, row.pe.volume)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

''')

print("\n=== ALL FILES WRITTEN ===")
print("\nNow run:")
print("  cd /opt/nifty && npm run build && pm2 restart nifty")
print("\nAlso make sure ANTHROPIC_API_KEY is in your .env.local:")
print('  grep ANTHROPIC_API_KEY /opt/nifty/.env.local || echo "NOT SET — add it!"')
