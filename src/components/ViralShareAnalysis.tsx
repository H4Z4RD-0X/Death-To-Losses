"use client";

import { useState } from "react";

interface ShareData {
    tone: string;
    trapStrength: string;
    summary: string;
}

export function ViralShareAnalysis({ data }: { data: ShareData }) {
    const [copied, setCopied] = useState(false);

    const shareText = `📉 Smart Money Intelligence Summary:
    
🔴 Market Tone: ${data.tone}
⚠ Trap Risk: ${data.trapStrength}
💡 Analysis: ${data.summary}

Get the edge at Death-To-Losses. Free real-time FII/PRO vs Retail analytics.
#Nifty #OptionsTrading #SmartMoney`;

    const handleCopy = () => {
        navigator.clipboard.writeText(shareText);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="p-8 rounded-3xl bg-gradient-to-br from-indigo-500/10 via-purple-500/5 to-transparent border border-indigo-500/20 relative overflow-hidden group">
            <div className="absolute top-0 right-0 -m-4 w-32 h-32 bg-indigo-500/10 blur-3xl rounded-full group-hover:bg-indigo-500/20 transition-all duration-700" />
            
            <div className="relative z-10">
                <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
                    <div className="flex-1">
                        <h3 className="text-2xl font-bold text-white mb-2">Trade Like a PRO</h3>
                        <p className="text-slate-300 leading-relaxed max-w-2xl">
                            Our proprietary algorithm detected a <span className="text-indigo-400 font-semibold">{data.trapStrength} trap risk</span>. 
                            Share this insight with your trading group to protect more retail traders from preventable losses.
                        </p>
                    </div>
                    
                    <button 
                        onClick={handleCopy}
                        className="flex items-center justify-center gap-3 px-8 py-4 bg-indigo-600 hover:bg-indigo-500 text-white font-bold rounded-2xl transition-all active:scale-95 shadow-lg shadow-indigo-600/20"
                    >
                        {copied ? (
                            <>
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                                </svg>
                                Copied Intel!
                            </>
                        ) : (
                            <>
                                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" />
                                </svg>
                                Share Today&apos;s Strategy
                            </>
                        )}
                    </button>
                </div>

                <div className="mt-8 pt-8 border-t border-slate-800 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-6">
                    <div className="flex flex-col gap-1">
                        <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Community Reach</span>
                        <span className="text-white text-lg font-mono">1.2M+ Views</span>
                    </div>
                    <div className="flex flex-col gap-1">
                        <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Losses Prevented</span>
                        <span className="text-white text-lg font-mono">₹42.8 Cr+</span>
                    </div>
                    <div className="flex flex-col gap-1">
                        <span className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Real-time Latency</span>
                        <span className="text-emerald-400 text-lg font-mono">&lt; 188s</span>
                    </div>
                    <div className="flex flex-col gap-1 text-right">
                        <span className="text-indigo-400 font-bold hover:underline cursor-pointer">Join 15K+ Elite Traders →</span>
                    </div>
                </div>
            </div>
        </div>
    );
}
