import type { ParticipantRecord } from "@/lib/types";

function num(value: number | undefined | null, digits = 2): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return "nan";
    return value.toLocaleString("en-IN", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
}

function signed(value: number | undefined | null, digits = 2): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return "nan";
    const str = value.toLocaleString("en-IN", {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
    return value > 0 ? `+${str}` : str;
}

function valueClass(value: number | undefined | null): string {
    if (!value) return "cell-neutral";
    return value > 0 ? "cell-pos" : "cell-neg";
}

export function ParticipantSummaryTable({ rows }: { rows: ParticipantRecord[] }) {
    if (!rows || rows.length === 0) {
        return <p className="events-empty">No EOD participants data available.</p>;
    }

    return (
        <div className="table-shell eod-table-shell">
            <table className="vibe-table">
                <thead>
                    <tr>
                        <th>Participant</th>
                        <th>Idx Future</th>
                        <th>Idx Call</th>
                        <th>Idx Put</th>
                        <th>Stk Future</th>
                        <th>Stk Call</th>
                        <th>Stk Put</th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row) => (
                        <tr key={row.participant}>
                            <td className="strike-cell">{row.participant}</td>
                            <td className={valueClass(row.today.indexFuture)}>{signed(row.today.indexFuture, 0)}</td>
                            <td className={valueClass(row.today.indexCall)}>{signed(row.today.indexCall, 0)}</td>
                            <td className={valueClass(row.today.indexPut)}>{signed(row.today.indexPut, 0)}</td>
                            <td className={valueClass(row.today.stockFuture)}>{signed(row.today.stockFuture, 0)}</td>
                            <td className={valueClass(row.today.stockCall)}>{signed(row.today.stockCall, 0)}</td>
                            <td className={valueClass(row.today.stockPut)}>{signed(row.today.stockPut, 0)}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
