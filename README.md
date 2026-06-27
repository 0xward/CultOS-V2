# CultOS

**Cult-as-a-Service on Bitcoin Layer 2**

CultOS is a dApp built on the Stacks network that lets anyone deploy a sovereign cultural identity vector onto the Bitcoin consensus layer. You give it a concept. The AI Oracle decides if it's worthy. If it passes, it gets inscribed on-chain with a generated sigil, a manifesto, a ticker, and a viral score. If it doesn't pass, it tells you why in the most direct way possible.

Live at: [cult-os.vercel.app](https://cult-os.vercel.app)

---

## What it does

**Manifestation Chamber** — The main interface. Type in a cultural vector (a concept, an idea, a movement, a word), and the Oracle evaluates it. Low-effort submissions get rejected with a roast. Strong submissions get upgraded with a name, a ticker, a 150-word lore manifesto, a viral score, and a hand-generated SVG sigil. From there, you can deploy it to the Stacks mainnet as a permanent on-chain inscription via the `cultos-factory` contract.

**Mission Chamber** — A 75-second arcade game (Sky Strike: Devotion Run) where you pilot an interceptor and collect XP and $CultOS shards mid-flight. After the run, you can claim your rewards directly to your Stacks wallet — the payout hits from the on-chain treasury contract. XP earned here contributes to your leaderboard standing the same way deploy XP does.

**XP Altar** — The Global Sovereignty Leaderboard. Shows cumulative XP per wallet, split between Mission XP (from the game) and Inscription XP (from deployments). The top three positions have distinct visual treatment. Rank titles progress from Neophyte up to Sovereign Oracle.

**Ritual Altar** — $CultOS staking interface with three lock tiers: Neophyte Lock (30 days, 1.2x multiplier), Adept Devotion (90 days, 1.8x), and Sovereign Ritual (180 days, 3.5x). Staking increases your allocation weight in future $CultOS distributions.

**Codex** — Your personal gallery of deployed sub-cults, with viral scores, sigils, and on-chain transaction history.

---

## On-chain contracts

All contracts are live on Stacks mainnet.

| Contract | Address |
|---|---|
| Factory | `SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.cultos-factory` |
| $CultOS Token | `SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.CultOS` |
| Game Rewards | `SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.cultos-game-rewards-v4` |
| Staking | `SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.cultos-staking` |

The game rewards contract holds a $CultOS treasury and pays out directly to player wallets on claim. It runs on Clarity 2, tracks per-wallet game XP on-chain, and enforces a 30-block cooldown between claims with per-session caps (300 XP max, 100 $CultOS max).

---

## Architecture

```
src/
├── App.tsx                  # Root view engine — landing page + all panels
├── main.tsx                 # React 19 entry
├── index.css                # JetBrains Mono, Tailwind v4
├── components/
│   ├── MissionGame.tsx      # Sky Strike game — canvas engine + claim flow
│   └── ErrorBoundary.tsx
└── services/
    ├── firebaseService.ts   # Firestore writes for deployments, leaderboard reads from chain
    └── oracleService.ts     # Groq API calls with fallback model chain

api/
└── oracle.ts                # Vercel serverless function — Groq relay

contracts/
├── cultos-factory.clar      # Token deployment factory
├── cultos-game-rewards.clar # Game rewards (Clarity 2, mainnet live as v4)
└── cultos-staking.clar      # Staking tiers
```

The game engine runs entirely in a canvas element with a custom RAF loop, touch and keyboard controls, and a live HUD synced via ref polling. Pausing (exit confirmation flow) freezes the loop without destroying the engine state, so resuming is instant.

---

## Stack

- React 19, TypeScript, Vite 6, Tailwind v4
- Framer Motion for transitions
- `@stacks/connect` for wallet interactions (Leather and Xverse)
- `@stacks/transactions` for programmatic contract deploys
- Firebase Firestore for deployment writes and off-chain leaderboard data
- Groq Cloud with `llama-3.3-70b-versatile` as primary Oracle model, automatic fallback to `llama-3.1-8b-instant` and `gemma2-9b-it`
- Vercel for hosting + serverless API

---

## Running locally

```bash
npm install
cp .env.example .env.local
# fill in env vars
npm run dev
```

---

## Environment variables

```
GROQ_API_KEY

VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID

VITE_FACTORY_CONTRACT=SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.cultos-factory
VITE_STAKING_CONTRACT=SP2e1425c636440e9d5af1ce92457e31c839393e95.cultos-staking
```

---

## Deploying

Push to GitHub, connect to Vercel, set the env vars above, deploy. Framework auto-detected as Vite. The `api/oracle.ts` serverless function handles Groq calls server-side so the API key stays off the client.

---

## Firestore security rules

The Firestore rules enforce field-level validation on all writes. Deployments are append-only (no updates or deletes), the `deployers` collection validates wallet format and caps totalXP at 1,000,000, and the `game_claims` collection is write-locked for future backend integration.

---

*Experimental art protocol. All deployments are cultural artifacts. Not financial advice.*

**CultOS — Genesis Phase // Oracle Core: Active**
