import type { LiveApiResponse } from "@/lib/types";

type Action = LiveApiResponse["participantIntel"]["strikeInferences"][0]["action"];
type LikelyParticipant = LiveApiResponse["participantIntel"]["strikeInferences"][0]["likelyParticipant"];

function participantToneClass(participant: LikelyParticipant): string {
    if (participant === "FII" || participant === "PRO") {
        return "status-matched";
    }
    if (participant === "CLIENT") {
        return "status-unavailable";
    }
    return "status-neutral";
}

function actionLabel(action: Action): string {
    return action.replaceAll("_", " ");
}

export function ParticipantIntelTable({ inferences }: { inferences: LiveApiResponse["participantIntel"]["strikeInferences"] }) {
    if (!inferences || inferences.length === 0) {
        return <p className="events-empty">No dominant player action identified recently.</p>;
    }

    return (
        <div className="table-shell eod-table-shell">
            <table className="vibe-table intel-table">
                <thead>
                    <tr>
                        <th>Strike</th>
                        <th>Side</th>
                        <th>Inferred Participant</th>
                        <th>Action</th>
                        <th>Intel Confidence</th>
                    </tr>
                </thead>
                <tbody>
                    {inferences.map((inf, i) => (
                        <tr key={i}>
                            <td className="strike-cell">{inf.strike}</td>
                            <td>{inf.side}</td>
                            <td>
                                <span className={`status-pill ${participantToneClass(inf.likelyParticipant)}`}>
                                    {inf.likelyParticipant}
                                </span>
                            </td>
                            <td><strong>{actionLabel(inf.action)}</strong></td>
                            <td className="event-confidence">{inf.confidence.toFixed(0)}%</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
