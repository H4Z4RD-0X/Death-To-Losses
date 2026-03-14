"use client";

interface RetailTrapResult {
    clientCallPct: number;
    fiiProCallShortPct: number;
    clientPutPct: number;
    fiiProPutShortPct: number;
    longTrap: boolean;
    shortTrap: boolean;
    trapStrength: "EXTREME" | "ELEVATED" | "NONE";
}

export function RetailTrapScorecard({ data }: { data: RetailTrapResult }) {
    const { clientCallPct, fiiProCallShortPct, clientPutPct, fiiProPutShortPct, longTrap, shortTrap, trapStrength } = data;

    const trapColor = 
        trapStrength === "EXTREME" ? "text-red-500" :
        trapStrength === "ELEVATED" ? "text-orange-500" :
        "text-emerald-500";

    const trapBg = 
        trapStrength === "EXTREME" ? "bg-red-500/10 border-red-500/20" :
        trapStrength === "ELEVATED" ? "bg-orange-500/10 border-orange-500/20" :
        "bg-emerald-500/10 border-emerald-500/20";

    return (
        <div className={`p-6 rounded-2xl border ${trapBg} backdrop-blur-md mb-8`}>
            <div className="flex items-center justify-between mb-6">
                <div>
                    <h3 className="text-xl font-bold text-white mb-1">Retail Trap Scorecard</h3>
                    <p className="text-sm text-slate-400">Comparing Retail Longs vs. Institutional Shorts</p>
                </div>
                <div className={`px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider border ${trapColor} border-current`}>
                    {trapStrength === "NONE" ? "Healthy Sentiment" : `${trapStrength} RISK`}
                </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Long Trap Section */}
                <div className={`p-4 rounded-xl border ${longTrap ? "bg-red-500/5 border-red-500/30" : "bg-slate-900/40 border-slate-800"}`}>
                    <div className="flex items-center gap-2 mb-4">
                        <div className={`w-2 h-2 rounded-full ${longTrap ? "bg-red-500 animate-pulse" : "bg-slate-600"}`} />
                        <h4 className="text-sm font-semibold text-slate-200">Call Trap (Long Trap)</h4>
                    </div>
                    
                    <div className="space-y-4">
                        <div>
                            <div className="flex justify-between text-xs mb-1.5">
                                <span className="text-slate-400">Retail Long Exposure</span>
                                <span className="text-white font-medium">{clientCallPct.toFixed(1)}%</span>
                            </div>
                            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                                <div 
                                    className="h-full bg-blue-500 transition-all duration-1000" 
                                    style={{ width: `${Math.min(100, clientCallPct)}%` }} 
                                />
                            </div>
                        </div>
                        
                        <div>
                            <div className="flex justify-between text-xs mb-1.5">
                                <span className="text-slate-400">Smart Money Shorting</span>
                                <span className="text-white font-medium">{fiiProCallShortPct.toFixed(1)}%</span>
                            </div>
                            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                                <div 
                                    className="h-full bg-purple-500 transition-all duration-1000" 
                                    style={{ width: `${Math.min(100, fiiProCallShortPct)}%` }} 
                                />
                            </div>
                        </div>
                    </div>

                    {longTrap && (
                        <p className="mt-4 text-xs text-red-400 leading-relaxed italic">
                            ⚠ High Danger: Retail is heavily long calls while Institutions are writing (selling) them. A sharp reversal is likely to trap retail.
                        </p>
                    )}
                </div>

                {/* Short Trap Section */}
                <div className={`p-4 rounded-xl border ${shortTrap ? "bg-emerald-500/5 border-emerald-500/30" : "bg-slate-900/40 border-slate-800"}`}>
                    <div className="flex items-center gap-2 mb-4">
                        <div className={`w-2 h-2 rounded-full ${shortTrap ? "bg-emerald-500 animate-pulse" : "bg-slate-600"}`} />
                        <h4 className="text-sm font-semibold text-slate-200">Put Trap (Short Trap)</h4>
                    </div>

                    <div className="space-y-4">
                        <div>
                            <div className="flex justify-between text-xs mb-1.5">
                                <span className="text-slate-400">Retail Put Exposure</span>
                                <span className="text-white font-medium">{clientPutPct.toFixed(1)}%</span>
                            </div>
                            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                                <div 
                                    className="h-full bg-blue-500 transition-all duration-1000" 
                                    style={{ width: `${Math.min(100, clientPutPct)}%` }} 
                                />
                            </div>
                        </div>
                        
                        <div>
                            <div className="flex justify-between text-xs mb-1.5">
                                <span className="text-slate-400">Smart Money Shorting Puts</span>
                                <span className="text-white font-medium">{fiiProPutShortPct.toFixed(1)}%</span>
                            </div>
                            <div className="w-full h-2 bg-slate-800 rounded-full overflow-hidden">
                                <div 
                                    className="h-full bg-purple-500 transition-all duration-1000" 
                                    style={{ width: `${Math.min(100, fiiProPutShortPct)}%` }} 
                                />
                            </div>
                        </div>
                    </div>

                    {shortTrap && (
                        <p className="mt-4 text-xs text-emerald-400 leading-relaxed italic">
                            ⚡ Potential Squeeze: Retail is heavily long puts while Institutions are shorting them. An upward move could trigger a massive short squeeze.
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
}
