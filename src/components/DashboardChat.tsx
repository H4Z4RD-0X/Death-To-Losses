"use client";

import { useState, useRef, useEffect } from "react";

interface Message {
  role: "user" | "assistant";
  content: string;
}

const QUICK_PROMPTS = [
  "What happened today so far?",
  "What is happening on this strike right now?",
  "Where is smart money positioned?",
  "What did FIIs hold yesterday and what did they do today?",
  "Who is trapping retail traders here?",
  "Where are the call wall and put wall?",
  "What does the prop desk vs retail setup say?",
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
        title="Ask DeepSeek about today's session"
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
                Ask DeepSeek — Today&apos;s Session
              </div>
              <div style={{ fontSize: 10, color: "var(--muted)" }}>
                Powered by DeepSeek · Reads live flow and recalls archived market analogs
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
                <div style={{ marginTop: 4 }}>I can read live captures, strike walls, FII/PRO/CLIENT shifts, and similar past setups.</div>
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
              placeholder="Ask about a strike, FII moves, traps, or today&apos;s structure…"
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
