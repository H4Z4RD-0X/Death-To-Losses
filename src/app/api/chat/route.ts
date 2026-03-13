import { NextRequest, NextResponse } from "next/server";
import { getLivePayload } from "@/lib/liveTracker";
import { retrievePatternMemories, type PatternMemoryRecall } from "@/lib/patternMemory";
import type {
  LiveApiResponse
} from "@/lib/types";
import {
  buildSessionContext,
  buildSystemPrompt,
  extractStrikeFromMessage,
  previousTradeDate,
  resolveIndex,
  sanitizeHistory,
  shouldUseReasoner
} from "@/lib/deepseekContext";

export const dynamic = "force-dynamic";

interface HistoryMessage {
  role: "user" | "assistant";
  content: string;
}


export async function POST(req: NextRequest): Promise<NextResponse> {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "DEEPSEEK_API_KEY is not set. Add it to .env.local and rebuild." },
      { status: 500 }
    );
  }

  const body = await req.json().catch(() => ({}));
  const userMessage = typeof body.message === "string" ? body.message.trim() : "";
  if (!userMessage) {
    return NextResponse.json({ error: "No message provided." }, { status: 400 });
  }

  const index = resolveIndex(body.index, userMessage);
  const uiStrike = Number(body.strike);
  const messageStrike = extractStrikeFromMessage(userMessage);
  const requestedStrike =
    typeof messageStrike === "number" ? messageStrike :
    Number.isFinite(uiStrike) ? uiStrike :
    undefined;

  try {
    const payload = await getLivePayload({ index, strike: requestedStrike });
    const prevDate = previousTradeDate(payload);
    const previousPayload = prevDate
      ? await getLivePayload({ index, strike: requestedStrike ?? payload.strike, tradeDate: prevDate }).catch(() => null)
      : null;
    const patternMemories = await retrievePatternMemories({
      payload,
      requestedStrike: requestedStrike ?? payload.strike,
      question: userMessage,
      limit: 5
    }).catch(() => []);

    const context = buildSessionContext({
      question: userMessage,
      index,
      requestedStrike: requestedStrike ?? payload.strike,
      payload,
      previousPayload,
      patternMemories
    });

    const history = sanitizeHistory(body.history);
    const useReasoner = shouldUseReasoner(userMessage);
    const modelName = useReasoner
      ? process.env.DEEPSEEK_REASONER_MODEL ?? "deepseek-reasoner"
      : process.env.DEEPSEEK_CHAT_MODEL ?? "deepseek-chat";

    const requestBody: {
      model: string;
      messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
      max_tokens: number;
      temperature?: number;
      top_p?: number;
      stream: false;
    } = {
      model: modelName,
      messages: [
        { role: "system", content: buildSystemPrompt() },
        ...history.map((message) => ({
          role: message.role,
          content: message.content
        })),
        { role: "user", content: `${context}\n\nUser question: ${userMessage}` }
      ],
      max_tokens: 1600,
      stream: false
    };

    if (!useReasoner) {
      requestBody.temperature = 0.2;
      requestBody.top_p = 0.9;
    }

    const response = await fetch(
      "https://api.deepseek.com/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const err = await response.text();
      return NextResponse.json(
        { error: `DeepSeek API error ${response.status}: ${err}` },
        { status: 500 }
      );
    }

    const data = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      error?: { message?: string };
    };
    const reply = data.choices?.[0]?.message?.content?.trim() ?? "";

    if (!reply) {
      const message = data.error?.message
        ? `DeepSeek returned no text. ${data.error.message}`
        : "DeepSeek returned no text.";
      return NextResponse.json({ error: message }, { status: 500 });
    }

    return NextResponse.json({
      reply,
      strikeUsed: payload.strike,
      prevTradeDate: prevDate,
      modelUsed: modelName,
      recalledPatterns: patternMemories.length
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
