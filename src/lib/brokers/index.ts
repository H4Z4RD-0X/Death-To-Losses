import type { BrokerClient } from "./interface";
import { upstoxBroker } from "./upstox";
import { dhanBroker } from "./dhan";
import { zerodhaBroker } from "./zerodha";
import { fyersBroker } from "./fyers";
import { angelOneBroker } from "./angelone";

export const brokers: Record<string, BrokerClient> = {
  upstox: upstoxBroker,
  dhan: dhanBroker,
  zerodha: zerodhaBroker,
  fyers: fyersBroker,
  angelone: angelOneBroker,
};

export function getBroker(id: string): BrokerClient {
  const broker = brokers[id];
  if (!broker) {
    throw new Error(`Broker not found: ${id}`);
  }
  return broker;
}

export function getActiveBroker(): BrokerClient {
  const activeId = process.env.ACTIVE_BROKER || "upstox";
  return getBroker(activeId);
}

export * from "./interface";
