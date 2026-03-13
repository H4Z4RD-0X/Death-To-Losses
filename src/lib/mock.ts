import type { IndexSymbol } from "@/lib/types";

interface MockState {
  ceOi: number;
  ceVolume: number;
  ceIv: number;
  ceLtp: number;
  peOi: number;
  peVolume: number;
  peIv: number;
  peLtp: number;
  spot: number;
}

const store = new Map<string, MockState>();

function step(value: number, scale: number): number {
  return Math.max(0.01, value + (Math.random() - 0.5) * scale);
}

function init(index: IndexSymbol, strike: number): MockState {
  const baseSpot = index === "BANKNIFTY" ? 51_000 : 24_900;
  const distance = Math.abs(strike - baseSpot);

  return {
    ceOi: 110_000 + distance * 6,
    ceVolume: 280_000,
    ceIv: 13 + distance / 1000,
    ceLtp: 70 + Math.max(0, (baseSpot - strike) / 4),
    peOi: 95_000 + distance * 5,
    peVolume: 260_000,
    peIv: 14 + distance / 1100,
    peLtp: 72 + Math.max(0, (strike - baseSpot) / 4),
    spot: baseSpot
  };
}

export function nextMockStrike(index: IndexSymbol, strike: number): MockState {
  const key = `${index}-${strike}`;
  const current = store.get(key) ?? init(index, strike);

  const drift = Math.random() > 0.5 ? 1 : -1;

  const nextState: MockState = {
    ceOi: step(current.ceOi + drift * 220, 1200),
    ceVolume: step(current.ceVolume + 700, 2400),
    ceIv: step(current.ceIv + drift * 0.04, 0.22),
    ceLtp: step(current.ceLtp + drift * 0.28, 2.8),
    peOi: step(current.peOi - drift * 190, 1100),
    peVolume: step(current.peVolume + 730, 2500),
    peIv: step(current.peIv - drift * 0.03, 0.21),
    peLtp: step(current.peLtp - drift * 0.24, 2.5),
    spot: step(current.spot + drift * 0.8, 6)
  };

  store.set(key, nextState);
  return nextState;
}
