import type { SignalKind } from "@/lib/types";

const LABELS: Record<SignalKind, string> = {
  CALL_SHORT_COVERING: "Call Shorts Closing",
  PUT_WRITING: "Put Writing",
  DIRECTIONAL_OPTION_BUYING: "Option Buying",
  PUT_WRITING_UNWIND: "Put Writing Unwind",
  NEUTRAL: "Neutral"
};

export function SignalBadge({ kind }: { kind: SignalKind }) {
  return <span className={`signal signal-${kind.toLowerCase()}`}>{LABELS[kind]}</span>;
}
