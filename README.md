# NIFTY Smart Money Options Tracker

A self-hosted, real-time dashboard for tracking **where institutional ("smart money") traders are actually positioned** in NIFTY & BANKNIFTY options — built with multi-broker support (Dhan, Upstox, AngelOne, etc.), automated authentication, and zero manual intervention required.

> **Plain-English summary:** Every 3 minutes, this tool fetches the full options chain from your chosen broker (Dhan, Upstox, etc.), runs several analytical models on it, and gives you a live dashboard showing — in simple terms — whether large traders are building bullish or bearish positions, where the key support/resistance strikes are, and what the overall market positioning looks like heading into expiry.

---

## Why this exists

Most retail traders watch price. Institutional traders watch **open interest and volume together** — because price can be faked in the short term, but it is very hard to fake thousands of crores worth of open positions. This dashboard is built around that idea: instead of guessing where the market will go, it tracks where the big money *is already positioned*.

---

## Features

### Real-Time Options Chain Analysis (every 188 seconds)

Fetches the full NIFTY/BANKNIFTY options chain and computes, for every strike:

- **Change in OI (COI)** — how many new contracts were added or closed since the last snapshot
- **COI/Volume Ratio** — the core signal: `(ΔCOI × lot_size × NT) / TQ` where NT = number of trades and TQ = total traded quantity. A high ratio means positions are being *built*; a low ratio means positions are being *traded off*
- **IV Rate-of-Change** — how fast Implied Volatility is rising or falling (absolute Δ IV points)
- **Premium Rate-of-Change** — how fast the option price itself is moving (absolute Δ ₹)

### Smart Money Radar

Scans all strikes within ±300 points of spot and flags unusual activity — strikes where large volumes and OI changes appear together in a pattern that suggests institutional positioning rather than retail noise. Classifies each flagged strike as:

- ATM / Near-OTM Call or Put **Writing** (bearish or bullish conviction)
- Far-OTM Call or Put **Buying** (directional speculation or hedging)
- **Shark Absorption** — IV falls while aggressive COI/Volume activity continues (a sign of professional sellers absorbing retail panic)

### Signal Engine

Combines COI/Vol, IV direction, and premium movement into one of four signals per snapshot:

- **Call Short Cover** — call sellers are buying back (bullish squeeze risk)
- **Put Writing** — aggressive put selling (bullish, expecting support to hold)
- **Option Buying** — directional buying pressure building
- **Mixed / Unclear** — conflicting signals, stay cautious

Each signal comes with a **confidence score (0–100%)** based on how strongly all three metrics agree.

### Radar Verdict (Activity Ratio Classification)

Classifies each interval into one of three regimes using `AR = |COI| / volume`:

- **Exchange of Hands** — high volume, low COI change → positions just changing between traders, no conviction
- **High Conviction Writing** — OI building on one side → someone is committing real capital
- **Panic Covering** — sharp OI drop with high volume → forced exits, potential reversal setup

### EOD Positioning Summary ("Who's Actually Positioned What")

Aggregates all snapshots into a strike-by-strike view of net positioning at the end of the day — which strikes have the most call writing, which have put writing, where the "max pain" level sits, and a full regime shift event log showing every time market tone changed intraday.

### Participant Intelligence (FII/DII)

Ingests NSE bhav-copy participant files (`fao_participant_oi_*.csv`) and correlates them with the intraday signal — showing whether FII (foreign institutional) and DII (domestic institutional) positioning *matched* or *contradicted* what the options data was signalling.

### IV Squeeze Detector

Monitors for periods when Implied Volatility compresses across multiple strikes simultaneously — a classic setup that often precedes large directional moves.

### AI Smart Assistant (DeepSeek Powered)

A built-in chat interface that understands the live market data. You can ask:
- "What is the smart money doing in NIFTY right now?"
- "Explain the current IV squeeze at 25000 CE."
- "Summarize today's positioning versus institutional activity."

### Pattern Memory

The system remembers recurring institutional patterns and flags them early based on historical COI/Volume clusters.

### Telegram Bot

Monitors a Telegram channel for trade calls in a structured format (e.g. `BUY #NIFTY 25500 PE 17TH FEB AT 90-100`), auto-tracks SL/targets against live Upstox prices, and posts automatic updates when targets are hit or SL is triggered. Sends a daily P&L summary at 3:15pm IST.

---

## Tech Stack

| Layer | What |
|---|---|
| Frontend | Next.js 15 (App Router), React 19, TypeScript |
| Brokers | Dhan, Upstox, Zerodha, Fyers, AngelOne (Multi-Broker Abstraction) |
| AI | DeepSeek-V3 / R1 for data analysis |
| Auth automation | Python + Playwright headless Chromium |
| Scheduling | cron (Linux VPS) |
| Alerts | Telegram Bot via Telegraf |
| Storage | JSON flat-files (no database needed) |

---

## Prerequisites

- A **Trading Account** with API access (Dhan, Upstox, AngelOne, etc.)
- **Node.js 20+** and **pnpm/npm**
- **Python 3.10+** (only if using automated login brokers)
- A Linux VPS (Ubuntu 22+ recommended) — or just run it locally

---

## Installation

### 1. Clone and install

```bash
git clone https://github.com/your-username/nifty-smart-money-tracker.git
cd nifty-smart-money-tracker
npm install
```

### 2. Configure Broker Credentials

Go to the **Settings** panel in the dashboard to input your API keys and secrets for your preferred broker.

Supported Brokers:
- **Dhan**: Fastest data feed, seamless implementation.
- **Upstox**: Stable, supports automated daily re-login.
- **AngelOne**: Comprehensive data coverage.
- **Fyers / Zerodha**: Integrated but require manual token refresh (legacy).

### 3. Quick Deployment (VPS)

If deploying to a VPS, we've provided a one-shot setup script:

```bash
chmod +x scripts/setup-vps.sh
./scripts/setup-vps.sh
```

### 6. Build and start

```bash
npm run build
npm start
```

Open `http://localhost:3000` in your browser.

---

## Automated Daily Login (VPS / Unattended Mode)

Upstox access tokens expire at midnight. To keep the dashboard running 24/7 without manual logins, set up two cron jobs that re-authenticate each morning before market open:

```bash
crontab -e
```

Add these two lines (in UTC — adjust if your VPS is in a different timezone):

```cron
# 8:55am IST = 3:25am UTC — primary login run
25 3 * * 1-5  cd /opt/nifty && python3 scripts/auto-login.py >> logs/auto-login.log 2>&1

# 9:05am IST = 3:35am UTC — backup run
35 3 * * 1-5  cd /opt/nifty && python3 scripts/auto-login.py >> logs/auto-login.log 2>&1
```

Create the logs directory:
```bash
mkdir -p logs
```

Check logs anytime:
```bash
tail -f logs/auto-login.log
```

---

## Keep the Dashboard Running (pm2)

Use `pm2` to keep the Next.js process alive across reboots:

```bash
npm install -g pm2
pm2 start npm --name "nifty" -- start
pm2 save
pm2 startup
```

---

## Telegram Bot Setup

1. Create a bot via [@BotFather](https://t.me/botfather) on Telegram and copy the token
2. Add to `.env.local`:
   ```env
   TELEGRAM_BOT_TOKEN=your_bot_token
   TELEGRAM_ALLOWED_CHAT_IDS=-100xxxxxxxxxx
   ```
3. Add the bot to your Telegram channel/group as admin with read/post permissions
4. Run the bot worker:
   ```bash
   npm run bot:start
   ```

The bot reads trade calls in this format:
```
BUY #NIFTY 25500 PE 17TH FEB AT 90-100
SL 60
TGT1 130 TGT2 170
```
It then tracks live prices from Upstox and posts automatic updates when targets or SL are hit.

---

## API Endpoints

```
GET /api/live?index=NIFTY&strike=24900&tradeDate=2026-02-11&expiryDate=2026-02-12
GET /api/eod?tradeDate=2026-02-11
```

---

## Configuration Reference

All tunable parameters via `.env.local`:

| Variable | Default | What it controls |
|---|---|---|
| `SAMPLE_FORCE_INTERVAL_MS` | `185000` | Server snapshot capture interval (ms) |
| `COI_RATIO_LOT_SIZE` | `75` | Lot size for COI/Vol calculation (75 = NIFTY, 30 = BANKNIFTY) |
| `MONITOR_STRIKE_RANGE` | `300` | Range in points around spot to scan for smart money activity |
| `SMART_MONEY_ACTIVITY_THRESHOLD` | `4.5` | Minimum COI/Vol power to flag as institutional |
| `FAR_OTM_LOWER_POINTS` | `250` | Lower bound for "far OTM" classification |
| `FAR_OTM_UPPER_POINTS` | `300` | Upper bound for "far OTM" classification |
| `BACKUP_RETENTION_DAYS` | `10` | How many days of JSON backups to keep |
| `ALLOW_MOCK_DATA` | `false` | Use simulated data when Upstox feed fails |

---

## Project Structure

```
├── src/
│   ├── app/
│   │   ├── page.tsx              # Main dashboard UI
│   │   ├── globals.css           # All styles
│   │   └── api/                  # Next.js API routes (live, eod, upstox callback)
│   ├── lib/
│   │   ├── upstox.ts             # Upstox API client and option chain parser
│   │   ├── liveTracker.ts        # Core engine — COI/Vol, IV, snapshot series
│   │   ├── signalEngine.ts       # Bullish/bearish signal classification
│   │   ├── radarEngine.ts        # Smart money activity detector
│   │   ├── vibeEngine.ts         # IV squeeze and sentiment analysis
│   │   ├── radarEngine.ts    # Activity ratio and regime verdicts
│   │   ├── participants.ts       # FII/DII participant intelligence
│   │   ├── legReading.ts         # Human-readable leg interpretation
│   │   └── types.ts              # All TypeScript interfaces
│   ├── components/               # Reusable UI components
│   └── bot/                      # Telegram trade alert bot
├── scripts/
│   ├── auto-login.py             # Automated Upstox daily re-authentication
│   ├── setup-vps.sh              # One-shot VPS setup script
│   └── .env.example              # Environment variable template with comments
└── data/                         # Runtime data (gitignored — never committed)
    ├── runtime/upstox-token.json # Live token file (written by auto-login.py)
    └── backups/                  # Daily JSON backups (YYYY-MM-DD.json)
```

---

## Glossary

**OI (Open Interest)**
The total number of active, unsettled option contracts. Rising OI means new money is entering; falling OI means positions are being closed. Unlike volume, OI is a snapshot of what is *currently held*, making it one of the most reliable signals in derivatives markets.

**COI (Change in Open Interest)**
The difference in OI between two measurement points. Positive COI = new positions being built. Negative COI = positions being squared off. Direction of COI combined with price movement reveals whether the smart money is on the long or short side.

**COI/Volume Ratio**
The centrepiece metric of this dashboard. Formula: `(ΔCOI × lot_size × NT) / TQ`. When high, most of the volume is going toward *building new open positions* — a sign of conviction. When low, the same volume is intraday churn with no lasting positioning intent.

**NT (Number of Trades)**
The count of individual transactions that made up the volume in a given interval. Used in the COI/Vol formula to normalise for trade velocity — a large volume made up of many small trades is different from the same volume in a few large block trades.

**IV (Implied Volatility)**
The market's forward-looking estimate of price movement baked into option premiums, expressed as an annualised percentage. High IV = expensive options, market expects turbulence. Low IV = cheap options, market expects calm. IV expansion during OI builds suggests buyers; IV contraction during OI builds suggests sellers (writers).

**IV Rate-of-Change (IV ROC)**
The absolute change in IV points between snapshots. Tracks whether volatility is being *bought* or *sold* at a specific strike.

**LTP (Last Traded Price)**
The most recent transaction price for a specific option contract.

**Premium ROC**
How fast the option's LTP is changing in absolute rupees per snapshot. Direct measure of money flowing into or out of that contract.

**CE (Call Option / Call)**
Gives the buyer the right to *buy* the index at the strike price. Call *buyers* are bullish. Call *writers* (sellers) are neutral-to-bearish, collecting premium hoping the index stays below the strike at expiry.

**PE (Put Option / Put)**
Gives the buyer the right to *sell* the index at the strike price. Put *buyers* are bearish. Put *writers* (sellers) are neutral-to-bullish, collecting premium hoping the index stays above the strike at expiry.

**ATM (At The Money)**
The strike price closest to where the index is currently trading. ATM options have the highest time value and react most strongly to IV changes.

**OTM (Out of The Money)**
Strikes away from current price — OTM calls are above spot, OTM puts are below spot. Large institutional OI builds in OTM strikes often signal conviction about a major move, or defensive hedging.

**Call Wall / Put Wall**
The strike with the highest cumulative Call OI = Call Wall (acts as resistance — writers defend this level). The strike with the highest Put OI = Put Wall (acts as support — writers defend this level). The index tends to oscillate between these two levels during a range-bound session.

**Max Pain**
The price at which the maximum number of option contracts expire worthless — the level where option buyers collectively suffer the most losses. Expiry prices tend to converge toward max pain, particularly in the final hours of expiry day.

**PCR (Put-Call Ratio)**
Total Put OI ÷ Total Call OI. Above 1 → more puts written than calls (generally bullish, writers expect support to hold). Below 0.7 → more calls written (generally bearish). Extreme PCR readings often precede reversals.

**FII (Foreign Institutional Investors)**
Large overseas funds — hedge funds, pension funds, sovereign wealth funds — participating in Indian markets. Their index derivatives positioning is disclosed daily by NSE and is one of the most watched indicators.

**DII (Domestic Institutional Investors)**
Indian mutual funds, insurance companies, and similar domestic institutions. Often take the opposite side of FII directional bets.

**Smart Money**
Institutional participants whose position sizes are large enough to be visible in OI and volume data, and whose entries/exits tend to precede significant moves. Tracking their footprints — rather than following price — is the core philosophy of this tool.

**TOTP (Time-based One-Time Password)**
A 6-digit code regenerated every 30 seconds from a permanent secret key, used for two-factor authentication. This tool generates it automatically using the `pyotp` library — you only need to store the permanent base32 secret key once.

**Lot Size**
NSE options trade in fixed multiples. NIFTY = 75 contracts per lot. BANKNIFTY = 30 contracts per lot. All OI and volume figures are in lots.

**Exchange of Hands**
A regime where high volume is not creating meaningful new OI — positions are simply transferring between buyers and sellers without a net directional commitment. Often seen in choppy, directionless sessions.

**High Conviction Writing**
A regime where OI is building steadily while volume is proportionate — someone is *adding* to positions, not just trading in and out. The strongest signal for anticipating sustained directional movement.

**Panic Covering**
A regime where OI drops sharply on high volume — existing positions are being force-closed or cut in a hurry. Often marks the tail end of a strong move and can precede reversals.

---

## Limitations and Disclaimers

- This tool is for **informational and research purposes only**. It does not place trades, give buy/sell recommendations, or constitute financial advice.
- Options data from Upstox may have latency that varies during peak market hours. All analysis is based on data available at each capture interval.
- Smart money signals are probabilistic, not deterministic. Large OI builds can represent directional bets, hedges, or spread legs — context matters.
- **Use at your own risk.** Past patterns in options data do not guarantee future market behaviour.

---

## License

MIT — free to use, modify, and distribute. A credit/link back to this repo is appreciated but not required.
