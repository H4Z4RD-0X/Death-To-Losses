import { IndexSymbol } from "@/lib/types";
import { BrokerClient } from "./interface";
import { OptionChainFetchResult, ExpiryChainPair } from "./upstox";

export const fyersBroker: BrokerClient = {
  id: "fyers",
  name: "Fyers",
  
  async fetchOptionChain(_index: IndexSymbol, _expiryDate?: string): Promise<OptionChainFetchResult> {
    throw new Error("Fyers integration is not yet implemented.");
  },

  async fetchNiftyWeekMonthChains(_tradeDate?: string): Promise<ExpiryChainPair> {
    throw new Error("Fyers integration is not yet implemented.");
  },

  async probeAccessToken(_accessToken: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return { ok: false, error: "Fyers integration is not yet implemented." };
  },

  async exchangeAuthorizationCode(_input: { code: string; redirectUri: string }): Promise<{ accessToken: string; expiresAt: number | null }> {
    throw new Error("Fyers integration is not yet implemented.");
  }
};
