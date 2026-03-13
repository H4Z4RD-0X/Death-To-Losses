import { IndexSymbol } from "@/lib/types";
import type { OptionChainFetchResult, ExpiryChainPair } from "./upstox";

export interface BrokerClient {
  id: string;
  name: string;
  fetchOptionChain(index: IndexSymbol, expiryDate?: string): Promise<OptionChainFetchResult>;
  fetchNiftyWeekMonthChains(tradeDate?: string): Promise<ExpiryChainPair>;
  probeAccessToken(accessToken: string): Promise<{ ok: true } | { ok: false; error: string }>;
  exchangeAuthorizationCode(input: { code: string; redirectUri: string }): Promise<{ accessToken: string; expiresAt: number | null }>;
}
