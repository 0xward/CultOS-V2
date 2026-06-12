# CultOS — Memetic Manifestation Engine v2.0

> Cult-as-a-Service on Bitcoin Layer 2 via Stacks Network

CultOS is a production-grade hybrid dApp that deploys sovereign cultural identity vectors onto the Bitcoin consensus layer. Powered by an elitist AI Oracle, sacred geometry SVG sigil generation, and Stacks Network smart contract broadcasting.

---

## 🎨 Aesthetic System

| Variable | Value | Usage |
|---|---|---|
| `void` | `#080512` | Base background |
| `violet` | `#A855F7` | Primary neon accent |
| `mint` | `#22C55E` | Secondary cyber accent |
| `midnight` | `#0D0A1A` | Panel backgrounds |

Ambient lighting: radial violet aurora (top-left) + cyber mint flash (bottom-right) + CSS grid overlay.

---

## 🏗️ Architecture

```
src/
├── App.tsx              # Root hybrid view engine (landing | app)
├── main.tsx             # React 19 entry point
├── index.css            # JetBrains Mono + Tailwind v4 theme
├── lib/
│   └── utils.ts         # cn() utility
├── components/
│   └── ErrorBoundary.tsx
└── services/
    └── oracleService.ts  # AI Oracle → Anthropic API integration
```

### View Routing
```tsx
const [view, setView] = useState<'landing' | 'app'>('landing');
```
State-based view switching with hardware-accelerated `framer-motion` transitions. Zero page reloads.

---

## 🧠 Feature Panels

| Panel | Route | Description |
|---|---|---|
| **Manifestation Chamber** | `chamber` | AI Oracle invocation, SVG sigil display, Stacks deployment |
| **My Codex** | `dashboard` | Personal deployed sub-cult gallery |
| **XP Altar** | `xp` | Global sovereignty leaderboard + $CultOS claim estimator |
| **Ritual Altar** | `ritual` | $CultOS staking tiers, yield multipliers, lock configurations |

---

## 📱 Responsive Layout

**Desktop (≥1024px):** 3-column grid — Sidebar Controller / Manifestation Chamber / Codex Feed  
**Mobile (<1024px):** Single panel view + sticky bottom navigation dock (frosted glass)

---

## 🚀 Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env.local

# 3. Run dev server
npm run dev

# 4. Build for production
npm run build
```

---

## 🔗 Deployment (Vercel)

1. Push to GitLab
2. Connect repo in Vercel dashboard
3. Set environment variables from `.env.example`
4. Deploy — framework auto-detected as Vite

### Required Vercel Environment Variables
```
VITE_FIREBASE_API_KEY
VITE_FIREBASE_PROJECT_ID
VITE_STACKS_NETWORK
VITE_TREASURY_MAINNET
```

---

## 🔮 AI Oracle System — Groq + Llama

The Oracle routes through **Groq Cloud** with a `llama-3.3-70b-versatile` primary and automatic fallback chain:

| Priority | Model | Role |
|---|---|---|
| 1 | `llama-3.3-70b-versatile` | Primary — highest reasoning quality |
| 2 | `llama-3.1-8b-instant` | Fallback tier 1 — fast, rate-limit bypass |
| 3 | `gemma2-9b-it` | Fallback tier 2 — emergency failsafe |

All models are overridable via `.env.local`:
```env
VITE_GROQ_PRIMARY_MODEL=llama-3.3-70b-versatile
VITE_GROQ_FALLBACK_MODEL_1=llama-3.1-8b-instant
VITE_GROQ_FALLBACK_MODEL_2=gemma2-9b-it
```

Oracle behavior:
- Evaluates cultural vector vitality on the Bitcoin consensus layer
- Issues `isBoring: true` + savage intellectual roast for low-effort submissions
- Outputs: `upgradedName`, `ticker`, `lore` (150w manifesto), `viralScore`, `rawSVG` sigil
- SVG sigil uses only `#A855F7` (violet) and `#22C55E` (mint) palette
- `response_format: json_object` enforced on all Groq calls

---

## 🔑 Stacks Integration

- Wallet: `@stacks/connect` — Leather & Xverse compatible
- Network: Stacks Mainnet / Testnet toggle
- Deployment fee: 0.1–0.3 STX (Oracle-determined by viral score)
- Token standard: SIP-010 Clarity contracts

---

## 📜 License

Experimental art protocol. All deployments are cultural artifacts. Not financial advice. Users assume full epistemic sovereignty.

**CultOS © 2026 — Genesis Phase // Oracle Core: Active**

---

## 🔧 Vercel Environment Variables (Required)

```
VITE_GROQ_API_KEY
VITE_GROQ_PRIMARY_MODEL
VITE_GROQ_FALLBACK_MODEL_1
VITE_GROQ_FALLBACK_MODEL_2
VITE_STACKS_NETWORK
VITE_TREASURY_MAINNET
```
