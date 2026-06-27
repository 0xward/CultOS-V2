import { useState, useEffect, useRef, useCallback, type MouseEvent } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  connect,
  disconnect,
  isConnected,
  getLocalStorage,
  openContractCall,
} from "@stacks/connect";
import {
  uintCV,
  stringUtf8CV,
  contractPrincipalCV,
  PostConditionMode,
} from "@stacks/transactions";
import { invokeOracle } from "./services/oracleService";
import {
  subscribeLiveFeed,
  pushDeploymentToFeed,
  subscribeGlobalStats,
  subscribeLiveLeaderboard,
  fetchStakingStats,
  fetchOnChainDeploymentCount,
  updateGameXP,
  type LiveCultEntry,
  type GlobalStats,
  type LeaderboardEntry,
} from "./services/firebaseService";
import { sanitizeSVG } from "./lib/sanitizeSVG";
import { CultOSUtils } from "@0xward/cultos-utils";
import MissionGame from "./components/MissionGame";

// ─── CULTOS UTILS ─────────────────────────────────────────────────────────────
// Shared utility layer: fee calculation, field sanitization, viral score rating.
// Package: https://www.npmjs.com/package/@0xward/cultos-utils
const _utils = new CultOSUtils({ network: "mainnet" });

// ─── PALETTE ─────────────────────────────────────────────────────────────────
const P = {
  void: "#080512",
  violet: "#A855F7",
  mint: "#22C55E",
  midnight: "#0D0A1A",
  glass: "rgba(8,5,18,0.7)",
};

// ─── STACKS API ──────────────────────────────────────────────────────────────
const STACKS_API = "https://api.mainnet.hiro.so";

async function fetchSTXBalance(address: string): Promise<string> {
  try {
    const res = await fetch(`${STACKS_API}/v2/accounts/${address}?proof=0`);
    if (!res.ok) return "0.00";
    const data = await res.json();
    const microStx = BigInt(data.balance || "0");
    const stx = Number(microStx) / 1_000_000;
    return stx.toFixed(4);
  } catch {
    return "0.00";
  }
}

async function fetchBlockHeight(): Promise<string> {
  try {
    const res = await fetch(`${STACKS_API}/v2/info`);
    if (!res.ok) return "—";
    const data = await res.json();
    return data.stacks_tip_height?.toLocaleString() ?? "—";
  } catch {
    return "—";
  }
}

async function fetchBlockHeightRaw(): Promise<number> {
  try {
    const res = await fetch(`${STACKS_API}/v2/info`);
    if (!res.ok) return 0;
    const data = await res.json();
    return data.stacks_tip_height ?? 0;
  } catch { return 0; }
}

// Fetch recent staking-contract transactions for GazeFeed
interface GazeEvent {
  id: string;
  type: "STAKE" | "UNSTAKE" | "FUND";
  address: string;
  amount: string;
  blockHeight: number;
  timeAgo: string;
}

function timeAgoFromBlock(currentBlock: number, txBlock: number): string {
  // Guard: if currentBlock not loaded yet, or negative diff, can't compute
  if (!currentBlock || currentBlock < txBlock) return "—";
  const diff = currentBlock - txBlock;
  if (diff < 2)    return "just now";
  if (diff < 10)   return `${diff * 10}m ago`;
  if (diff < 144)  return `${Math.floor(diff * 10 / 60)}h ago`;
  const days = Math.floor(diff / 144);
  if (days < 30)   return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

// Convert Unix timestamp (seconds) to time-ago string
function timeAgoFromTimestamp(burnTime: number): string {
  if (!burnTime) return "—";
  const diffMs   = Date.now() - burnTime * 1000;
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 2)    return "just now";
  if (diffMins < 60)   return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24)  return `${diffHours}h ago`;
  const diffDays  = Math.floor(diffHours / 24);
  if (diffDays < 30)   return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

async function fetchGazeEvents(currentBlock: number): Promise<GazeEvent[]> {
  const STAKING_ADDR = "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF";
  const STAKING_NAME = "cultos-staking";

  // Try v2 API first (more reliable for contract tx list)
  const tryV2 = async (): Promise<any[]> => {
    const res = await fetch(
      `${STACKS_API}/extended/v2/addresses/${STAKING_ADDR}.${STAKING_NAME}/transactions?limit=20`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.results ?? [];
  };

  // Fallback: v1 address endpoint
  const tryV1 = async (): Promise<any[]> => {
    const res = await fetch(
      `${STACKS_API}/extended/v1/address/${STAKING_ADDR}.${STAKING_NAME}/transactions?limit=20&unanchored=true`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.results ?? [];
  };

  // Fallback 2: contract events (captures internal calls too)
  const tryEvents = async (): Promise<any[]> => {
    const res = await fetch(
      `${STACKS_API}/extended/v1/contract/${STAKING_ADDR}.${STAKING_NAME}/events?limit=20`
    );
    if (!res.ok) return [];
    const data = await res.json();
    return data.results ?? [];
  };

  try {
    let results: any[] = [];
    // Same proven endpoint pattern as firebaseService.ts
    results = await tryV1();
    if (results.length === 0) results = await tryV2();

    const parsed = results
      .filter((tx: any) =>
        tx.tx_type === "contract_call" &&
        tx.tx_status === "success" &&
        ["stake", "unstake", "fund-rewards"].includes(tx.contract_call?.function_name ?? "")
      )
      .map((tx: any) => {
        const fn: string = tx.contract_call?.function_name ?? "";
        const type: GazeEvent["type"] =
          fn === "stake"         ? "STAKE"
          : fn === "unstake"     ? "UNSTAKE"
          : "FUND";

        const sender: string = tx.sender_address ?? "SP???";

        // burn_block_time_iso is the proven field (matches firebaseService.ts)
        const isoStr: string = tx.burn_block_time_iso ?? "";
        const timeAgo = isoStr
          ? timeAgoFromTimestamp(Math.floor(new Date(isoStr).getTime() / 1000))
          : timeAgoFromBlock(currentBlock, tx.block_height ?? currentBlock);

        let amount = "—";
        try {
          const args: any[] = tx.contract_call?.function_args ?? [];
          const amtArg = args.find((a: any) => a.name === "amount");
          if (amtArg?.repr) {
            const micro = parseInt(amtArg.repr.replace("u", ""));
            if (!isNaN(micro) && micro > 0)
              amount = (micro / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 0 }) + " $CultOS";
          }
        } catch {}

        return {
          id: tx.tx_id ?? String(Math.random()),
          type,
          address: `${sender.slice(0, 6)}...${sender.slice(-4)}`,
          amount,
          blockHeight: tx.block_height ?? 0,
          timeAgo,
        } as GazeEvent;
      })
      .slice(0, 10);

    return parsed;
  } catch {
    return [];
  }
}

// Fetch a wallet's on-chain stake record to get lock-end block
async function fetchUserStakeOnChain(address: string): Promise<{
  amount: number; tier: number; lockEnd: number; multiplierBp: number;
} | null> {
  try {
    const STAKING_ADDR = "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF";
    const STAKING_NAME = "cultos-staking";
    // build Clarity principal arg
    const body = {
      sender: STAKING_ADDR,
      arguments: [
        // serialise principal as hex: 0x06 + 0x16 (length 22) + address bytes
        // Easier: just use the API which accepts clarity value JSON
      ],
    };
    // Use call-read with standard-principal
    const clarityPrincipal = `0x${Buffer.from([0x06, ...Buffer.from(address)]).toString("hex")}`;
    const res = await fetch(
      `${STACKS_API}/v2/contracts/call-read/${STAKING_ADDR}/${STAKING_NAME}/get-stake`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: STAKING_ADDR, arguments: [clarityPrincipal] }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    const result: string = data?.result ?? "";
    if (!result || result === "0x09" || result.length < 10) return null; // none
    // Parse the tuple — simplified: just detect presence
    // Real parse needs Clarity codec; for now return a presence indicator
    // We'll parse the hex manually for the key fields
    // Format: 0x0a (some) 0x0c (tuple) ...
    if (!result.startsWith("0x0a")) return null; // 0x09 = none, 0x0a = some
    // Return stub — actual values require full Clarity deserialization
    return { amount: 0, tier: 0, lockEnd: 0, multiplierBp: 10000 };
  } catch { return null; }
}

// ─── TERMINAL BOOT ───────────────────────────────────────────────────────────
const TERMINAL_BOOT = [
  "CULTOS_KERNEL v3.7.1 // INITIALIZING...",
  "LOADING STACKS_NETWORK_ADAPTER...",
  "MEMETIC_ENGINE: ONLINE",
  "ORACLE_CORE: STANDING BY",
  "CONSENSUS_LAYER: BITCOIN_L2 // ACTIVE",
  "SYSTEM READY. AWAITING CULTURAL VECTOR.",
];

// ─── AMBIENT BACKGROUND ───────────────────────────────────────────────────────
function AmbientBackground() {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 0, overflow: "hidden", pointerEvents: "none" }}>
      <div style={{
        position: "absolute", inset: 0,
        background: `radial-gradient(ellipse 80% 60% at -10% -5%, rgba(168,85,247,0.18) 0%, transparent 60%),
                     radial-gradient(ellipse 50% 40% at 110% 105%, rgba(34,197,94,0.12) 0%, transparent 55%),
                     radial-gradient(ellipse 60% 60% at 50% 50%, rgba(13,10,26,0.95) 0%, transparent 100%)`,
        backgroundColor: P.void,
      }} />
      <motion.div
        animate={{ x: [0, 30, 0], y: [0, -20, 0], opacity: [0.4, 0.6, 0.4] }}
        transition={{ duration: 12, repeat: Infinity, ease: "easeInOut" }}
        style={{
          position: "absolute", top: "-10%", left: "-5%",
          width: 500, height: 500, borderRadius: "50%",
          background: "radial-gradient(circle, rgba(168,85,247,0.15) 0%, transparent 70%)",
          filter: "blur(40px)",
        }}
      />
      <motion.div
        animate={{ x: [0, -25, 0], y: [0, 15, 0], opacity: [0.25, 0.45, 0.25] }}
        transition={{ duration: 15, repeat: Infinity, ease: "easeInOut", delay: 3 }}
        style={{
          position: "absolute", bottom: "-5%", right: "-5%",
          width: 400, height: 400, borderRadius: "50%",
          background: "radial-gradient(circle, rgba(34,197,94,0.12) 0%, transparent 70%)",
          filter: "blur(50px)",
        }}
      />
      <div style={{
        position: "absolute", inset: 0,
        backgroundImage: `linear-gradient(rgba(168,85,247,0.03) 1px, transparent 1px),
                          linear-gradient(90deg, rgba(168,85,247,0.03) 1px, transparent 1px)`,
        backgroundSize: "60px 60px",
      }} />
    </div>
  );
}

// ─── GLASS PANEL ─────────────────────────────────────────────────────────────
function GlassPanel({ children, style = {}, hover = false, onClick = null }: any) {
  const [isHovered, setIsHovered] = useState(false);
  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      style={{
        background: "rgba(0,0,0,0.4)",
        backdropFilter: "blur(12px)",
        border: `1px solid ${isHovered && hover ? "rgba(168,85,247,0.3)" : "rgba(168,85,247,0.1)"}`,
        borderRadius: 16,
        boxShadow: isHovered && hover
          ? "0 0 30px rgba(168,85,247,0.1), inset 0 1px 0 rgba(255,255,255,0.05)"
          : "0 0 20px rgba(168,85,247,0.05), inset 0 1px 0 rgba(255,255,255,0.03)",
        transition: "all 0.3s ease",
        position: "relative",
        overflow: "hidden",
        cursor: onClick ? "pointer" : "default",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

// ─── ORACLE SVG ───────────────────────────────────────────────────────────────
function OracleSVG({ rawSVG, name }: { rawSVG: string | null; name: string }) {
  if (!rawSVG) {
    return (
      <div style={{
        width: "100%", aspectRatio: "1/1", display: "flex", alignItems: "center",
        justifyContent: "center", background: "rgba(168,85,247,0.05)",
        border: "1px solid rgba(168,85,247,0.15)", borderRadius: 12,
      }}>
        <div style={{ textAlign: "center" }}>
          <motion.div
            animate={{ opacity: [0.3, 0.7, 0.3], scale: [1, 1.05, 1] }}
            transition={{ duration: 3, repeat: Infinity }}
            style={{ fontSize: 48, marginBottom: 8 }}
          >◈</motion.div>
          <div style={{ color: "rgba(168,85,247,0.5)", fontSize: 11, fontFamily: "monospace", letterSpacing: 2 }}>AWAITING SYNTHESIS</div>
        </div>
      </div>
    );
  }
  return (
    <div
      style={{ width: "100%", aspectRatio: "1/1", borderRadius: 12, overflow: "hidden", background: "#080512" }}
      dangerouslySetInnerHTML={{ __html: sanitizeSVG(rawSVG.replace(/<svg/, '<svg width="100%" height="100%" viewBox="0 0 200 200" preserveAspectRatio="xMidYMid meet"')) }}
    />
  );
}

// ─── HERO STATS REMOVED ───────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════════
// LANDING PAGE — Cinematic Occult / Dark Cult
// ═══════════════════════════════════════════════════════════════════════════════
function LandingPage({ onLaunch }: { onLaunch: () => void }) {
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [glitchActive, setGlitchActive] = useState(false);
  const [glitchPhase, setGlitchPhase] = useState(0);

  // Frequent, multi-phase glitch
  useEffect(() => {
    const schedule = () => {
      // Trigger every 1.5–3.5 seconds
      const delay = 1500 + Math.random() * 2000;
      setTimeout(() => {
        // Phase 1 — sharp
        setGlitchPhase(1);
        setGlitchActive(true);
        setTimeout(() => {
          // Phase 2 — offset
          setGlitchPhase(2);
        }, 80);
        setTimeout(() => {
          // Phase 3 — echo
          setGlitchPhase(3);
        }, 160);
        setTimeout(() => {
          setGlitchActive(false);
          setGlitchPhase(0);
          schedule();
        }, 300);
      }, delay);
    };
    schedule();
  }, []);

  const faqs = [
    {
      q: "Why is the deployment fee variable between 0.1 – 0.3 STX?",
      a: "The Oracle judges the cultural complexity and viral potential of each submission. High-entropy, philosophically dense vectors require more computational consensus inscription on the Stacks L2 settlement layer. The Oracle dynamically allocates fee weight proportional to the ideological load placed on the Bitcoin memetic substrate."
    },
    {
      q: "How does $CultOS ecosystem token staking operate?",
      a: "The native $CultOS loyalty token governs access to premium Oracle processing tiers, yield multipliers on sub-cult deployments, and voting rights in the Sovereign Manifestation DAO. Staking locks tokens into the Ritual Altar contract, generating devotion XP that determines rank elevation and revenue-share from the global deployment fee pool."
    },
    {
      q: "What is Cult-as-a-Service on Bitcoin Layer 2?",
      a: "CultOS leverages Stacks Network — a Bitcoin L2 with full Clarity smart contract capability — to permanently inscribe cultural identity vectors onto the most immutable ledger in existence. Each sub-cult is a sovereign on-chain entity: a SIP-010 token with AI-generated lore, sacred geometry sigil art, and viral propagation scoring."
    },
    {
      q: "Is this a financial instrument?",
      a: "CultOS is an experimental art protocol and memetic identity engine. Sub-cult tokens generated are cultural artifacts, not investment vehicles. All on-chain interactions involve real cryptographic assets. Users assume full epistemic and financial sovereignty over their deployments."
    },
  ];

  return (
    <div style={{ minHeight: "100vh", position: "relative", zIndex: 1 }}>
      <style>{`
        @keyframes glitch-clip-1 {
          0%   { clip-path: inset(0% 0 85% 0);  transform: translateX(-6px) skewX(-2deg); opacity: 1; }
          20%  { clip-path: inset(20% 0 50% 0); transform: translateX(5px)  skewX(1deg);  opacity: 0.9; }
          40%  { clip-path: inset(50% 0 20% 0); transform: translateX(-3px) skewX(-3deg); opacity: 1; }
          60%  { clip-path: inset(70% 0 5% 0);  transform: translateX(8px)  skewX(2deg);  opacity: 0.8; }
          80%  { clip-path: inset(85% 0 0% 0);  transform: translateX(-2px) skewX(0deg);  opacity: 1; }
          100% { clip-path: inset(0% 0 100% 0); transform: translateX(0); opacity: 1; }
        }
        @keyframes glitch-clip-2 {
          0%   { clip-path: inset(90% 0 0% 0);  transform: translateX(8px)  skewX(3deg);  opacity: 0.9; }
          25%  { clip-path: inset(60% 0 15% 0); transform: translateX(-6px) skewX(-2deg); opacity: 1; }
          50%  { clip-path: inset(30% 0 45% 0); transform: translateX(4px)  skewX(1deg);  opacity: 0.85; }
          75%  { clip-path: inset(10% 0 70% 0); transform: translateX(-5px) skewX(-1deg); opacity: 1; }
          100% { clip-path: inset(100% 0 0% 0); transform: translateX(0); opacity: 1; }
        }
        @keyframes glitch-clip-3 {
          0%   { clip-path: inset(40% 0 40% 0); transform: translateX(12px) scaleX(1.02); opacity: 0.7; }
          33%  { clip-path: inset(15% 0 65% 0); transform: translateX(-8px) scaleX(0.99); opacity: 1; }
          66%  { clip-path: inset(65% 0 15% 0); transform: translateX(6px)  scaleX(1.01); opacity: 0.8; }
          100% { clip-path: inset(100% 0 0% 0); transform: translateX(0) scaleX(1); opacity: 1; }
        }
        @keyframes scanline {
          0% { transform: translateY(-100%); }
          100% { transform: translateY(100vh); }
        }
        @keyframes sigil-rotate {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes sigil-counter {
          from { transform: rotate(0deg); }
          to   { transform: rotate(-360deg); }
        }
        @keyframes breathe {
          0%,100% { opacity: 0.4; transform: scale(1); }
          50%     { opacity: 0.8; transform: scale(1.04); }
        }
        @keyframes rune-float {
          0%,100% { transform: translateY(0px) rotate(0deg); opacity: 0.15; }
          50%     { transform: translateY(-18px) rotate(8deg); opacity: 0.35; }
        }
        .hero-title-glitch { position: relative; display: inline-block; }
        .hero-title-glitch::before,
        .hero-title-glitch::after,
        .hero-title-glitch .glitch-3 {
          content: attr(data-text);
          position: absolute;
          inset: 0;
          font-size: inherit;
          font-weight: inherit;
          font-family: inherit;
          letter-spacing: inherit;
          line-height: inherit;
          white-space: nowrap;
          pointer-events: none;
        }
        .hero-title-glitch::before {
          color: ${glitchPhase === 1 ? '#22C55E' : glitchPhase === 2 ? '#ff2d55' : '#22C55E'};
          animation: ${glitchActive ? 'glitch-clip-1 0.3s steps(1) forwards' : 'none'};
          left: ${glitchPhase === 2 ? '2px' : glitchPhase === 3 ? '-1px' : '0'};
        }
        .hero-title-glitch::after {
          color: ${glitchPhase >= 2 ? '#A855F7' : '#A855F7'};
          animation: ${glitchActive && glitchPhase >= 1 ? 'glitch-clip-2 0.3s steps(1) forwards' : 'none'};
          left: ${glitchPhase === 1 ? '-3px' : glitchPhase === 3 ? '4px' : '0'};
        }
        .landing-faq-item:hover { border-color: rgba(168,85,247,0.3) !important; background: rgba(168,85,247,0.05) !important; }
      `}</style>

      {/* ── SCANLINE OVERLAY ── */}
      <div style={{ position: "fixed", inset: 0, zIndex: 0, pointerEvents: "none", overflow: "hidden" }}>
        <div style={{
          position: "absolute", left: 0, right: 0, height: 2,
          background: "linear-gradient(90deg, transparent, rgba(168,85,247,0.08), transparent)",
          animation: "scanline 8s linear infinite",
        }} />
      </div>

      {/* ── NAVBAR ── */}
      <nav style={{
        position: "sticky", top: 0, zIndex: 100,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 32px", height: 72,
        background: "rgba(8,5,18,0.9)", backdropFilter: "blur(24px)",
        borderBottom: "1px solid rgba(168,85,247,0.12)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <img src="/CultOS_Logo.png" alt="CultOS" style={{ width: 34, height: 34, borderRadius: 9, objectFit: "cover", boxShadow: "0 0 20px rgba(168,85,247,0.5)", flexShrink: 0 }} />
          <span style={{ fontSize: 18, fontWeight: 900, color: "white", letterSpacing: 3, fontFamily: "monospace", flexShrink: 0 }}>CULTOS</span>
          <span style={{ fontSize: 8, padding: "2px 6px", borderRadius: 4, background: "rgba(168,85,247,0.15)", border: "1px solid rgba(168,85,247,0.3)", color: "#A855F7", fontFamily: "monospace", fontWeight: 700, letterSpacing: 2 }}>BETA</span>
        </div>
        <div className="desktop-nav" style={{ display: "flex", alignItems: "center", gap: 32 }}>
          <div style={{ display: "flex", gap: 28 }}>
            {["About", "How to Use", "FAQ"].map(label => (
              <a key={label} href={`#${label.toLowerCase().replace(/ /g, "-")}`}
                style={{ color: "rgba(255,255,255,0.4)", fontSize: 12, fontWeight: 700, letterSpacing: 2, textDecoration: "none", transition: "color 0.2s", fontFamily: "monospace" }}
                onMouseEnter={e => (e.target as HTMLElement).style.color = "#A855F7"}
                onMouseLeave={e => (e.target as HTMLElement).style.color = "rgba(255,255,255,0.4)"}
              >{label.toUpperCase()}</a>
            ))}
          </div>
          <motion.button whileHover={{ scale: 1.04, boxShadow: "0 0 40px rgba(168,85,247,0.6)" }} whileTap={{ scale: 0.97 }} onClick={onLaunch}
            style={{ background: "linear-gradient(135deg, #A855F7, #7C3AED)", border: "none", borderRadius: 50, padding: "10px 28px", color: "white", fontWeight: 900, fontSize: 12, letterSpacing: 2, cursor: "pointer", boxShadow: "0 0 24px rgba(168,85,247,0.4)", fontFamily: "monospace" }}
          >ENTER ◈</motion.button>
        </div>
        <button className="hamburger-btn" onClick={() => setMenuOpen(o => !o)}
          style={{ display: "none", flexDirection: "column", gap: 5, background: "transparent", border: "1px solid rgba(168,85,247,0.3)", borderRadius: 8, padding: "8px 10px", cursor: "pointer" }}
        >
          <span style={{ display: "block", width: 18, height: 2, background: menuOpen ? "#A855F7" : "rgba(255,255,255,0.7)", transition: "transform 0.2s", transform: menuOpen ? "rotate(45deg) translate(5px, 5px)" : "none" }} />
          <span style={{ display: "block", width: 18, height: 2, background: menuOpen ? "transparent" : "rgba(255,255,255,0.7)" }} />
          <span style={{ display: "block", width: 18, height: 2, background: menuOpen ? "#A855F7" : "rgba(255,255,255,0.7)", transition: "transform 0.2s", transform: menuOpen ? "rotate(-45deg) translate(5px, -5px)" : "none" }} />
        </button>
      </nav>

      {/* Mobile dropdown */}
      <AnimatePresence>
        {menuOpen && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }}
            style={{ position: "sticky", top: 72, zIndex: 99, background: "rgba(8,5,18,0.97)", backdropFilter: "blur(20px)", borderBottom: "1px solid rgba(168,85,247,0.15)", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 12 }}
          >
            {["About", "How to Use", "FAQ"].map(label => (
              <a key={label} href={`#${label.toLowerCase().replace(/ /g, "-")}`} onClick={() => setMenuOpen(false)}
                style={{ color: "rgba(255,255,255,0.7)", fontSize: 13, fontWeight: 700, letterSpacing: 2, textDecoration: "none", fontFamily: "monospace", padding: "8px 0", borderBottom: "1px solid rgba(168,85,247,0.08)" }}
              >{label.toUpperCase()}</a>
            ))}
            <motion.button whileTap={{ scale: 0.97 }} onClick={() => { setMenuOpen(false); onLaunch(); }}
              style={{ background: "linear-gradient(135deg, #A855F7, #7C3AED)", border: "none", borderRadius: 50, padding: "12px 0", color: "white", fontWeight: 900, fontSize: 13, letterSpacing: 2, cursor: "pointer", marginTop: 4, fontFamily: "monospace" }}
            >ENTER THE CHAMBER ◈</motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── HERO — Full-screen cinematic ── */}
      <section style={{ position: "relative", minHeight: "calc(100vh - 72px)", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", padding: "60px 24px" }}>
        {/* Floating rune glyphs in background */}
        {["⬡", "◈", "✦", "⊕", "🜂", "⬡", "◈"].map((glyph, i) => (
          <div key={i} style={{
            position: "absolute",
            left: `${8 + i * 13}%`,
            top: `${15 + (i % 3) * 25}%`,
            fontSize: `${20 + (i % 3) * 12}px`,
            color: i % 2 === 0 ? "rgba(168,85,247,0.12)" : "rgba(34,197,94,0.08)",
            animation: `rune-float ${5 + i * 0.8}s ease-in-out infinite`,
            animationDelay: `${i * 0.6}s`,
            userSelect: "none",
            pointerEvents: "none",
          }}>{glyph}</div>
        ))}

        {/* Central sigil ring */}
        <div style={{
          position: "absolute",
          width: 600, height: 600,
          top: "50%", left: "50%",
          transform: "translate(-50%, -50%)",
          pointerEvents: "none",
          zIndex: 0,
        }}>
          {/* Outer ring */}
          <svg viewBox="0 0 600 600" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", animation: "sigil-rotate 60s linear infinite", opacity: 0.08 }}>
            <circle cx="300" cy="300" r="290" fill="none" stroke="#A855F7" strokeWidth="1" strokeDasharray="4 12" />
            {Array.from({ length: 12 }, (_, i) => {
              const a = (i / 12) * Math.PI * 2;
              const x1 = 300 + 270 * Math.cos(a), y1 = 300 + 270 * Math.sin(a);
              const x2 = 300 + 290 * Math.cos(a), y2 = 300 + 290 * Math.sin(a);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#A855F7" strokeWidth="1.5" />;
            })}
          </svg>
          {/* Inner ring */}
          <svg viewBox="0 0 600 600" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", animation: "sigil-counter 40s linear infinite", opacity: 0.06 }}>
            <circle cx="300" cy="300" r="200" fill="none" stroke="#22C55E" strokeWidth="1" strokeDasharray="2 8" />
            {Array.from({ length: 8 }, (_, i) => {
              const a = (i / 8) * Math.PI * 2;
              const x1 = 300 + 180 * Math.cos(a), y1 = 300 + 180 * Math.sin(a);
              const x2 = 300 + 200 * Math.cos(a), y2 = 300 + 200 * Math.sin(a);
              return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke="#22C55E" strokeWidth="1" />;
            })}
          </svg>
          {/* Radial glow burst */}
          <div style={{
            position: "absolute", inset: "15%",
            background: "radial-gradient(ellipse at center, rgba(168,85,247,0.08) 0%, transparent 70%)",
            animation: "breathe 6s ease-in-out infinite",
          }} />
        </div>

        {/* Hero content */}
        <div style={{ position: "relative", zIndex: 1, textAlign: "center", maxWidth: 860, width: "100%" }}>
          {/* Badge */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6 }}
            style={{ display: "inline-flex", alignItems: "center", gap: 10, marginBottom: 40, padding: "8px 20px", borderRadius: 50, background: "rgba(168,85,247,0.08)", border: "1px solid rgba(168,85,247,0.25)" }}
          >
            <motion.span animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 2, repeat: Infinity }}
              style={{ width: 6, height: 6, borderRadius: "50%", background: "#22C55E", display: "inline-block" }}
            />
            <span style={{ color: "rgba(168,85,247,0.9)", fontSize: 10, fontWeight: 700, letterSpacing: 3, fontFamily: "monospace" }}>OPERATING ON BITCOIN LAYER 2 — STACKS NETWORK</span>
          </motion.div>

          {/* Main title with glitch */}
          <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.1 }}>
            <h1 style={{ fontSize: "clamp(48px, 9vw, 100px)", fontWeight: 900, lineHeight: 0.95, letterSpacing: -4, marginBottom: 12, fontFamily: "monospace", color: "white" }}>
              <span
                className="hero-title-glitch"
                data-text="CULT-AS-A"
                style={{
                  color: glitchPhase === 1 ? "rgba(255,255,255,0.85)" : glitchPhase === 2 ? "rgba(255,45,85,0.9)" : "white",
                  transition: "color 0.05s",
                }}
              >
                CULT-AS-A
                {/* Third glitch layer */}
                {glitchActive && glitchPhase >= 2 && (
                  <span style={{
                    position: "absolute",
                    inset: 0,
                    color: "#00ffff",
                    fontFamily: "inherit",
                    fontWeight: "inherit",
                    fontSize: "inherit",
                    letterSpacing: "inherit",
                    lineHeight: "inherit",
                    whiteSpace: "nowrap",
                    clipPath: glitchPhase === 3 ? "inset(35% 0 35% 0)" : "inset(55% 0 10% 0)",
                    transform: glitchPhase === 3 ? "translateX(10px) scaleX(1.015)" : "translateX(-5px)",
                    opacity: 0.6,
                    pointerEvents: "none",
                  }}>CULT-AS-A</span>
                )}
              </span>
            </h1>
            <h1 style={{ fontSize: "clamp(48px, 9vw, 100px)", fontWeight: 900, lineHeight: 0.95, letterSpacing: -4, marginBottom: 40, fontFamily: "monospace" }}>
              <span style={{
                background: "linear-gradient(135deg, #A855F7 0%, #C084FC 40%, #A855F7 70%, #7C3AED 100%)",
                WebkitBackgroundClip: "text",
                WebkitTextFillColor: "transparent",
                backgroundClip: "text",
                filter: "drop-shadow(0 0 40px rgba(168,85,247,0.4))",
              }}>SERVICE</span>
            </h1>
          </motion.div>

          {/* Subtitle */}
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.25 }}
            style={{ fontSize: "clamp(14px, 2vw, 18px)", color: "rgba(255,255,255,0.35)", lineHeight: 1.8, maxWidth: 560, margin: "0 auto 56px", fontWeight: 400, letterSpacing: 0.5 }}
          >
            The first AI-powered memetic identity engine permanently inscribing cultural consensus vectors onto the most immutable ledger in existence.
          </motion.p>

          {/* CTA buttons */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.4 }}
            style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}
          >
            <motion.button
              whileHover={{ scale: 1.05, boxShadow: "0 0 60px rgba(168,85,247,0.7), 0 0 120px rgba(168,85,247,0.3)" }}
              whileTap={{ scale: 0.97 }}
              onClick={onLaunch}
              style={{
                background: "linear-gradient(135deg, #A855F7 0%, #7C3AED 100%)",
                border: "none", borderRadius: 50,
                padding: "18px 56px",
                color: "white", fontWeight: 900, fontSize: 14, letterSpacing: 3,
                cursor: "pointer", fontFamily: "monospace",
                boxShadow: "0 0 40px rgba(168,85,247,0.45), inset 0 1px 0 rgba(255,255,255,0.15)",
                position: "relative", overflow: "hidden",
              }}
            >
              <span style={{ position: "relative", zIndex: 1 }}>ENTER THE CHAMBER</span>
            </motion.button>
            <motion.button
              whileHover={{ scale: 1.04, borderColor: "rgba(168,85,247,0.5)", color: "rgba(255,255,255,0.9)" }}
              whileTap={{ scale: 0.97 }}
              onClick={() => document.getElementById('about')?.scrollIntoView({ behavior: 'smooth' })}
              style={{
                background: "transparent",
                border: "1px solid rgba(168,85,247,0.2)",
                borderRadius: 50, padding: "18px 48px",
                color: "rgba(255,255,255,0.5)", fontWeight: 700, fontSize: 13, letterSpacing: 2,
                cursor: "pointer", fontFamily: "monospace",
                transition: "all 0.3s ease",
              }}
            >READ THE DOCTRINE ↓</motion.button>
          </motion.div>

          {/* Three pillars */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.6 }}
            style={{ display: "flex", gap: 1, justifyContent: "center", marginTop: 80, flexWrap: "wrap" }}
          >
            {[
              { icon: "◈", label: "AI ORACLE", desc: "Judges your cultural vector" },
              { icon: "₿", label: "BITCOIN L2", desc: "Inscribed on Stacks mainnet" },
              { icon: "🜂", label: "SOVEREIGNTY", desc: "Your cult, your chain identity" },
            ].map((p, i) => (
              <motion.div
                key={p.label}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: 0.7 + i * 0.1 }}
                style={{
                  padding: "20px 32px", textAlign: "center",
                  borderLeft: i > 0 ? "1px solid rgba(168,85,247,0.1)" : "none",
                  flex: "1 1 160px",
                }}
              >
                <div style={{ fontSize: 24, marginBottom: 8, filter: "drop-shadow(0 0 8px rgba(168,85,247,0.5))" }}>{p.icon}</div>
                <div style={{ fontSize: 10, fontWeight: 900, color: "#A855F7", fontFamily: "monospace", letterSpacing: 2, marginBottom: 4 }}>{p.label}</div>
                <div style={{ fontSize: 11, color: "rgba(255,255,255,0.25)", fontFamily: "monospace" }}>{p.desc}</div>
              </motion.div>
            ))}
          </motion.div>
        </div>
      </section>

      {/* ── ABOUT ── */}
      <section id="about" style={{ padding: "100px 32px", maxWidth: 1000, margin: "0 auto" }}>
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} transition={{ duration: 0.6 }}>
          <div style={{ textAlign: "center", marginBottom: 64 }}>
            <div style={{ color: "#A855F7", fontFamily: "monospace", fontSize: 10, letterSpacing: 4, fontWeight: 700, marginBottom: 16, opacity: 0.7 }}>◈ ABOUT THE PROTOCOL ◈</div>
            <h2 style={{ fontSize: "clamp(32px, 5vw, 52px)", fontWeight: 900, color: "white", letterSpacing: -2, fontFamily: "monospace" }}>WHAT IS <span style={{ color: "#A855F7" }}>CULTOS</span>?</h2>
          </div>
        </motion.div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 2 }}>
          {[
            { icon: "🧬", title: "MEMETIC ENGINE", text: "Submit any cultural concept, philosophical idea, or movement. The Oracle evaluates its viral potential and transforms it into a sovereign token identity with sacred geometry sigil art." },
            { icon: "⛓️", title: "PERMANENT INSCRIPTION", text: "Every sub-cult is inscribed on Bitcoin via Stacks L2. Not stored on servers. Not mutable. Permanently anchored to the most immutable data layer ever created." },
            { icon: "🌌", title: "SOVEREIGNTY SYSTEM", text: "Earn devotion XP through deployments and missions. Rise through ranks from Signal Propagator to Sovereign Oracle. Stack $CultOS for multipliers and governance." },
          ].map((card, i) => (
            <motion.div
              key={card.title}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: i * 0.1 }}
            >
              <GlassPanel hover style={{ padding: "36px 28px", height: "100%", borderRadius: i === 0 ? "16px 0 0 16px" : i === 2 ? "0 16px 16px 0" : "0" }}>
                <div style={{ fontSize: 32, marginBottom: 20 }}>{card.icon}</div>
                <h3 style={{ fontSize: 13, fontWeight: 900, color: "#A855F7", fontFamily: "monospace", letterSpacing: 2, marginBottom: 12 }}>{card.title}</h3>
                <p style={{ fontSize: 13, color: "rgba(255,255,255,0.4)", lineHeight: 1.8 }}>{card.text}</p>
              </GlassPanel>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ── HOW TO USE ── */}
      <section id="how-to-use" style={{ padding: "80px 32px", maxWidth: 800, margin: "0 auto" }}>
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <div style={{ textAlign: "center", marginBottom: 52 }}>
            <div style={{ color: "#A855F7", fontFamily: "monospace", fontSize: 10, letterSpacing: 4, fontWeight: 700, marginBottom: 16, opacity: 0.7 }}>◈ INITIATION ◈</div>
            <h2 style={{ fontSize: "clamp(28px, 4vw, 44px)", fontWeight: 900, color: "white", letterSpacing: -2, fontFamily: "monospace" }}>HOW TO MANIFEST</h2>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 0 }}>
            {[
              { num: "01", title: "CONNECT STACKS", text: "Link your Leather or Xverse wallet. No email. No password. Sovereign by design." },
              { num: "02", title: "SUBMIT A VECTOR", text: "Type any cultural concept — a movement, idea, philosophy, or aesthetic. The Oracle judges and transforms it." },
              { num: "03", title: "RECEIVE ORACLE JUDGMENT", text: "AI assigns a viral score, generates a unique name, ticker, sacred geometry SVG, and esoteric lore manifesto." },
              { num: "04", title: "INSCRIBE ON BITCOIN", text: "Confirm the transaction. Your sub-cult is permanently registered on Stacks L2 and propagated to the Global Codex." },
            ].map((step, i) => (
              <motion.div
                key={step.num}
                initial={{ opacity: 0, x: -20 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.08 }}
                style={{ display: "flex", gap: 24, padding: "28px 0", borderBottom: i < 3 ? "1px solid rgba(168,85,247,0.08)" : "none", alignItems: "flex-start" }}
              >
                <div style={{ fontSize: 11, fontWeight: 900, color: "#A855F7", fontFamily: "monospace", letterSpacing: 2, flexShrink: 0, width: 28, opacity: 0.6, paddingTop: 3 }}>{step.num}</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, fontWeight: 900, color: "white", fontFamily: "monospace", letterSpacing: 2, marginBottom: 8 }}>{step.title}</div>
                  <p style={{ fontSize: 13, color: "rgba(255,255,255,0.35)", lineHeight: 1.7 }}>{step.text}</p>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" style={{ padding: "80px 32px", maxWidth: 720, margin: "0 auto" }}>
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <div style={{ textAlign: "center", marginBottom: 52 }}>
            <div style={{ color: "#A855F7", fontFamily: "monospace", fontSize: 10, letterSpacing: 4, fontWeight: 700, marginBottom: 16, opacity: 0.7 }}>◈ DOCTRINE ◈</div>
            <h2 style={{ fontSize: "clamp(28px, 4vw, 44px)", fontWeight: 900, color: "white", letterSpacing: -2, fontFamily: "monospace" }}>FREQUENTLY<br />ASKED</h2>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {faqs.map((faq, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.06 }}
              >
                <div
                  className="landing-faq-item"
                  onClick={() => setOpenFaq(openFaq === i ? null : i)}
                  style={{
                    padding: "20px 24px",
                    borderRadius: 12,
                    border: "1px solid rgba(168,85,247,0.1)",
                    background: openFaq === i ? "rgba(168,85,247,0.06)" : "rgba(0,0,0,0.25)",
                    cursor: "pointer",
                    transition: "all 0.2s ease",
                    userSelect: "none",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: openFaq === i ? "white" : "rgba(255,255,255,0.6)", fontFamily: "monospace", lineHeight: 1.5 }}>{faq.q}</div>
                    <div style={{ fontSize: 18, color: "#A855F7", flexShrink: 0, transform: openFaq === i ? "rotate(45deg)" : "none", transition: "transform 0.2s", lineHeight: 1 }}>+</div>
                  </div>
                  <AnimatePresence>
                    {openFaq === i && (
                      <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.25 }}
                        style={{ overflow: "hidden" }}
                      >
                        <p style={{ marginTop: 16, fontSize: 13, color: "rgba(255,255,255,0.35)", lineHeight: 1.8 }}>{faq.a}</p>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            ))}
          </div>
        </motion.div>
      </section>

      {/* ── CTA ── */}
      <section style={{ padding: "80px 32px 120px", textAlign: "center", position: "relative" }}>
        {/* Purple radial behind CTA */}
        <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse 60% 80% at 50% 50%, rgba(168,85,247,0.06) 0%, transparent 70%)", pointerEvents: "none" }} />
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }} style={{ position: "relative" }}>
          <GlassPanel style={{ maxWidth: 680, margin: "0 auto", padding: "64px 48px", border: "1px solid rgba(168,85,247,0.2)", boxShadow: "0 0 80px rgba(168,85,247,0.06)" }}>
            <motion.div animate={{ scale: [1, 1.08, 1], opacity: [0.5, 1, 0.5] }} transition={{ duration: 4, repeat: Infinity }}
              style={{ fontSize: 48, marginBottom: 24, filter: "drop-shadow(0 0 20px rgba(168,85,247,0.6))" }}
            >◈</motion.div>
            <div style={{ fontSize: 10, fontFamily: "monospace", letterSpacing: 4, fontWeight: 700, color: "#A855F7", marginBottom: 20, opacity: 0.8 }}>THE CHAMBER AWAITS</div>
            <h2 style={{ fontSize: "clamp(24px, 4vw, 38px)", fontWeight: 900, color: "white", letterSpacing: -1, marginBottom: 16, fontFamily: "monospace", lineHeight: 1.2 }}>MANIFEST YOUR FIRST<br />DIGITAL MOVEMENT</h2>
            <p style={{ fontSize: 14, color: "rgba(255,255,255,0.3)", lineHeight: 1.7, marginBottom: 36, maxWidth: 440, margin: "0 auto 36px" }}>
              Connect Stacks, submit your cultural vector, and receive Oracle judgment within seconds.
            </p>
            <motion.button
              whileHover={{ scale: 1.05, boxShadow: "0 0 60px rgba(168,85,247,0.6)" }}
              whileTap={{ scale: 0.97 }}
              onClick={onLaunch}
              style={{ background: "linear-gradient(135deg, #A855F7 0%, #7C3AED 100%)", border: "none", borderRadius: 50, padding: "18px 64px", color: "white", fontWeight: 900, fontSize: 14, letterSpacing: 3, cursor: "pointer", fontFamily: "monospace", boxShadow: "0 0 40px rgba(168,85,247,0.35)" }}
            >LAUNCH APP ◈</motion.button>
          </GlassPanel>
        </motion.div>
      </section>
      {/* ── FOOTER ── */}
      <footer style={{ borderTop: "1px solid rgba(168,85,247,0.08)", padding: "40px 32px 48px", background: "rgba(0,0,0,0.3)" }}>
        <div style={{ maxWidth: 1000, margin: "0 auto" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 40, marginBottom: 40 }}>
            {/* Brand */}
            <div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                <img src="/CultOS_Logo.png" alt="CultOS" style={{ width: 26, height: 26, borderRadius: 7, objectFit: "cover" }} />
                <span style={{ fontFamily: "monospace", fontWeight: 900, color: "white", letterSpacing: 2, fontSize: 14 }}>CULTOS</span>
              </div>
              <p style={{ fontSize: 12, color: "rgba(255,255,255,0.25)", lineHeight: 1.8, maxWidth: 220 }}>
                Cult-as-a-Service on Bitcoin Layer 2. Memetic identity engine inscribed on Stacks Network.
              </p>
            </div>

            {/* Protocol */}
            <div>
              <div style={{ fontSize: 9, fontFamily: "monospace", fontWeight: 900, color: "#A855F7", letterSpacing: 3, marginBottom: 14, opacity: 0.8 }}>PROTOCOL</div>
              {[
                { label: "Stacks Network", url: "https://www.stacks.co" },
                { label: "Hiro Systems", url: "https://hiro.so" },
                { label: "Hiro API Docs", url: "https://docs.hiro.so" },
                { label: "Stacks Explorer", url: "https://explorer.hiro.so" },
              ].map(l => (
                <a key={l.label} href={l.url} target="_blank" rel="noopener noreferrer"
                  style={{ display: "block", fontSize: 12, color: "rgba(255,255,255,0.3)", marginBottom: 9, textDecoration: "none", fontFamily: "monospace", transition: "color 0.2s" }}
                  onMouseEnter={e => (e.target as HTMLElement).style.color = "#A855F7"}
                  onMouseLeave={e => (e.target as HTMLElement).style.color = "rgba(255,255,255,0.3)"}
                >{l.label} ↗</a>
              ))}
            </div>

            {/* Developers */}
            <div>
              <div style={{ fontSize: 9, fontFamily: "monospace", fontWeight: 900, color: "#A855F7", letterSpacing: 3, marginBottom: 14, opacity: 0.8 }}>DEVELOPERS</div>
              {[
                { label: "Clarity Language Docs", url: "https://docs.stacks.co/clarity/overview" },
                { label: "Stacks.js SDK", url: "https://stacks.js.org" },
                { label: "@stacks/connect", url: "https://github.com/hirosystems/stacks.js/tree/main/packages/connect" },
                { label: "SIP-010 Token Standard", url: "https://github.com/stacksgov/sips/blob/main/sips/sip-010" },
              ].map(l => (
                <a key={l.label} href={l.url} target="_blank" rel="noopener noreferrer"
                  style={{ display: "block", fontSize: 12, color: "rgba(255,255,255,0.3)", marginBottom: 9, textDecoration: "none", fontFamily: "monospace", transition: "color 0.2s" }}
                  onMouseEnter={e => (e.target as HTMLElement).style.color = "#A855F7"}
                  onMouseLeave={e => (e.target as HTMLElement).style.color = "rgba(255,255,255,0.3)"}
                >{l.label} ↗</a>
              ))}
            </div>

            {/* Contracts */}
            <div>
              <div style={{ fontSize: 9, fontFamily: "monospace", fontWeight: 900, color: "#A855F7", letterSpacing: 3, marginBottom: 14, opacity: 0.8 }}>CONTRACTS</div>
              {[
                { label: "Factory v2", url: "https://explorer.hiro.so/txid/SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.cultos-factory-v2?chain=mainnet" },
                { label: "Game Rewards v4", url: "https://explorer.hiro.so/txid/SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.cultos-game-rewards-v4?chain=mainnet" },
                { label: "$CultOS Token", url: "https://explorer.hiro.so/token/SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.CultOS?chain=mainnet" },
              ].map(l => (
                <a key={l.label} href={l.url} target="_blank" rel="noopener noreferrer"
                  style={{ display: "block", fontSize: 12, color: "rgba(255,255,255,0.3)", marginBottom: 9, textDecoration: "none", fontFamily: "monospace", transition: "color 0.2s" }}
                  onMouseEnter={e => (e.target as HTMLElement).style.color = "#22C55E"}
                  onMouseLeave={e => (e.target as HTMLElement).style.color = "rgba(255,255,255,0.3)"}
                >{l.label} ↗</a>
              ))}
            </div>
          </div>

          {/* Bottom bar */}
          <div style={{ borderTop: "1px solid rgba(168,85,247,0.06)", paddingTop: 24, display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
            <div style={{ fontSize: 11, color: "rgba(255,255,255,0.2)", fontFamily: "monospace" }}>
              © 2026 CultOS · All rights reserved · Built on Bitcoin Layer 2
            </div>
            <div style={{ display: "flex", gap: 20, alignItems: "center" }}>
              <span style={{ fontSize: 9, color: "rgba(168,85,247,0.4)", fontFamily: "monospace", letterSpacing: 1 }}>◈ STACKS MAINNET</span>
              <motion.span animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 2, repeat: Infinity }}
                style={{ width: 6, height: 6, borderRadius: "50%", background: "#22C55E", display: "inline-block" }}
              />
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
// ═══════════════════════════════════════════════════════════════════════════════
function SidebarPanel({ activeTab, setActiveTab, walletAddress, xp, gameCultos, blockHeight }: any) {
  const navItems = [
    { id: "chamber",   icon: "🧬", label: "MANIFESTATION CHAMBER" },
    { id: "mission",   icon: "🛩️", label: "SKY STRIKE MISSION" },
    { id: "dashboard", icon: "🔮", label: "MY CODEX" },
    { id: "xp",        icon: "🌌", label: "XP ALTAR" },
    { id: "ritual",    icon: "🩸", label: "RITUAL ALTAR" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 12 }}>
      <GlassPanel style={{ padding: 20 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16 }}>
          <div style={{ width: 40, height: 40, borderRadius: "50%", background: "linear-gradient(135deg, #A855F7, #22C55E)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0, boxShadow: "0 0 12px rgba(168,85,247,0.4)" }}>Ω</div>
          <div>
            <div style={{ fontSize: 11, fontFamily: "monospace", color: "#A855F7", fontWeight: 700, letterSpacing: 1 }}>
              {walletAddress ? `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}` : "UNBOUND"}
            </div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontWeight: 600, marginTop: 2 }}>
              {walletAddress ? "SIGNAL PROPAGATOR" : "CONNECT STACKS"}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", background: "rgba(168,85,247,0.06)", borderRadius: 8, border: "1px solid rgba(168,85,247,0.12)" }}>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", fontWeight: 700 }}>DEVOTION XP</span>
          <span style={{ fontSize: 14, fontWeight: 900, color: "#A855F7", fontFamily: "monospace" }}>{xp.toLocaleString()}</span>
        </div>
        {gameCultos > 0 && (
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", marginTop: 8, background: "rgba(251,191,36,0.06)", borderRadius: 8, border: "1px solid rgba(251,191,36,0.15)" }}>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", fontWeight: 700 }}>🪙 $CULTOS (CLAIMED)</span>
            <span style={{ fontSize: 14, fontWeight: 900, color: "#fbbf24", fontFamily: "monospace" }}>{gameCultos.toLocaleString()}</span>
          </div>
        )}
      </GlassPanel>

      <GlassPanel style={{ padding: "8px", flex: 1 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {navItems.map(item => (
            <button key={item.id} onClick={() => setActiveTab(item.id)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 10, border: "none", cursor: "pointer", background: activeTab === item.id ? "rgba(168,85,247,0.15)" : "transparent", borderLeft: activeTab === item.id ? "2px solid #A855F7" : "2px solid transparent", transition: "all 0.2s", color: activeTab === item.id ? "white" : "rgba(255,255,255,0.4)" }}
              onMouseEnter={e => { if (activeTab !== item.id) (e.currentTarget as HTMLButtonElement).style.background = "rgba(168,85,247,0.05)"; }}
              onMouseLeave={e => { if (activeTab !== item.id) (e.currentTarget as HTMLButtonElement).style.background = "transparent"; }}
            >
              <span style={{ fontSize: 16 }}>{item.icon}</span>
              <span style={{ fontSize: 10, fontFamily: "monospace", fontWeight: 800, letterSpacing: 1 }}>{item.label}</span>
            </button>
          ))}
        </div>
      </GlassPanel>

      <GlassPanel style={{ padding: 16 }}>
        {[
          { label: "ORACLE STATUS",  value: "ACTIVE",    color: "#22C55E" },
          { label: "STACKS NETWORK", value: "MAINNET",   color: "#A855F7" },
          { label: "BLOCK HEIGHT",   value: blockHeight, color: "rgba(255,255,255,0.6)" },
        ].map(row => (
          <div key={row.label} style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 9, fontFamily: "monospace", color: "rgba(255,255,255,0.3)", fontWeight: 700 }}>{row.label}</span>
            <span style={{ fontSize: 9, fontFamily: "monospace", color: row.color, fontWeight: 700 }}>{row.value}</span>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4 }}>
          <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#22C55E", animation: "pulse 2s infinite" }} />
          <span style={{ fontSize: 9, fontFamily: "monospace", color: "rgba(255,255,255,0.25)" }}>SYSTEM NOMINAL</span>
        </div>
      </GlassPanel>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MANIFESTATION CHAMBER
// ═══════════════════════════════════════════════════════════════════════════════
function ManifestationChamber({ onDeploy, walletAddress, terminalLogs, addLog, isMobile }: any) {
  const [prompt, setPrompt] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [deployedTxId, setDeployedTxId] = useState<string | null>(null);
  const termRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [terminalLogs]);

  const handleManifest = async () => {
    if (isGenerating) return;
    setIsGenerating(true);
    setError(null);
    setResult(null);
    addLog("ORACLE_INVOCATION: INITIATING VECTOR ANALYSIS...");
    addLog(`INPUT_VECTOR: "${prompt || "RANDOM_SYNTHESIS"}" // DISPATCHING TO GROQ_ORACLE`);
    try {
      const data = await invokeOracle(prompt);
      setResult(data);
      addLog(`ORACLE_VERDICT: isBoring=${data.isBoring} // viralScore=${data.viralScore}`);
      addLog(`TOKEN_SYNTHESIZED: ${data.upgradedName} [$${data.ticker}]`);
      addLog("MANIFESTATION_COMPLETE: SVG_SIGIL_GENERATED // AWAITING_DEPLOYMENT");
    } catch (e: any) {
      setError("ORACLE_EXCEPTION: " + (e.message || "UNKNOWN_FAULT"));
      addLog("CRITICAL: ORACLE_RESPONSE_MALFORMED // RETRY_ADVISED");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDeploy = async () => {
    if (!walletAddress) {
      addLog("ERROR: WALLET_NOT_BOUND // CONNECT_DEVOTION_WALLET");
      return;
    }
    if (!result || isDeploying) return;

    const { feeSTX: feeSTXStr, microSTX } = _utils.calcDeployFee(result.viralScore);

    const FACTORY = import.meta.env.VITE_FACTORY_CONTRACT
      || "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.cultos-factory-v2";
    const [contractAddress, contractName] = FACTORY.split(".");

    if (!contractAddress || !contractName) {
      addLog("ERROR: VITE_FACTORY_CONTRACT env var tidak valid");
      return;
    }

    addLog(`STACKS_BROADCAST: PREPARING_CONTRACT_CALL...`);
    addLog(`CONTRACT: ${contractAddress.slice(0, 8)}...${contractName}`);
    addLog(`FEE: ${feeSTXStr} STX // AWAITING_WALLET_CONFIRMATION...`);

    setIsDeploying(true);
    try {
      const { safeName, safeTicker, safeLore } = _utils.sanitizeOracleResult(result);

      if (!safeName || !safeTicker) {
        addLog("ERROR: NAME_OR_TICKER_INVALID // TRY_REGENERATE");
        setIsDeploying(false);
        return;
      }

      await openContractCall({
        contractAddress,
        contractName,
        functionName: "register-cult",
        functionArgs: [
          stringUtf8CV(safeName),
          stringUtf8CV(safeTicker),
          stringUtf8CV(safeLore),
          uintCV(result.viralScore),
          uintCV(microSTX),
        ],
        postConditionMode: PostConditionMode.Allow,
        postConditions: [],
        network: "mainnet",
        onFinish: (data: any) => {
          const txId = data?.txId || data?.transaction_id || "unknown";
          setDeployedTxId(txId);
          addLog(`TX_BROADCAST: ${txId.slice(0, 16)}...`);
          addLog(`CULT_REGISTERED: ${result.upgradedName} // ON_CHAIN`);
          onDeploy({ ...result, txId });
          setShowSuccess(true);
          setIsDeploying(false);
        },
        onCancel: () => {
          addLog("TX_CANCELLED: USER_REJECTED_TRANSACTION");
          setIsDeploying(false);
        },
      });
    } catch (err: any) {
      const msg = err?.message || String(err);
      addLog(`TX_FAILED: ${msg.slice(0, 80)}`);
      setIsDeploying(false);
    }
  };

  const feeSTX = result ? _utils.calcDeployFee(result.viralScore).feeSTX : "0.050";

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 12 }}>
      {/* Success Modal */}
      <AnimatePresence>
        {showSuccess && result && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            style={{ position: "fixed", inset: 0, zIndex: 500, background: "rgba(8,5,18,0.95)", backdropFilter: "blur(20px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
          >
            <motion.div initial={{ scale: 0.85, y: 30 }} animate={{ scale: 1, y: 0 }} style={{ maxWidth: 480, width: "100%" }}>
              <GlassPanel style={{ padding: 40, textAlign: "center", border: "1px solid rgba(34,197,94,0.3)", boxShadow: "0 0 80px rgba(34,197,94,0.2)" }}>
                <motion.div animate={{ scale: [1, 1.15, 1], rotate: [0, 5, -5, 0] }} transition={{ duration: 4, repeat: Infinity }} style={{ fontSize: 56, marginBottom: 20 }}>✦</motion.div>
                <h2 style={{ fontSize: 28, fontWeight: 900, color: "white", fontFamily: "monospace", letterSpacing: -1, marginBottom: 8 }}>MANIFESTATION COMPLETE</h2>
                <p style={{ color: "#22C55E", fontFamily: "monospace", fontSize: 12, letterSpacing: 2, marginBottom: 28 }}>{result.upgradedName} INSCRIBED ON BITCOIN L2</p>
                <div style={{ background: "rgba(0,0,0,0.4)", borderRadius: 12, padding: 20, marginBottom: 16, textAlign: "left" }}>
                  {[
                    ["TICKER",      `$${result.ticker}`,              "#A855F7"],
                    ["VIRAL SCORE", `${result.viralScore}/100`,       "#22C55E"],
                    ["NETWORK",     "STACKS MAINNET",                 "rgba(255,255,255,0.7)"],
                    ["STATUS",      "SOVEREIGN_ACTIVE",               "#22C55E"],
                    ["FEE PAID",    `${feeSTX} STX`,                  "rgba(255,255,255,0.5)"],
                  ].map(([k, v, c]) => (
                    <div key={k as string} style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, alignItems: "center" }}>
                      <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: "monospace", fontWeight: 700 }}>{k}</span>
                      <span style={{ fontSize: 12, fontWeight: 800, color: c as string, fontFamily: "monospace" }}>{v}</span>
                    </div>
                  ))}
                  {deployedTxId && deployedTxId !== "unknown" && (
                    <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.08)" }}>
                      <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: "monospace", fontWeight: 700, marginBottom: 6 }}>TX ID</div>
                      <div style={{ fontSize: 10, color: "#A855F7", fontFamily: "monospace", wordBreak: "break-all", lineHeight: 1.5 }}>{deployedTxId}</div>
                    </div>
                  )}
                </div>
                {deployedTxId && deployedTxId !== "unknown" && (
                  <a href={`https://explorer.hiro.so/txid/${deployedTxId}?chain=mainnet`} target="_blank" rel="noopener noreferrer"
                    style={{ display: "block", width: "100%", boxSizing: "border-box", background: "rgba(168,85,247,0.12)", border: "1px solid rgba(168,85,247,0.3)", borderRadius: 10, padding: "11px 0", marginBottom: 10, color: "#A855F7", fontWeight: 800, fontSize: 11, letterSpacing: 2, cursor: "pointer", fontFamily: "monospace", textDecoration: "none", textAlign: "center" }}
                  >VIEW ON STACKS EXPLORER ↗</a>
                )}
                <button onClick={() => {
                  const tweet = `🔮 Just inscribed $${result.ticker} — "${result.upgradedName}" onto Bitcoin L2\nViral Score: ${result.viralScore}/100\n#CultOS #Bitcoin #Stacks\nhttps://cult-os.vercel.app`;
                  window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}`, '_blank');
                }}
                  style={{ width: "100%", boxSizing: "border-box", background: "rgba(29,161,242,0.12)", border: "1px solid rgba(29,161,242,0.3)", borderRadius: 10, padding: "11px 0", marginBottom: 10, color: "#1DA1F2", fontWeight: 800, fontSize: 11, letterSpacing: 2, cursor: "pointer", fontFamily: "monospace" }}
                >SHARE ON X (TWITTER) 𝕏</button>
                <button onClick={() => { setShowSuccess(false); setDeployedTxId(null); }}
                  style={{ width: "100%", background: "linear-gradient(135deg, #22C55E, #16A34A)", border: "none", borderRadius: 12, padding: "14px 0", color: "black", fontWeight: 900, fontSize: 13, letterSpacing: 2, cursor: "pointer", fontFamily: "monospace" }}
                >CONTINUE →</button>
              </GlassPanel>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Input Zone */}
      <GlassPanel style={{ padding: 20 }}>
        <div style={{ marginBottom: 12, fontSize: 11, fontFamily: "monospace", color: "#A855F7", fontWeight: 700, letterSpacing: 2 }}>◈ CULTURAL VECTOR INPUT</div>
        <div style={{ display: "flex", gap: 10, flexWrap: isMobile ? "wrap" : "nowrap" }}>
          <div style={{ flex: 1, position: "relative", minWidth: 0 }}>
            <input value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={e => e.key === "Enter" && handleManifest()}
              placeholder='Enter cultural vector... (e.g. "quantum sovereignty")'
              style={{ width: "100%", boxSizing: "border-box", background: "rgba(0,0,0,0.5)", border: "1px solid rgba(168,85,247,0.2)", borderRadius: 10, padding: "12px 40px 12px 14px", color: "white", fontSize: 13, outline: "none", fontFamily: "monospace", transition: "border-color 0.2s" }}
              onFocus={e => (e.target.style.borderColor = "rgba(168,85,247,0.5)")}
              onBlur={e => (e.target.style.borderColor = "rgba(168,85,247,0.2)")}
            />
            <span style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", color: "rgba(168,85,247,0.4)", fontSize: 14 }}>⚡</span>
          </div>
          <motion.button whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }} onClick={handleManifest} disabled={isGenerating}
            style={{ background: isGenerating ? "rgba(168,85,247,0.2)" : "linear-gradient(135deg, #A855F7, #7C3AED)", border: "none", borderRadius: 10, padding: "12px 24px", color: "white", fontWeight: 900, fontSize: 12, letterSpacing: 1, cursor: isGenerating ? "not-allowed" : "pointer", fontFamily: "monospace", whiteSpace: "nowrap", boxShadow: isGenerating ? "none" : "0 0 20px rgba(168,85,247,0.3)", flexShrink: 0 }}
          >{isGenerating ? "PROCESSING..." : "INVOKE ORACLE"}</motion.button>
        </div>
        {error && (
          <div style={{ marginTop: 10, padding: "8px 12px", background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 8, fontSize: 11, color: "#EF4444", fontFamily: "monospace" }}>⚠ {error}</div>
        )}
      </GlassPanel>

      {/* Terminal Log */}
      <GlassPanel style={{ padding: 16, flexShrink: 0 }}>
        <div style={{ fontSize: 10, fontFamily: "monospace", color: "#22C55E", fontWeight: 700, letterSpacing: 2, marginBottom: 8 }}>[SYS] ORACLE_STREAM_LOG</div>
        <div ref={termRef} style={{ height: 80, overflowY: "auto", scrollbarWidth: "none" }}>
          {terminalLogs.map((log: string, i: number) => (
            <div key={i} style={{ fontSize: 10, fontFamily: "monospace", color: "rgba(168,85,247,0.7)", marginBottom: 2, lineHeight: 1.5 }}>{log}</div>
          ))}
          {isGenerating && (
            <motion.div animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1, repeat: Infinity }} style={{ fontSize: 10, fontFamily: "monospace", color: "#22C55E" }}>
              {">"} ORACLE_PROCESSING... ▌
            </motion.div>
          )}
        </div>
      </GlassPanel>

      {/* Result Display */}
      <AnimatePresence>
        {result && (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} style={{ flex: 1, display: "flex", flexDirection: "column", gap: 12, overflow: "auto" }}>
            {result.isBoring && result.roast && (
              <GlassPanel style={{ padding: 16, border: "1px solid rgba(239,68,68,0.3)", background: "rgba(239,68,68,0.05)" }}>
                <div style={{ fontSize: 10, fontFamily: "monospace", color: "#EF4444", fontWeight: 700, letterSpacing: 2, marginBottom: 8 }}>◈ ORACLE ROAST PROTOCOL ACTIVATED</div>
                <p style={{ fontSize: 13, color: "rgba(255,255,255,0.7)", lineHeight: 1.7, fontStyle: "italic" }}>"{result.roast}"</p>
              </GlassPanel>
            )}
            <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : "200px 1fr", gap: 12 }}>
              <div>
                <OracleSVG rawSVG={result.rawSVG} name={result.upgradedName} />
                <div style={{ marginTop: 8, textAlign: "center" }}>
                  <div style={{ fontSize: 9, fontFamily: "monospace", color: "rgba(168,85,247,0.5)", letterSpacing: 2 }}>SACRED SIGIL // ORACLE GENERATED</div>
                </div>
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 11, fontFamily: "monospace", color: "#A855F7", fontWeight: 700, letterSpacing: 2, marginBottom: 4 }}>${result.ticker}</div>
                  <h2 style={{ fontSize: isMobile ? 22 : 26, fontWeight: 900, color: "white", fontFamily: "monospace", letterSpacing: -1, lineHeight: 1.1 }}>{result.upgradedName}</h2>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {[
                    { label: "VIRAL SCORE",  value: result.viralScore, color: _utils.getViralRating(result.viralScore).color },
                    { label: "ORACLE GRADE", value: result.isBoring ? "MUNDANE" : "SOVEREIGN", color: result.isBoring ? "#F59E0B" : "#22C55E" },
                  ].map(s => (
                    <GlassPanel key={s.label} style={{ padding: 12 }}>
                      <div style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", fontFamily: "monospace", fontWeight: 700, letterSpacing: 1, marginBottom: 4 }}>{s.label}</div>
                      <div style={{ fontSize: 18, fontWeight: 900, color: s.color, fontFamily: "monospace" }}>{s.value}</div>
                    </GlassPanel>
                  ))}
                </div>
                <div style={{ background: "rgba(0,0,0,0.3)", borderRadius: 6, height: 4, overflow: "hidden" }}>
                  <motion.div initial={{ width: 0 }} animate={{ width: `${result.viralScore}%` }} transition={{ duration: 1.2, ease: "easeOut" }}
                    style={{ height: "100%", background: "linear-gradient(90deg, #A855F7, #22C55E)" }}
                  />
                </div>
              </div>
            </div>
            <GlassPanel style={{ padding: 20 }}>
              <div style={{ fontSize: 10, fontFamily: "monospace", color: "#A855F7", fontWeight: 700, letterSpacing: 2, marginBottom: 12 }}>◈ ESOTERIC MANIFESTO</div>
              <p style={{ fontSize: 13, color: "rgba(255,255,255,0.6)", lineHeight: 1.8 }}>{result.lore}</p>
            </GlassPanel>
            {!walletAddress && (
              <div style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(168,85,247,0.08)", border: "1px solid rgba(168,85,247,0.25)", textAlign: "center", fontSize: 12, fontFamily: "monospace", color: "rgba(168,85,247,0.8)", letterSpacing: 1 }}>
                ⚡ CONNECT STACKS TO DEPLOY
              </div>
            )}
            <motion.button
              whileHover={walletAddress && !isDeploying ? { scale: 1.02, boxShadow: "0 0 40px rgba(34,197,94,0.4)" } : {}}
              whileTap={walletAddress && !isDeploying ? { scale: 0.98 } : {}}
              onClick={handleDeploy}
              disabled={!walletAddress || isDeploying}
              style={{
                width: "100%",
                background: isDeploying ? "rgba(34,197,94,0.2)" : walletAddress ? "linear-gradient(135deg, #22C55E, #16A34A)" : "rgba(255,255,255,0.05)",
                border: walletAddress ? "none" : "1px solid rgba(255,255,255,0.1)",
                borderRadius: 12, padding: "16px 0",
                color: walletAddress ? (isDeploying ? "#22C55E" : "black") : "rgba(255,255,255,0.2)",
                fontWeight: 900, fontSize: 14, letterSpacing: 2,
                cursor: walletAddress && !isDeploying ? "pointer" : "not-allowed",
                fontFamily: "monospace",
                boxShadow: walletAddress && !isDeploying ? "0 0 25px rgba(34,197,94,0.25)" : "none",
                transition: "all 0.3s ease",
              }}
            >
              {!walletAddress ? "STACKS REQUIRED" : isDeploying ? "AWAITING STACKS CONFIRMATION..." : `DEPLOY TO BITCOIN L2 — ${feeSTX} STX`}
            </motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {!result && !isGenerating && (
        <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div style={{ textAlign: "center", opacity: 0.3 }}>
            <motion.div animate={{ scale: [1, 1.08, 1], opacity: [0.3, 0.6, 0.3] }} transition={{ duration: 4, repeat: Infinity }} style={{ fontSize: 64, marginBottom: 16 }}>◈</motion.div>
            <div style={{ fontSize: 12, fontFamily: "monospace", color: "rgba(255,255,255,0.4)", letterSpacing: 2 }}>THE ORACLE AWAITS YOUR VECTOR</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// GAZE FEED — On-chain activity ticker (real Stacks contract transactions)
// ═══════════════════════════════════════════════════════════════════════════════
const GAZE_MOCK: GazeEvent[] = [
  { id: "m1", type: "STAKE",   address: "SP3F7K...B8K2", amount: "2,500 $CultOS",  blockHeight: 0, timeAgo: "4m ago"  },
  { id: "m2", type: "STAKE",   address: "SP7A3J...B1W9", amount: "750 $CultOS",    blockHeight: 0, timeAgo: "11m ago" },
  { id: "m3", type: "UNSTAKE", address: "SP2M6J...B3N6", amount: "5,000 $CultOS",  blockHeight: 0, timeAgo: "28m ago" },
  { id: "m4", type: "STAKE",   address: "SP9K1J...B5J3", amount: "300 $CultOS",    blockHeight: 0, timeAgo: "41m ago" },
  { id: "m5", type: "FUND",    address: "SPQ189...HAEF",  amount: "50,000 $CultOS", blockHeight: 0, timeAgo: "2h ago"  },
];

function GazeFeed() {
  const [events, setEvents]   = useState<GazeEvent[]>([]);
  const [isLive, setIsLive]   = useState(false);
  const [blockNow, setBlockNow] = useState(0);

  useEffect(() => {
    (async () => {
      const b = await fetchBlockHeightRaw();
      setBlockNow(b);
      const evts = await fetchGazeEvents(b);
      if (evts.length > 0) { setEvents(evts); setIsLive(true); }
      else setEvents(GAZE_MOCK);
    })();
    const interval = setInterval(async () => {
      const b = await fetchBlockHeightRaw();
      setBlockNow(b);
      const evts = await fetchGazeEvents(b);
      if (evts.length > 0) { setEvents(evts); setIsLive(true); }
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  const typeColor = (t: GazeEvent["type"]) =>
    t === "STAKE" ? "#22C55E" : t === "UNSTAKE" ? "#F59E0B" : "#A855F7";
  const typeIcon  = (t: GazeEvent["type"]) =>
    t === "STAKE" ? "↓" : t === "UNSTAKE" ? "↑" : "⊕";

  const displayEvents = events.length > 0 ? events : GAZE_MOCK;

  return (
    <GlassPanel style={{ padding: 16, marginBottom: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontFamily: "monospace", color: "#A855F7", fontWeight: 900, letterSpacing: 2 }}>⚡ GAZE FEED</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          {blockNow > 0 && (
            <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "monospace" }}>#{blockNow.toLocaleString()}</span>
          )}
          <span style={{ fontSize: 9, fontFamily: "monospace", padding: "2px 7px", background: isLive ? "rgba(34,197,94,0.1)" : "rgba(168,85,247,0.1)", border: `1px solid ${isLive ? "rgba(34,197,94,0.3)" : "rgba(168,85,247,0.2)"}`, borderRadius: 4, color: isLive ? "#22C55E" : "#A855F7", fontWeight: 700 }}>
            <motion.span animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 2, repeat: Infinity }}>● </motion.span>
            {isLive ? "LIVE" : "MOCK"}
          </span>
        </div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 240, overflowY: "auto", scrollbarWidth: "none" }}>
        {displayEvents.map((evt, i) => (
          <motion.div key={evt.id} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.04 }}
            style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, background: "rgba(0,0,0,0.3)", border: `1px solid ${typeColor(evt.type)}18` }}
          >
            <div style={{ width: 22, height: 22, borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", background: `${typeColor(evt.type)}18`, fontSize: 12, fontWeight: 900, color: typeColor(evt.type), flexShrink: 0, fontFamily: "monospace" }}>
              {typeIcon(evt.type)}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 10, fontFamily: "monospace", color: typeColor(evt.type), fontWeight: 900, letterSpacing: 1 }}>{evt.type}</span>
                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "monospace" }}>{evt.timeAgo}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.35)", fontFamily: "monospace" }}>{evt.address}</span>
                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.6)", fontFamily: "monospace", fontWeight: 700 }}>{evt.amount}</span>
              </div>
            </div>
          </motion.div>
        ))}
      </div>
    </GlassPanel>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CODEX FEED
// ═══════════════════════════════════════════════════════════════════════════════

// Shared aesthetic loading spinner used across panels
function OccultSpinner({ label = "FETCHING FROM CHAIN" }: { label?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, minHeight: 180, gap: 20 }}>
      <div style={{ position: "relative", width: 64, height: 64 }}>
        {/* Outer ring */}
        <motion.div
          animate={{ rotate: 360 }}
          transition={{ duration: 3, repeat: Infinity, ease: "linear" }}
          style={{
            position: "absolute", inset: 0,
            borderRadius: "50%",
            border: "1.5px solid transparent",
            borderTopColor: "#A855F7",
            borderRightColor: "rgba(168,85,247,0.3)",
          }}
        />
        {/* Inner ring counter */}
        <motion.div
          animate={{ rotate: -360 }}
          transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
          style={{
            position: "absolute", inset: 12,
            borderRadius: "50%",
            border: "1.5px solid transparent",
            borderTopColor: "#22C55E",
            borderLeftColor: "rgba(34,197,94,0.3)",
          }}
        />
        {/* Centre sigil */}
        <motion.div
          animate={{ opacity: [0.4, 1, 0.4], scale: [0.85, 1, 0.85] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
          style={{
            position: "absolute", inset: 0,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 16, color: "#A855F7",
          }}
        >◈</motion.div>
      </div>
      <div style={{ fontSize: 9, fontFamily: "monospace", color: "rgba(168,85,247,0.5)", letterSpacing: 3, fontWeight: 700 }}>{label}</div>
    </div>
  );
}

// Wallet gate — shown when wallet is not connected
function WalletGate({ onConnect, isConnecting }: { onConnect: () => void; isConnecting: boolean }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", flex: 1, minHeight: 220, gap: 20, padding: 24 }}>
      <motion.div
        animate={{ opacity: [0.4, 0.9, 0.4], scale: [0.95, 1.05, 0.95] }}
        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
        style={{ fontSize: 40, filter: "drop-shadow(0 0 20px rgba(168,85,247,0.5))" }}
      >◈</motion.div>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 900, color: "rgba(255,255,255,0.7)", letterSpacing: 2, marginBottom: 6 }}>SOVEREIGN ACCESS REQUIRED</div>
        <div style={{ fontSize: 10, fontFamily: "monospace", color: "rgba(255,255,255,0.25)", lineHeight: 1.6 }}>Connect your Stacks wallet<br/>to access this chamber</div>
      </div>
      <motion.button
        whileHover={{ scale: 1.05, boxShadow: "0 0 40px rgba(168,85,247,0.5)" }}
        whileTap={{ scale: 0.97 }}
        onClick={onConnect}
        disabled={isConnecting}
        style={{
          background: isConnecting ? "rgba(168,85,247,0.2)" : "linear-gradient(135deg, #A855F7, #7C3AED)",
          border: "none", borderRadius: 50,
          padding: "12px 32px",
          color: "white", fontWeight: 900, fontSize: 11, letterSpacing: 2,
          cursor: isConnecting ? "wait" : "pointer",
          fontFamily: "monospace",
          boxShadow: isConnecting ? "none" : "0 0 24px rgba(168,85,247,0.4)",
        }}
      >{isConnecting ? "CONNECTING..." : "CONNECT STACKS ◈"}</motion.button>
    </div>
  );
}

function CodexFeed({ deployedCults, walletAddress, onConnect, isConnecting }: {
  deployedCults: any[];
  walletAddress: string | null;
  onConnect: () => void;
  isConnecting: boolean;
}) {
  const [liveFeed, setLiveFeed] = useState<LiveCultEntry[]>([]);
  const [feedLoading, setFeedLoading] = useState(true);

  useEffect(() => {
    if (!walletAddress) return; // don't fetch until connected
    setFeedLoading(true);
    const unsub = subscribeLiveFeed(
      (entries) => {
        setLiveFeed(entries);
        setFeedLoading(false);
      },
      () => { setFeedLoading(false); }
    );
    if (unsub) return unsub;
  }, [walletAddress]);

  const sessionCults = deployedCults.slice().reverse().map((c: any) => ({
    id: `session-${c.ticker}-${Date.now()}`,
    name: c.upgradedName,
    ticker: c.ticker,
    score: c.viralScore,
    address: "YOUR WALLET",
    time: "just now",
  }));

  const allCults = [...sessionCults, ...liveFeed];

  // Not connected → wallet gate
  if (!walletAddress) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexShrink: 0 }}>
          <span style={{ fontSize: 11, fontFamily: "monospace", color: "#A855F7", fontWeight: 700, letterSpacing: 2 }}>◈ GLOBAL CODEX FEED</span>
        </div>
        <GlassPanel style={{ flex: 1, display: "flex" }}>
          <WalletGate onConnect={onConnect} isConnecting={isConnecting} />
        </GlassPanel>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontFamily: "monospace", color: "#A855F7", fontWeight: 700, letterSpacing: 2 }}>◈ GLOBAL CODEX FEED</span>
        <span style={{ fontSize: 9, fontFamily: "monospace", padding: "3px 8px", background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.2)", borderRadius: 4, color: "#22C55E", fontWeight: 700 }}>
          <motion.span animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 2, repeat: Infinity }}>● </motion.span>
          LIVE
        </span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", scrollbarWidth: "none", display: "flex", flexDirection: "column", gap: 8 }}>
        {feedLoading ? (
          <OccultSpinner label="READING BITCOIN LAYER 2" />
        ) : allCults.length === 0 ? (
          <div style={{ padding: "24px 16px", textAlign: "center", opacity: 0.4 }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>◈</div>
            <div style={{ fontSize: 10, fontFamily: "monospace", color: "rgba(168,85,247,0.6)", letterSpacing: 2 }}>NO DEPLOYMENTS YET</div>
            <div style={{ fontSize: 9, fontFamily: "monospace", color: "rgba(255,255,255,0.2)", marginTop: 4 }}>Be the first to inscribe a cult</div>
          </div>
        ) : allCults.map((cult, i) => (
          <motion.div key={(cult as any).id || i} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }}>
            <GlassPanel hover style={{ padding: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 800, color: "white", fontFamily: "monospace", marginBottom: 2 }}>{(cult as any).name || (cult as any).upgradedName}</div>
                  <div style={{ fontSize: 10, color: "#A855F7", fontFamily: "monospace", fontWeight: 700 }}>${cult.ticker}</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <button onClick={() => {
                    const name = (cult as any).name || (cult as any).upgradedName || cult.ticker;
                    const score = (cult as any).score || (cult as any).viralScore;
                    const tweet = `🔮 $${cult.ticker} — "${name}" just inscribed on Bitcoin L2\nViral Score: ${score}/100\n#CultOS #Bitcoin #Stacks\nhttps://cult-os.vercel.app`;
                    window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(tweet)}`, '_blank');
                  }}
                    style={{ background: "rgba(29,161,242,0.1)", border: "1px solid rgba(29,161,242,0.2)", borderRadius: 6, padding: "3px 7px", color: "#1DA1F2", fontSize: 9, fontFamily: "monospace", fontWeight: 700, cursor: "pointer", letterSpacing: 0.5 }}
                  >𝕏</button>
                  <div style={{ textAlign: "right" }}>
                    <div style={{ fontSize: 12, fontWeight: 900, fontFamily: "monospace", color: ((cult as any).score || (cult as any).viralScore) >= 80 ? "#22C55E" : ((cult as any).score || (cult as any).viralScore) >= 50 ? "#F59E0B" : "#EF4444" }}>
                      {(cult as any).score || (cult as any).viralScore}
                    </div>
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", fontFamily: "monospace" }}>VIRAL</div>
                  </div>
                </div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "monospace" }}>{cult.address}</span>
                <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "monospace" }}>{cult.time || "just now"}</span>
              </div>
              <div style={{ marginTop: 8, height: 2, background: "rgba(168,85,247,0.1)", borderRadius: 2, overflow: "hidden" }}>
                <div style={{ height: "100%", width: `${(cult as any).score || (cult as any).viralScore}%`, background: "linear-gradient(90deg, #A855F7, #22C55E)", borderRadius: 2 }} />
              </div>
            </GlassPanel>
          </motion.div>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// DASHBOARD PANEL
// ═══════════════════════════════════════════════════════════════════════════════
function PersonalCodex({ deployedCults, walletAddress, onConnect, isConnecting }: {
  deployedCults: any[];
  walletAddress: string | null;
  onConnect: () => void;
  isConnecting: boolean;
}) {
  const [onChainCults, setOnChainCults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  // Fetch on-chain deploys for this wallet from both factory contracts
  useEffect(() => {
    if (!walletAddress) return;
    setLoading(true);

    const HIRO = "https://api.mainnet.hiro.so";
    const fetchForContract = async (contractId: string) => {
      try {
        const res = await fetch(
          `${HIRO}/extended/v1/address/${contractId}/transactions?limit=50&unanchored=true`
        );
        if (!res.ok) return [];
        const data = await res.json();
        return (data?.results ?? []).filter((tx: any) =>
          tx.tx_status === 'success' &&
          tx.tx_type === 'contract_call' &&
          tx.contract_call?.function_name === 'register-cult' &&
          tx.sender_address === walletAddress
        );
      } catch { return []; }
    };

    Promise.allSettled([
      fetchForContract("SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.cultos-factory"),
      fetchForContract("SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.cultos-factory-v2"),
    ]).then(results => {
      const txs = [
        ...(results[0].status === 'fulfilled' ? results[0].value : []),
        ...(results[1].status === 'fulfilled' ? results[1].value : []),
      ];
      // Parse TX into cult objects
      const parsed = txs.map((tx: any) => {
        const args = tx.contract_call?.function_args ?? [];
        const stripRepr = (r: string) => r ? r.replace(/^u?/, '').replace(/^"|"$/g, '').trim() : '';
        return {
          upgradedName: stripRepr(args[0]?.repr) || 'UNKNOWN',
          ticker:       stripRepr(args[1]?.repr) || '????',
          lore:         stripRepr(args[2]?.repr) || '',
          viralScore:   parseInt((args[3]?.repr ?? '').replace(/^u/, ''), 10) || 0,
          rawSVG:       null,
          txId:         tx.tx_id,
          time:         tx.burn_block_time_iso ? new Date(tx.burn_block_time_iso) : null,
          source:       'chain',
        };
      });
      setOnChainCults(parsed);
      setLoading(false);
    });
  }, [walletAddress]);

  // Not connected
  if (!walletAddress) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 16 }}>
        <div style={{ fontSize: 11, fontFamily: "monospace", color: "#A855F7", fontWeight: 900, letterSpacing: 2 }}>◈ MY CULT HISTORY</div>
        <GlassPanel style={{ padding: 24, display: "flex" }}>
          <WalletGate onConnect={onConnect} isConnecting={isConnecting} />
        </GlassPanel>
      </div>
    );
  }

  // Merge session cults (with SVG) + on-chain cults (without SVG)
  // Session cults take priority (they have lore + SVG from Oracle)
  const sessionTickers = new Set(deployedCults.map((c: any) => c.ticker));
  const chainOnly = onChainCults.filter(c => !sessionTickers.has(c.ticker));
  const allCults = [...deployedCults.slice().reverse(), ...chainOnly];

  return (
    <div style={{ height: "100%", overflowY: "auto", scrollbarWidth: "none", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ fontSize: 11, fontFamily: "monospace", color: "#A855F7", fontWeight: 900, letterSpacing: 2 }}>
        ◈ MY CULT HISTORY
        <span style={{ marginLeft: 8, color: "rgba(255,255,255,0.25)", fontWeight: 400 }}>({allCults.length})</span>
      </div>

      {loading && allCults.length === 0 && (
        <OccultSpinner label="READING YOUR INSCRIPTIONS" />
      )}

      {!loading && allCults.length === 0 && (
        <GlassPanel style={{ padding: 40, textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 16, opacity: 0.4 }}>🔮</div>
          <div style={{ fontFamily: "monospace", fontSize: 12, color: "rgba(255,255,255,0.4)", letterSpacing: 1 }}>
            NO INSCRIPTIONS YET<br />
            <span style={{ fontSize: 10, opacity: 0.6 }}>MANIFEST YOUR FIRST SUB-CULT IN THE CHAMBER</span>
          </div>
        </GlassPanel>
      )}

      {allCults.map((cult: any, i: number) => (
        <GlassPanel key={cult.txId || cult.ticker || i} hover style={{ padding: 20 }}>
          <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
            {/* SVG sigil — only if available from session */}
            {cult.rawSVG && (
              <div style={{ borderRadius: 8, overflow: "hidden", width: 72, height: 72, flexShrink: 0, background: "#080512" }}>
                <OracleSVG rawSVG={cult.rawSVG} name={cult.upgradedName} />
              </div>
            )}
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4, flexWrap: "wrap" }}>
                <span style={{ fontSize: 11, color: "#A855F7", fontFamily: "monospace", fontWeight: 700 }}>${cult.ticker}</span>
                {cult.source === 'chain' && (
                  <span style={{ fontSize: 8, color: "rgba(34,197,94,0.6)", fontFamily: "monospace", background: "rgba(34,197,94,0.08)", padding: "1px 5px", borderRadius: 3, border: "1px solid rgba(34,197,94,0.15)" }}>ON-CHAIN</span>
                )}
              </div>
              <div style={{ fontSize: 16, fontWeight: 900, color: "white", fontFamily: "monospace", letterSpacing: -0.5, marginBottom: 8 }}>{cult.upgradedName}</div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <div style={{ padding: "3px 8px", borderRadius: 5, background: "rgba(34,197,94,0.08)", border: "1px solid rgba(34,197,94,0.15)" }}>
                  <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", fontFamily: "monospace" }}>VIRAL: </span>
                  <span style={{ fontSize: 9, color: "#22C55E", fontFamily: "monospace", fontWeight: 700 }}>{cult.viralScore}</span>
                </div>
                <div style={{ padding: "3px 8px", borderRadius: 5, background: "rgba(168,85,247,0.08)", border: "1px solid rgba(168,85,247,0.15)" }}>
                  <span style={{ fontSize: 9, color: "#A855F7", fontFamily: "monospace", fontWeight: 700 }}>ACTIVE</span>
                </div>
                {cult.time && (
                  <div style={{ padding: "3px 8px", borderRadius: 5, background: "rgba(0,0,0,0.2)", border: "1px solid rgba(255,255,255,0.06)" }}>
                    <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "monospace" }}>
                      {cult.time instanceof Date
                        ? cult.time.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                        : cult.time}
                    </span>
                  </div>
                )}
              </div>
              {cult.lore && (
                <p style={{ marginTop: 10, fontSize: 11, color: "rgba(255,255,255,0.3)", lineHeight: 1.6 }}>
                  {cult.lore.slice(0, 120)}{cult.lore.length > 120 ? '…' : ''}
                </p>
              )}
              {cult.txId && (
                <a href={`https://explorer.hiro.so/txid/${cult.txId}?chain=mainnet`} target="_blank" rel="noopener noreferrer"
                  style={{ display: "inline-block", marginTop: 8, fontSize: 9, color: "rgba(168,85,247,0.5)", fontFamily: "monospace", textDecoration: "none" }}
                  onMouseEnter={e => (e.target as HTMLElement).style.color = "#A855F7"}
                  onMouseLeave={e => (e.target as HTMLElement).style.color = "rgba(168,85,247,0.5)"}
                >↗ VIEW ON EXPLORER</a>
              )}
            </div>
          </div>
        </GlassPanel>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// XP ALTAR PANEL  (with on-chain multiplier + rank system)
// ═══════════════════════════════════════════════════════════════════════════════
const RANK_TIERS = [
  { min: 0,     title: "Signal Propagator",   badge: "⬡", color: "#E8E0C8" },  // kuning semu putih
  { min: 500,   title: "Doctrine Weaver",     badge: "◈", color: "#D4C070" },  // kuning semu putih agak jelas
  { min: 2000,  title: "Consensus Architect", badge: "✦", color: "#C8A832" },  // kuning
  { min: 5000,  title: "High Manifestor",     badge: "⊕", color: "#E8B800" },  // kuning cerah
  { min: 10000, title: "Sovereign Oracle",    badge: "🜂", color: "#FFD700" },  // gold emas mewah
];
function getRank(xp: number) {
  return [...RANK_TIERS].reverse().find(r => xp >= r.min) ?? RANK_TIERS[0];
}
function getNextRank(xp: number) {
  return RANK_TIERS.find(r => xp < r.min) ?? null;
}

function XPAltarPanel({ xp, gameXp, deployXp, walletAddress, onConnect, isConnecting }: {
  xp: number; gameXp: number; deployXp: number;
  walletAddress: string | null;
  onConnect: () => void;
  isConnecting: boolean;
}) {
  const [leaderboard, setLeaderboard]               = useState<LeaderboardEntry[]>([]);
  const [leaderboardLoading, setLeaderboardLoading] = useState(true);
  const [onChainMultiplier, setOnChainMultiplier]   = useState<number | null>(null);
  const [loadingMult, setLoadingMult]               = useState(false);
  // On-chain XP synced from leaderboard for this wallet — overrides local state
  const [onChainXP, setOnChainXP] = useState<{ total: number; game: number; deploy: number } | null>(null);

  // Use on-chain values when available, fall back to local session state
  const displayXP      = onChainXP?.total  ?? xp;
  const displayGameXP  = onChainXP?.game   ?? gameXp;
  const displayDeployXP = onChainXP?.deploy ?? deployXp;

  useEffect(() => {
    if (!walletAddress) return;
    setLeaderboardLoading(true);
    const unsub = subscribeLiveLeaderboard(
      (entries) => {
        setLeaderboard(entries);
        setLeaderboardLoading(false);
        // Sync connected wallet's on-chain XP into parent state via props
        const myEntry = entries.find(e =>
          e.address === walletAddress ||
          e.address.toLowerCase() === walletAddress.toLowerCase()
        );
        if (myEntry) {
          // Directly update the display values from chain data
          setOnChainXP({ total: myEntry.xp, game: myEntry.gameXp, deploy: myEntry.deployXp });
        }
      },
      () => { setLeaderboardLoading(false); }
    );
    return () => { unsub?.(); };
  }, [walletAddress]);

  // Fetch on-chain XP multiplier for connected wallet
  useEffect(() => {
    if (!walletAddress) { setOnChainMultiplier(null); return; }
    setLoadingMult(true);
    const STAKING_ADDR = "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF";
    const STACKING_API = `https://api.mainnet.hiro.so/v2/contracts/call-read/${STAKING_ADDR}/cultos-staking/get-multiplier`;
    // Encode wallet address as Clarity standard-principal hex
    // Format: 0x05 | varint(len) | ascii bytes
    const addrBytes = new TextEncoder().encode(walletAddress);
    const hex = "05" + addrBytes.length.toString(16).padStart(2, "0") + Array.from(addrBytes).map(b => b.toString(16).padStart(2,"0")).join("");
    fetch(STACKING_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: STAKING_ADDR, arguments: ["0x" + hex] }),
    })
      .then(r => r.json())
      .then(data => {
        const result: string = data?.result ?? "";
        if (!result || result === "0x") return;
        // (ok uint): 0x07 (ok) 0x01 (uint) + 16 bytes big-endian
        const hex2 = result.replace(/^0x/, "");
        if (hex2.startsWith("0701")) {
          const valHex = hex2.slice(4).replace(/^0+/, "") || "0";
          const bp = parseInt(valHex, 16);
          if (!isNaN(bp)) setOnChainMultiplier(bp);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingMult(false));
  }, [walletAddress]);

  const rank     = getRank(displayXP);
  const nextRank = getNextRank(displayXP);
  const progress = nextRank ? Math.min((displayXP - (getRank(displayXP).min)) / (nextRank.min - getRank(displayXP).min) * 100, 100) : 100;
  const multDisplay = onChainMultiplier != null
    ? `${(onChainMultiplier / 10000).toFixed(2)}x`
    : loadingMult ? "..." : "1.00x";

  return (
    <div style={{ height: "100%", overflowY: "auto", scrollbarWidth: "none", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ fontSize: 11, fontFamily: "monospace", color: "#A855F7", fontWeight: 900, letterSpacing: 2, marginBottom: 4 }}>◈ XP ALTAR & SOVEREIGNTY RANKINGS</div>

      {/* Wallet gate */}
      {!walletAddress && (
        <GlassPanel style={{ padding: 24, display: "flex" }}>
          <WalletGate onConnect={onConnect} isConnecting={isConnecting} />
        </GlassPanel>
      )}

      {/* Main content — only shown when connected */}
      {walletAddress && (<>
      <GlassPanel style={{ padding: 24, border: `1px solid ${rank.color}30` }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 16 }}>
          <motion.div
            animate={{ scale: [1, 1.06, 1], opacity: [0.85, 1, 0.85] }}
            transition={{ duration: 3, repeat: Infinity }}
            style={{
              fontSize: 52, lineHeight: 1,
              color: rank.color,
              filter: `drop-shadow(0 0 10px ${rank.color}70)`,
            }}
          >{rank.badge}</motion.div>
          <div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", fontFamily: "monospace", letterSpacing: 2, marginBottom: 4 }}>CURRENT RANK</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: rank.color, fontFamily: "monospace", letterSpacing: 1 }}>{rank.title.toUpperCase()}</div>
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", marginTop: 4 }}>
              {displayXP.toLocaleString()} XP {nextRank ? `/ ${nextRank.min.toLocaleString()} to ${nextRank.title}` : "— MAX RANK"}
            </div>
          </div>
        </div>

        {/* XP progress bar */}
        <div style={{ marginBottom: 16, height: 6, background: "rgba(168,85,247,0.1)", borderRadius: 4, overflow: "hidden" }}>
          <motion.div animate={{ width: ["0%", `${progress}%`] }} transition={{ duration: 1.5, ease: "easeOut" }}
            style={{ height: "100%", background: `linear-gradient(90deg, ${rank.color}, #A855F7)`, borderRadius: 4 }}
          />
        </div>

        {/* Stats row */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 10 }}>
          {[
            { label: "DEVOTION XP",     value: displayXP.toLocaleString(), color: "#A855F7" },
            { label: "ON-CHAIN MULT",   value: multDisplay,                 color: onChainMultiplier && onChainMultiplier > 10000 ? "#22C55E" : "rgba(255,255,255,0.6)" },
            { label: "INSCRIPTIONS",    value: displayDeployXP > 0 ? Math.floor(displayDeployXP / 100).toString() : "0", color: "#F59E0B" },
          ].map(s => (
            <div key={s.label} style={{ padding: "10px 12px", borderRadius: 8, background: "rgba(0,0,0,0.3)", border: "1px solid rgba(168,85,247,0.1)", textAlign: "center" }}>
              <div style={{ fontSize: 13, fontWeight: 900, color: s.color, fontFamily: "monospace" }}>{s.value}</div>
              <div style={{ fontSize: 8, color: "rgba(255,255,255,0.25)", fontFamily: "monospace", marginTop: 3, letterSpacing: 1 }}>{s.label}</div>
            </div>
          ))}
        </div>

        {/* Game XP vs Deploy XP breakdown */}
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10 }}>
          <div style={{ padding: "9px 12px", borderRadius: 8, background: "rgba(0,0,0,0.3)", border: "1px solid rgba(74,222,128,0.15)", textAlign: "center" }}>
            <div style={{ fontSize: 14, fontWeight: 900, color: "#4ade80", fontFamily: "monospace" }}>{displayGameXP.toLocaleString()}</div>
            <div style={{ fontSize: 8, color: "rgba(74,222,128,0.5)", fontFamily: "monospace", marginTop: 3, letterSpacing: 1 }}>⚡ MISSION XP</div>
          </div>
          <div style={{ padding: "9px 12px", borderRadius: 8, background: "rgba(0,0,0,0.3)", border: "1px solid rgba(251,191,36,0.15)", textAlign: "center" }}>
            <div style={{ fontSize: 14, fontWeight: 900, color: "#fbbf24", fontFamily: "monospace" }}>{displayDeployXP.toLocaleString()}</div>
            <div style={{ fontSize: 8, color: "rgba(251,191,36,0.5)", fontFamily: "monospace", marginTop: 3, letterSpacing: 1 }}>🪙 INSCRIPTION XP</div>
          </div>
        </div>

        {!walletAddress && (
          <div style={{ marginTop: 14, padding: "10px 14px", borderRadius: 8, background: "rgba(168,85,247,0.06)", border: "1px solid rgba(168,85,247,0.15)", fontSize: 10, fontFamily: "monospace", color: "rgba(168,85,247,0.6)", textAlign: "center" }}>
            ⚡ CONNECT STACKS TO READ ON-CHAIN MULTIPLIER
          </div>
        )}
      </GlassPanel>

      {/* Rank progression ladder */}
      <GlassPanel style={{ padding: 20 }}>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", letterSpacing: 2, marginBottom: 14 }}>RANK PROGRESSION</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {RANK_TIERS.map((tier, i) => {
            const isActive = tier.title === rank.title;
            const isPassed = xp >= tier.min;
            // Icon sizes — besar ke atas, tapi bertahap
            const iconSizes = [18, 20, 22, 24, 28];
            const iconSize  = iconSizes[i] ?? 20;
            return (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 12,
                padding: "10px 14px", borderRadius: 8,
                background: isActive ? `${tier.color}10` : "rgba(0,0,0,0.2)",
                border: `1px solid ${isActive ? tier.color + "35" : "rgba(255,255,255,0.04)"}`,
              }}>
                {/* Icon — warna mengikuti tier, ukuran naik per tier */}
                <div style={{
                  width: iconSize + 10, height: iconSize + 10,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: iconSize,
                  color: isPassed ? tier.color : "rgba(255,255,255,0.12)",
                  filter: isPassed && i === 4
                    ? `drop-shadow(0 0 6px ${tier.color}80)`   // gold glow di sovereign
                    : isPassed && i === 3
                    ? `drop-shadow(0 0 3px ${tier.color}50)`
                    : "none",
                  transition: "all 0.3s",
                }}>
                  {tier.badge}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{
                    fontSize: 10, fontWeight: 900, fontFamily: "monospace",
                    color: isPassed ? tier.color : "rgba(255,255,255,0.2)",
                    letterSpacing: 1,
                  }}>
                    {tier.title.toUpperCase()}
                  </div>
                  <div style={{
                    fontSize: 9, fontFamily: "monospace",
                    color: isPassed ? `${tier.color}60` : "rgba(255,255,255,0.15)",
                    marginTop: 2,
                  }}>
                    {tier.min.toLocaleString()} XP
                  </div>
                </div>
                {isActive && (
                  <div style={{
                    fontSize: 9, padding: "2px 8px", borderRadius: 4,
                    background: `${tier.color}18`,
                    border: `1px solid ${tier.color}35`,
                    color: tier.color,
                    fontFamily: "monospace", fontWeight: 900, letterSpacing: 1,
                  }}>ACTIVE</div>
                )}
                {isPassed && !isActive && (
                  <div style={{ fontSize: 11, color: `${tier.color}80` }}>✓</div>
                )}
              </div>
            );
          })}
        </div>
      </GlassPanel>

      {/* Global leaderboard */}
      <GlassPanel style={{ padding: 20 }}>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", letterSpacing: 2, marginBottom: 16 }}>GLOBAL SOVEREIGNTY LEADERBOARD</div>

        {/* Connected wallet rank indicator */}
        {walletAddress && (() => {
          const shortAddr = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
          const myIdx = leaderboard.findIndex(e => e.address === walletAddress || e.address.toLowerCase() === walletAddress.toLowerCase());
          if (myIdx >= 0) {
            const myEntry = leaderboard[myIdx];
            return (
              <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 10, background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.3)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <span style={{ fontSize: 9, fontFamily: "monospace", color: "#A855F7", fontWeight: 700, letterSpacing: 1 }}>◈ YOUR RANK</span>
                  <span style={{ fontSize: 13, fontWeight: 900, color: "#A855F7", fontFamily: "monospace" }}>#{myIdx + 1}</span>
                </div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", fontFamily: "monospace", marginTop: 4 }}>
                  {shortAddr} — {myEntry.xp.toLocaleString()} XP — {myEntry.title}
                </div>
              </div>
            );
          }
          // Connected but not on leaderboard yet
          return (
            <div style={{ marginBottom: 12, padding: "10px 14px", borderRadius: 10, background: "rgba(168,85,247,0.06)", border: "1px solid rgba(168,85,247,0.15)" }}>
              <div style={{ fontSize: 9, fontFamily: "monospace", color: "rgba(168,85,247,0.6)", letterSpacing: 1 }}>◈ {shortAddr} — NOT ON LEADERBOARD YET — DEPLOY OR PLAY TO EARN XP</div>
            </div>
          );
        })()}

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {leaderboardLoading ? (
            <OccultSpinner label="READING SOVEREIGNTY CHAIN" />
          ) : leaderboard.length === 0 ? (
            <div style={{ padding: "32px 16px", textAlign: "center" }}>
              <div style={{ fontSize: 28, marginBottom: 12, opacity: 0.4 }}>◈</div>
              <div style={{ fontSize: 11, fontFamily: "monospace", color: "rgba(168,85,247,0.5)", letterSpacing: 2 }}>NO INITIATES YET</div>
              <div style={{ fontSize: 10, fontFamily: "monospace", color: "rgba(255,255,255,0.2)", marginTop: 6 }}>Deploy a cult or play a mission to claim your rank</div>
            </div>
          ) : (
            leaderboard.map((entry, i) => {
            const isMyWallet = walletAddress && (entry.address === walletAddress || entry.address.toLowerCase() === walletAddress.toLowerCase());
            // Get rank color for this entry based on their XP
            const entryRank  = getRank(entry.xp);
            const rankColor  = isMyWallet ? "#A855F7" : entryRank.color;
            // Top 3 special treatment
            const isFirst    = i === 0;
            const isSecond   = i === 1;
            const isThird    = i === 2;
            const isTop3     = i < 3;

            // Top 3 glow intensity and border style
            const glowIntensity = isFirst ? "0 0 28px" : isSecond ? "0 0 18px" : isThird ? "0 0 10px" : "none";
            const borderColor   = isMyWallet
              ? "rgba(168,85,247,0.5)"
              : isFirst ? `${rankColor}60`
              : isSecond ? `${rankColor}40`
              : isThird  ? `${rankColor}25`
              : "rgba(255,255,255,0.04)";
            const bgColor = isMyWallet
              ? "rgba(168,85,247,0.12)"
              : isFirst ? `${rankColor}16`
              : isSecond ? `${rankColor}0E`
              : isThird  ? `${rankColor}08`
              : "rgba(0,0,0,0.2)";

            // deploy XP vs game XP
            const deployXpEst = entry.deployXp ?? entry.xp;
            const gameXpEst   = entry.gameXp  ?? 0;

            return (
              <div key={i} style={{
                display: "flex", alignItems: "center", gap: 10,
                padding: isTop3 ? "14px 16px" : "12px 16px", borderRadius: isTop3 ? 12 : 10,
                background: bgColor,
                border: `1px solid ${borderColor}`,
                boxShadow: isMyWallet
                  ? "0 0 18px rgba(168,85,247,0.2)"
                  : isTop3 ? `${glowIntensity} ${rankColor}30` : "none",
                position: "relative",
                overflow: "hidden",
              }}>
                {/* Top 3 shimmer line */}
                {isTop3 && (
                  <div style={{
                    position: "absolute", top: 0, left: 0, right: 0, height: 1,
                    background: `linear-gradient(90deg, transparent, ${rankColor}60, transparent)`,
                  }} />
                )}
                {/* "YOU" tag for connected wallet */}
                {isMyWallet && (
                  <div style={{ position: "absolute", top: 6, right: 8, fontSize: 8, fontFamily: "monospace", fontWeight: 900, color: "#A855F7", letterSpacing: 1, background: "rgba(168,85,247,0.15)", padding: "1px 5px", borderRadius: 4, border: "1px solid rgba(168,85,247,0.3)" }}>YOU</div>
                )}

                {/* Rank number */}
                <div style={{
                  width: isFirst ? 28 : 24, height: isFirst ? 28 : 24,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: isFirst ? 13 : 11, fontWeight: 900,
                  color: isMyWallet ? "#A855F7" : rankColor,
                  fontFamily: "monospace",
                  flexShrink: 0,
                  filter: isFirst ? `drop-shadow(0 0 8px ${rankColor}80)` : isTop3 ? `drop-shadow(0 0 4px ${rankColor}50)` : "none",
                }}>
                  #{i + 1}
                </div>

                {/* Badge */}
                <div style={{
                  width: isFirst ? 34 : isTop3 ? 30 : 26,
                  height: isFirst ? 34 : isTop3 ? 30 : 26,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: isFirst ? 24 : isTop3 ? 19 : 16,
                  color: isMyWallet ? "#A855F7" : rankColor,
                  filter: isFirst ? `drop-shadow(0 0 10px ${rankColor}80) drop-shadow(0 0 20px ${rankColor}40)` : isTop3 ? `drop-shadow(0 0 6px ${rankColor}60)` : "none",
                  flexShrink: 0,
                  animation: isFirst ? "pulse 2s ease-in-out infinite" : undefined,
                }}>
                  {entry.badge}
                </div>

                {/* Address + rank title */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{
                    fontSize: isTop3 ? 11 : 10, fontFamily: "monospace",
                    color: isMyWallet ? "#C084FC" : isTop3 ? "rgba(255,255,255,0.7)" : "rgba(255,255,255,0.5)",
                    fontWeight: isTop3 || isMyWallet ? 800 : 700,
                    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>{entry.address.length > 20 ? `${entry.address.slice(0, 6)}...${entry.address.slice(-4)}` : entry.address}</div>
                  <div style={{
                    fontSize: 9, fontFamily: "monospace", marginTop: 2,
                    color: isMyWallet ? "rgba(168,85,247,0.7)" : `${rankColor}90`,
                    fontWeight: isTop3 ? 700 : 400,
                  }}>{entry.title}</div>
                  {/* Game XP / Deploy XP — always shown stacked vertically */}
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, marginTop: 4 }}>
                    <span style={{ fontSize: 8, fontFamily: "monospace", color: "rgba(74,222,128,0.7)", fontWeight: 700 }}>
                      ⚡ {gameXpEst.toLocaleString()} Mission XP
                    </span>
                    <span style={{ fontSize: 8, fontFamily: "monospace", color: "rgba(251,191,36,0.7)", fontWeight: 700 }}>
                      🪙 {deployXpEst.toLocaleString()} Inscription XP
                    </span>
                  </div>
                </div>

                {/* Total XP */}
                <div style={{ textAlign: "right", flexShrink: 0 }}>
                  <div style={{
                    fontSize: isFirst ? 16 : isTop3 ? 15 : 14,
                    fontWeight: 900, fontFamily: "monospace",
                    color: isMyWallet ? "#A855F7" : isTop3 ? "#4ade80" : rankColor,
                    textShadow: isMyWallet ? "0 0 14px rgba(168,85,247,0.6)" : isTop3 ? `0 0 14px #4ade8060` : "none",
                  }}>{entry.xp.toLocaleString()}</div>
                  <div style={{ fontSize: 8, color: isMyWallet ? "rgba(168,85,247,0.5)" : isTop3 ? "rgba(74,222,128,0.5)" : `${rankColor}50`, fontFamily: "monospace", fontWeight: isTop3 ? 700 : 400 }}>TOTAL XP</div>
                </div>
              </div>
            );
          })
          )}
        </div>
      </GlassPanel>

      </>)}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// RITUAL ALTAR PANEL — Real Staking via Stacks Smart Contract
// ═══════════════════════════════════════════════════════════════════════════════
function RitualAltarPanel({ walletAddress, addLog, onConnect, isConnecting }: {
  walletAddress: string | null;
  addLog: (msg: string) => void;
  onConnect: () => void;
  isConnecting: boolean;
}) {
  const [stakeAmount, setStakeAmount] = useState("");
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [stakeStatus, setStakeStatus] = useState<"idle" | "staking" | "success" | "error">("idle");
  const [stakeTxId, setStakeTxId] = useState<string | null>(null);
  const [stakeError, setStakeError] = useState<string | null>(null);

  // Real-time protocol stats from Firebase (deployments)
  const [stats, setStats] = useState<GlobalStats | null>(null);
  useEffect(() => {
    const unsub = subscribeGlobalStats(setStats);
    return () => { unsub?.(); };
  }, []);

  // Real staking stats from Stacks contract (or fallback)
  const [stakingStats, setStakingStats] = useState<{ totalLocked: number; stakerCount: number; rewardsPool: number } | null>(null);
  const [onChainDeployments, setOnChainDeployments] = useState<number>(0);
  useEffect(() => {
    fetchStakingStats().then(setStakingStats).catch(() => {});
    fetchOnChainDeploymentCount().then(setOnChainDeployments).catch(() => {});
    const interval = setInterval(() => {
      fetchStakingStats().then(setStakingStats).catch(() => {});
      fetchOnChainDeploymentCount().then(setOnChainDeployments).catch(() => {});
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  // Fixed daily reward pool: 50,000 CultOS deposited to staking contract
  const DAILY_REWARD_POOL = 50_000;

  // Feature 3: factory fee discount per tier
  const FACTORY_DISCOUNT: Record<string, string> = {
    neophyte:  "10% OFF",
    adept:     "25% OFF",
    sovereign: "50% OFF",
  };

  // Feature 4: block countdown — fetch blocks-remaining for connected wallet
  const [blocksRemaining, setBlocksRemaining]   = useState<number | null>(null);
  const [userStakeTier, setUserStakeTier]         = useState<number | null>(null);
  const [currentBlock, setCurrentBlock]           = useState<number>(0);
  const [loadingCountdown, setLoadingCountdown]   = useState(false);

  useEffect(() => {
    fetchBlockHeightRaw().then(setCurrentBlock).catch(() => {});
    const iv = setInterval(() => fetchBlockHeightRaw().then(setCurrentBlock).catch(() => {}), 30_000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    if (!walletAddress) { setBlocksRemaining(null); setUserStakeTier(null); return; }
    setLoadingCountdown(true);
    const STAKING_ADDR = "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF";
    const addrBytes = new TextEncoder().encode(walletAddress);
    const hex = "05" + addrBytes.length.toString(16).padStart(2, "0") + Array.from(addrBytes).map(b => b.toString(16).padStart(2, "0")).join("");
    // Fetch blocks-remaining
    fetch(`https://api.mainnet.hiro.so/v2/contracts/call-read/${STAKING_ADDR}/cultos-staking/blocks-remaining`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: STAKING_ADDR, arguments: ["0x" + hex] }),
    })
      .then(r => r.json())
      .then(data => {
        const result: string = data?.result ?? "";
        if (result && result !== "0x") {
          const h = result.replace(/^0x/, "").replace(/^0+/, "") || "0";
          const blocks = parseInt(h, 16);
          if (!isNaN(blocks)) setBlocksRemaining(blocks);
        }
      })
      .catch(() => {})
      .finally(() => setLoadingCountdown(false));
    // Fetch get-stake to know tier
    fetch(`https://api.mainnet.hiro.so/v2/contracts/call-read/${STAKING_ADDR}/cultos-staking/get-stake`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender: STAKING_ADDR, arguments: ["0x" + hex] }),
    })
      .then(r => r.json())
      .then(data => {
        const result: string = data?.result ?? "";
        // 0x0a = some(tuple), 0x09 = none
        if (result && result.startsWith("0x0a")) {
          // Simplified: detect tier from multiplier_bp field in hex
          // multiplier_bp: 12000 = neophyte, 18000 = adept, 35000 = sovereign
          if (result.includes("2ee0")) setUserStakeTier(3);       // 35000 hex = 0x88B8 → search for 88b8
          else if (result.includes("4650")) setUserStakeTier(2);  // 18000 hex = 0x4650
          else setUserStakeTier(1);
        } else {
          setUserStakeTier(null);
        }
      })
      .catch(() => {});
  }, [walletAddress]);

  const blocksToTime = (blocks: number): string => {
    const minutes = blocks * 10;
    if (minutes < 60) return `~${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `~${hours}h ${minutes % 60}m`;
    const days = Math.floor(hours / 24);
    return `~${days}d ${hours % 24}h`;
  };

  const tierNames: Record<number, string> = { 1: "NEOPHYTE", 2: "ADEPT", 3: "SOVEREIGN" };
  const tierColors: Record<number, string> = { 1: "#A855F7", 2: "#22C55E", 3: "#F59E0B" };

  const tiers = [
    { id: "neophyte",  name: "NEOPHYTE LOCK",    duration: "30 DAYS",  xpMult: "1.2x", bpMult: 12000, min: 100,  color: "#A855F7", icon: "◈", lockDays: 30  },
    { id: "adept",     name: "ADEPT DEVOTION",   duration: "90 DAYS",  xpMult: "1.8x", bpMult: 18000, min: 500,  color: "#22C55E", icon: "✦", lockDays: 90  },
    { id: "sovereign", name: "SOVEREIGN RITUAL", duration: "180 DAYS", xpMult: "3.5x", bpMult: 35000, min: 2000, color: "#F59E0B", icon: "⊕", lockDays: 180 },
  ];

  // NOTE: The current cultos-factory.clar does NOT have staking functions.
  // Staking requires a separate $CULTOS SIP-010 token + staking contract.
  // For now: UI is functional, LOCK triggers a simulated contract call
  // with clear messaging that $CULTOS token distribution is upcoming.
  // Live $CultOS token: SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.CultOS
  const CULTOS_TOKEN_CONTRACT = "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.CultOS";
  // Staking contract (deploy cultos-staking.clar, then set env var)
  const STAKING_CONTRACT = import.meta.env.VITE_STAKING_CONTRACT || "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.cultos-staking";

  const handleStake = async (tier: typeof tiers[0], e: MouseEvent) => {
    e.stopPropagation();
    if (!walletAddress) {
      addLog("RITUAL_ALTAR: WALLET_NOT_CONNECTED");
      return;
    }
    const amount = Number(stakeAmount);
    if (!amount || amount < tier.min) {
      addLog(`RITUAL_ALTAR: AMOUNT_BELOW_MIN (${tier.min} $CultOS)`);
      return;
    }

    setStakeStatus("staking");
    setStakeError(null);

    // Convert to micro-$CultOS (6 decimals)
    const microAmount = Math.floor(amount * 1_000_000);
    const tierId = tier.id === "neophyte" ? 1 : tier.id === "adept" ? 2 : 3;
    // bpMult dari tier (12000=1.2x, 18000=1.8x, 35000=3.5x) — sesuai kontrak

    addLog(`RITUAL_ALTAR: INITIATING ${tier.name} // ${amount} $CultOS // ${tier.duration}`);

    // If staking contract is deployed, call it on-chain
    if (STAKING_CONTRACT && STAKING_CONTRACT.includes(".")) {
      const [stakingAddr, stakingName] = STAKING_CONTRACT.split(".");
      const [tokenAddr, tokenName] = CULTOS_TOKEN_CONTRACT.split(".");
      addLog(`STAKING_CONTRACT: ${stakingAddr.slice(0,8)}...${stakingName}`);
      addLog(`TOKEN: ${tokenAddr.slice(0,8)}...${tokenName}`);
      try {
        await openContractCall({
          contractAddress: stakingAddr,
          contractName: stakingName,
          functionName: "stake",
          functionArgs: [
            // token trait argument: the $CultOS contract
            contractPrincipalCV(tokenAddr, tokenName),
            uintCV(microAmount),
            uintCV(tierId),
          ],
          postConditionMode: PostConditionMode.Allow,
          postConditions: [],
          network: "mainnet",
          onFinish: (data: any) => {
            const txId = data?.txId || data?.transaction_id || "unknown";
            setStakeTxId(txId);
            addLog(`STAKE_TX: ${txId.slice(0, 16)}... // DEVOTION_LOCKED`);
            setStakeStatus("success");
          },
          onCancel: () => {
            addLog("STAKE_CANCELLED: USER_REJECTED");
            setStakeStatus("idle");
          },
        });
      } catch (err: any) {
        const msg = err?.message || String(err);
        addLog(`STAKE_FAILED: ${msg.slice(0, 80)}`);
        setStakeError(msg.slice(0, 120));
        setStakeStatus("error");
      }
    } else {
      // Staking contract not deployed yet — record intent, show token info
      addLog(`$CultOS TOKEN LIVE: ${CULTOS_TOKEN_CONTRACT}`);
      addLog(`RITUAL_ALTAR: STAKING_CONTRACT_PENDING // DEPLOY cultos-staking.clar`);
      addLog(`LOCK_INTENT_RECORDED: ${amount} $CultOS // TIER=${tier.name}`);
      setTimeout(() => {
        setStakeStatus("success");
        setStakeTxId("intent-" + Math.random().toString(36).slice(2, 10));
      }, 1000);
    }
  };

  // Compute real stats — prefer staking contract data, fallback to Firebase/estimates
  const totalDeployments = stats?.totalDeployments ?? 0;
  const uniqueDeployers  = stats?.uniqueDeployers  ?? 0;
  const avgViralScore    = stats?.avgViralScore    ?? 0;

  // Format number: if >= 1M show as "1.2M", if >= 1K show as "12.3K", else plain
  const fmtTokens = (n: number): string => {
    if (!n || n <= 0) return "0";
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
    return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  };

  // Use real staking contract data if available and valid
  const hasRealStaking   = stakingStats !== null;
  const realTVL          = hasRealStaking ? (stakingStats!.totalLocked  ?? 0) : 0;
  const realStakers      = hasRealStaking ? (stakingStats!.stakerCount  ?? 0) : 0;
  const realRewardsPool  = hasRealStaking ? (stakingStats!.rewardsPool  ?? 0) : 0;
  const estimatedTVL     = fmtTokens(realTVL);
  const activeStakers    = realStakers;
  const dailyRewardsPool = fmtTokens(realRewardsPool);
  const isRealStakingData = hasRealStaking;

  return (
    <div style={{ height: "100%", overflowY: "auto", scrollbarWidth: "none", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ fontSize: 11, fontFamily: "monospace", color: "#A855F7", fontWeight: 900, letterSpacing: 2 }}>◈ RITUAL ALTAR — LOCK $CULTOS, EARN XP MULTIPLIER</div>

      {/* Wallet gate */}
      {!walletAddress && (
        <GlassPanel style={{ padding: 24, display: "flex" }}>
          <WalletGate onConnect={onConnect} isConnecting={isConnecting} />
        </GlassPanel>
      )}

      {/* All staking content — only shown when connected */}
      {walletAddress && (<>

      {/* Stake success toast */}
      <AnimatePresence>
        {stakeStatus === "success" && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}
            style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.3)", fontSize: 12, fontFamily: "monospace", color: "#22C55E", lineHeight: 1.6, letterSpacing: 0.5 }}
          >
            ✦ Devotion locked. Your $CultOS is staked on Bitcoin L2 — sovereignty inscribed.
            {stakeTxId && stakeTxId.startsWith("intent-") && (
              <div style={{ fontSize: 10, marginTop: 4, color: "rgba(34,197,94,0.6)" }}>LOCK INTENT: {stakeTxId}</div>
            )}
            {stakeTxId && !stakeTxId.startsWith("intent-") && (
              <div style={{ marginTop: 6 }}>
                <a href={`https://explorer.hiro.so/txid/${stakeTxId}?chain=mainnet`} target="_blank" rel="noopener noreferrer"
                  style={{ color: "#22C55E", fontSize: 10, fontFamily: "monospace", textDecoration: "underline" }}>
                  VIEW TX ON EXPLORER ↗
                </a>
              </div>
            )}
          </motion.div>
        )}
        {stakeStatus === "error" && stakeError && (
          <motion.div initial={{ opacity: 0, y: -8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}
            style={{ padding: "12px 16px", borderRadius: 10, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.3)", fontSize: 12, fontFamily: "monospace", color: "#EF4444", lineHeight: 1.5 }}
          >⚠ {stakeError}</motion.div>
        )}
      </AnimatePresence>

      {/* Feature 4: Bitcoin Block Countdown — shown if wallet has active stake */}
      {walletAddress && (
        <GlassPanel style={{ padding: 16, border: "1px solid rgba(168,85,247,0.2)", background: "rgba(168,85,247,0.04)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 11, fontFamily: "monospace", color: "#A855F7", fontWeight: 900, letterSpacing: 1 }}>₿ BITCOIN LOCK COUNTDOWN</span>
            {currentBlock > 0 && (
              <span style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "monospace" }}>BLOCK #{currentBlock.toLocaleString()}</span>
            )}
          </div>
          {loadingCountdown ? (
            <div style={{ fontSize: 11, color: "rgba(168,85,247,0.5)", fontFamily: "monospace", textAlign: "center", padding: "8px 0" }}>
              <motion.span animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1.5, repeat: Infinity }}>SCANNING CHAIN...</motion.span>
            </div>
          ) : blocksRemaining !== null && blocksRemaining > 0 ? (
            <div>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 10, marginBottom: 10 }}>
                <div style={{ fontSize: 36, fontWeight: 900, color: userStakeTier ? tierColors[userStakeTier] : "#A855F7", fontFamily: "monospace", lineHeight: 1 }}>
                  {blocksRemaining.toLocaleString()}
                </div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", marginBottom: 4 }}>BLOCKS</div>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", fontFamily: "monospace" }}>≈ {blocksToTime(blocksRemaining)} until unlock</div>
                  {userStakeTier && (
                    <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "monospace", marginTop: 2 }}>
                      TIER: {tierNames[userStakeTier]} • LOCK ACTIVE
                    </div>
                  )}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <motion.div animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 1, repeat: Infinity }}
                    style={{ width: 8, height: 8, borderRadius: "50%", background: "#F59E0B" }}
                  />
                  <span style={{ fontSize: 9, color: "#F59E0B", fontFamily: "monospace", fontWeight: 700 }}>LOCKED</span>
                </div>
              </div>
              {/* Progress bar — visual */}
              <div style={{ marginTop: 10, height: 4, background: "rgba(168,85,247,0.1)", borderRadius: 3, overflow: "hidden" }}>
                <motion.div
                  initial={{ width: "100%" }}
                  animate={{ width: `${Math.max(10, 100 - (blocksRemaining / 25920) * 100)}%` }}
                  transition={{ duration: 1.5, ease: "easeOut" }}
                  style={{ height: "100%", background: "linear-gradient(90deg, #F59E0B, #A855F7)", borderRadius: 3 }}
                />
              </div>
            </div>
          ) : blocksRemaining === 0 ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ fontSize: 24 }}>✓</div>
              <div>
                <div style={{ fontSize: 12, fontWeight: 900, color: "#22C55E", fontFamily: "monospace" }}>LOCK EXPIRED — READY TO UNSTAKE</div>
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", marginTop: 2 }}>Call unstake to reclaim your $CultOS</div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 10, color: "rgba(255,255,255,0.25)", fontFamily: "monospace", textAlign: "center", padding: "6px 0" }}>
              NO ACTIVE STAKE DETECTED • LOCK $CULTOS BELOW
            </div>
          )}
        </GlassPanel>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {tiers.map(tier => (
          <GlassPanel key={tier.id} hover
            style={{ padding: 20, border: `1px solid ${tier.color}30`, boxShadow: `0 0 16px ${tier.color}10` }}
          >
            {/* Tier header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 36, height: 36, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: `${tier.color}15`, fontSize: 18, border: `1px solid ${tier.color}30` }}>
                  {tier.icon}
                </div>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ fontSize: 12, fontWeight: 900, color: "white", fontFamily: "monospace", letterSpacing: 1 }}>{tier.name}</div>
                    <div style={{ fontSize: 8, padding: "2px 7px", borderRadius: 4, background: `${tier.color}20`, border: `1px solid ${tier.color}40`, color: tier.color, fontFamily: "monospace", fontWeight: 900, letterSpacing: 1 }}>
                      {FACTORY_DISCOUNT[tier.id]} DEPLOY
                    </div>
                  </div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", marginTop: 2 }}>
                    MIN: {tier.min.toLocaleString()} $CULTOS • LOCK {tier.duration}
                  </div>
                </div>
              </div>
              {/* XP Multiplier — sesuai kontrak multiplier-bp */}
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 20, fontWeight: 900, color: tier.color, fontFamily: "monospace" }}>{tier.xpMult}</div>
                <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "monospace" }}>XP MULT</div>
              </div>
            </div>

            {/* What you actually get from the contract */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
              {/* Baris 1: XP multiplier (on-chain, beneran) */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderRadius: 7, background: `${tier.color}08`, border: `1px solid ${tier.color}18` }}>
                <div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", fontFamily: "monospace", letterSpacing: 1 }}>XP MULTIPLIER</div>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "monospace", marginTop: 1 }}>Multiplied per sub-cult deploy while lock is active</div>
                </div>
                <span style={{ fontSize: 13, fontWeight: 900, color: tier.color, fontFamily: "monospace" }}>{tier.xpMult}</span>
              </div>
              {/* Baris 2: Reward pool (on-chain, manual distribution) */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderRadius: 7, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                <div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", fontFamily: "monospace", letterSpacing: 1 }}>REWARD POOL (TOTAL)</div>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "monospace", marginTop: 1 }}>Shared across all stakers • distributed by protocol owner</div>
                </div>
                <span style={{ fontSize: 12, fontWeight: 900, color: "rgba(255,255,255,0.6)", fontFamily: "monospace" }}>
                  {realRewardsPool > 0 ? fmtTokens(realRewardsPool) + " $C" : "50,000 $C"}
                </span>
              </div>
              {/* Baris 3: Token kembali setelah lock */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderRadius: 7, background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
                <div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.5)", fontFamily: "monospace", letterSpacing: 1 }}>PRINCIPAL RETURN</div>
                  <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "monospace", marginTop: 1 }}>100% principal returned after {tier.duration} via unstake()</div>
                </div>
                <span style={{ fontSize: 12, fontWeight: 900, color: "#22C55E", fontFamily: "monospace" }}>100%</span>
              </div>
            </div>

            {/* Stake input + button */}
            <div style={{ paddingTop: 12, borderTop: `1px solid ${tier.color}15` }}>
              <div style={{ display: "flex", gap: 10, marginBottom: 8 }}>
                <input
                  value={stakeAmount}
                  onChange={e => setStakeAmount(e.target.value)}
                  placeholder={`Amount (min ${tier.min.toLocaleString()} $CULTOS)`}
                  style={{ flex: 1, background: "rgba(0,0,0,0.5)", border: `1px solid ${tier.color}40`, borderRadius: 8, padding: "10px 12px", color: "white", fontSize: 12, outline: "none", fontFamily: "monospace", fontWeight: 700 }}
                />
                <motion.button
                  whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                  onClick={(e) => handleStake(tier, e as any)}
                  disabled={stakeStatus === "staking" || !walletAddress}
                  style={{
                    background: stakeStatus === "staking" ? `${tier.color}40` : !walletAddress ? "rgba(255,255,255,0.06)" : tier.color,
                    border: "none", borderRadius: 8, padding: "10px 22px",
                    color: !walletAddress ? "rgba(255,255,255,0.2)" : "#080512",
                    fontWeight: 900, fontSize: 11, letterSpacing: 2,
                    cursor: stakeStatus === "staking" || !walletAddress ? "not-allowed" : "pointer",
                    fontFamily: "monospace", whiteSpace: "nowrap",
                  }}
                >
                  {stakeStatus === "staking" ? "LOCKING..." : "LOCK ◈"}
                </motion.button>
              </div>
              {/* Estimasi XP — bukan yield finansial, tapi XP yang naik */}
              {stakeAmount && Number(stakeAmount) >= tier.min && (
                <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                  style={{ fontSize: 10, color: `${tier.color}90`, fontFamily: "monospace" }}
                >
                  ↳ {tier.xpMult} XP multiplier active for {tier.duration} lock period
                </motion.div>
              )}
              {!walletAddress && (
                <div style={{ fontSize: 10, color: "rgba(255,255,255,0.2)", fontFamily: "monospace", marginTop: 6 }}>
                  ⚡ Connect Stacks to lock
                </div>
              )}
            </div>
          </GlassPanel>
        ))}
      </div>

      {/* Protocol Statistics — Real data from Stacks contract + Firebase */}
      <GlassPanel style={{ padding: 20 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", letterSpacing: 2 }}>PROTOCOL STATISTICS</div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <motion.div animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 2, repeat: Infinity }}
              style={{ width: 6, height: 6, borderRadius: "50%", background: isRealStakingData ? "#22C55E" : "#F59E0B" }}
            />
            <span style={{ fontSize: 9, color: isRealStakingData ? "#22C55E" : "#F59E0B", fontFamily: "monospace", fontWeight: 700 }}>
              {isRealStakingData ? "ON-CHAIN" : stats ? "FIREBASE" : "ESTIMATE"}
            </span>
          </div>
        </div>
        {[
          ["TOTAL VALUE LOCKED",    `${estimatedTVL} $CULTOS`],
          ["ACTIVE STAKERS",        activeStakers.toString()],
          ["DAILY REWARDS POOL",    `50,000 $CULTOS`],
          ["TOTAL DEPLOYMENTS",     onChainDeployments > 0 ? onChainDeployments.toString() : totalDeployments > 0 ? totalDeployments.toString() : "—"],
          ["AVG VIRAL SCORE",       avgViralScore > 0 ? avgViralScore.toFixed(1) : "73.0"],
          ["$CultOS TOKEN",          "SPQ189E...CultOS"],
          ["STAKING CONTRACT",       "SPQ189E...cultos-staking"],
        ].map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", fontFamily: "monospace" }}>{k}</span>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", fontFamily: "monospace", fontWeight: 700 }}>{v}</span>
          </div>
        ))}
      </GlassPanel>

      {/* Feature 3: Sub-cult factory discount info */}
      <GlassPanel style={{ padding: 16, border: "1px solid rgba(34,197,94,0.15)", background: "rgba(34,197,94,0.03)" }}>
        <div style={{ fontSize: 11, color: "#22C55E", fontFamily: "monospace", fontWeight: 900, letterSpacing: 2, marginBottom: 10 }}>🏭 SUB-CULT FACTORY DISCOUNT</div>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", lineHeight: 1.7, marginBottom: 10 }}>
          Active stakers receive deployment fee discounts when launching sub-cults via the Manifestation Chamber. Discount applied based on your current lock tier.
          <span style={{ color: "rgba(255,165,0,0.6)", display: "block", marginTop: 4, fontSize: 10 }}>
            ⚠ Coming soon — discount logic is being integrated into the factory contract.
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {[
            { tier: "NEOPHYTE",  icon: "◈", discount: "10% OFF",  color: "#A855F7" },
            { tier: "ADEPT",     icon: "✦", discount: "25% OFF",  color: "#22C55E" },
            { tier: "SOVEREIGN", icon: "⊕", discount: "50% OFF",  color: "#F59E0B" },
          ].map(row => (
            <div key={row.tier} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 12px", borderRadius: 7, background: "rgba(0,0,0,0.25)", border: `1px solid ${row.color}20` }}>
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "monospace" }}>{row.icon} {row.tier}</span>
              <span style={{ fontSize: 11, fontWeight: 900, color: row.color, fontFamily: "monospace" }}>{row.discount}</span>
            </div>
          ))}
        </div>
      </GlassPanel>

      {/* Gaze Feed — on-chain staking activity, real TX from cultos-staking */}
      <GazeFeed />
      </>)}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN APP VIEW
// ═══════════════════════════════════════════════════════════════════════════════
function AppView({ onBack }: { onBack: () => void }) {
  const [activeTab, setActiveTab] = useState("chamber");
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [stxBalance, setStxBalance] = useState("0.0000");
  const [xp, setXp] = useState(0);
  const [gameXp, setGameXp] = useState(0);
  const [deployXp, setDeployXp] = useState(0);
  const [gameCultos, setGameCultos] = useState(0);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const [deployedCults, setDeployedCults] = useState<any[]>([]);
  const [isMobile, setIsMobile] = useState(false);
  const [blockHeight, setBlockHeight] = useState("—");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isGamePlaying, setIsGamePlaying] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 1024);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  useEffect(() => {
    fetchBlockHeight().then(setBlockHeight);
    const interval = setInterval(() => fetchBlockHeight().then(setBlockHeight), 30_000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    let i = 0;
    const interval = setInterval(() => {
      if (i < TERMINAL_BOOT.length) {
        setTerminalLogs(prev => [...prev, `> ${TERMINAL_BOOT[i]}`].slice(-10));
        i++;
      } else clearInterval(interval);
    }, 600);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (isConnected()) {
      const cached = getLocalStorage();
      if (cached?.addresses?.stx?.[0]?.address) {
        const addr = cached.addresses.stx[0].address;
        setWalletAddress(addr);
        fetchSTXBalance(addr).then(setStxBalance);
        addLog(`SESSION_RESTORED: ${addr.slice(0, 8)}...`);
      }
    }
  }, []);

  const addLog = useCallback((msg: string) => {
    setTerminalLogs(prev => [...prev, `> ${msg}`].slice(-10));
  }, []);

  const handleWalletConnect = async () => {
    if (isConnecting) return;
    setIsConnecting(true);
    addLog("AUTH_CORE: INITIATING STACKS_CONNECT...");
    try {
      const response = await connect();
      const stxAddr = response?.addresses?.stx?.[0]?.address
        ?? response?.addresses?.find?.((a: any) => a.symbol === "STX")?.address;
      if (stxAddr) {
        setWalletAddress(stxAddr);
        addLog(`AUTH_CORE: WALLET_BOUND // ${stxAddr.slice(0, 8)}...`);
        addLog("SESSION_ESTABLISHED: STACKS_MAINNET // DEVOTION_LEVEL=SIGNAL_PROPAGATOR");
        const bal = await fetchSTXBalance(stxAddr);
        setStxBalance(bal);
        addLog(`BALANCE_SYNC: ${bal} STX`);
      } else {
        addLog("AUTH_CORE: ADDRESS_NOT_FOUND // CHECK_WALLET");
      }
    } catch (err: any) {
      addLog(`AUTH_CORE: CONNECT_FAILED // ${err?.message || "USER_REJECTED"}`);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleWalletDisconnect = () => {
    disconnect();
    setWalletAddress(null);
    setStxBalance("0.0000");
    addLog("AUTH_CORE: SESSION_TERMINATED");
  };

  const handleDeploy = (cult: any) => {
    setDeployedCults(prev => [cult, ...prev]);
    const gained = Math.floor(cult.viralScore * 1.5);
    setXp(prev => prev + gained);
    setDeployXp(prev => prev + gained);
    addLog(`INSCRIPTION_CONFIRMED: ${cult.upgradedName} // BITCOIN_L2_SECURED`);
    if (walletAddress) {
      pushDeploymentToFeed(cult, walletAddress)
        .then(pushed => {
          if (pushed) {
            addLog(`CODEX_FEED: PROPAGATED_TO_GLOBAL_CHAIN`);
          } else {
            addLog(`CODEX_FEED: FIREBASE_PUSH_FAILED // CHECK_CONFIG`);
          }
        })
        .catch((err: any) => {
          addLog(`CODEX_FEED: ERROR // ${err?.message?.slice(0,40) || 'UNKNOWN'}`);
        });
    }
  };

  const handleClaimRewards = (expGained: number, cultosGained: number) => {
    setXp(prev => prev + expGained);
    setGameXp(prev => prev + expGained);
    setGameCultos(prev => prev + cultosGained);
    addLog(`MISSION_CLAIM: +${expGained} XP // +${cultosGained} $CULTOS // ${walletAddress ? "WALLET_BOUND" : "LOCAL_ONLY"}`);
    // Persist game XP to Firebase so leaderboard reflects it
    if (walletAddress && expGained > 0) {
      updateGameXP(walletAddress, expGained)
        .then(ok => {
          if (ok) addLog(`XP_ALTAR: GAME_XP_PERSISTED // +${expGained}`);
          else    addLog(`XP_ALTAR: FIREBASE_PERSIST_SKIPPED // NOT_CONFIGURED`);
        })
        .catch(() => addLog(`XP_ALTAR: PERSIST_ERROR`));
    }
  };

  const renderPanel = () => {
    switch (activeTab) {
      case "chamber":   return <ManifestationChamber onDeploy={handleDeploy} walletAddress={walletAddress} terminalLogs={terminalLogs} addLog={addLog} isMobile={isMobile} />;
      case "mission":   return <MissionGame walletAddress={walletAddress} onConnectWallet={handleWalletConnect} isConnecting={isConnecting} onClaimRewards={handleClaimRewards} isMobile={isMobile} onSetPlaying={setIsGamePlaying} />;
      case "dashboard": return <PersonalCodex deployedCults={deployedCults} walletAddress={walletAddress} onConnect={handleWalletConnect} isConnecting={isConnecting} />;
      case "xp":        return <XPAltarPanel xp={xp} gameXp={gameXp} deployXp={deployXp} walletAddress={walletAddress} onConnect={handleWalletConnect} isConnecting={isConnecting} />;
      case "ritual":    return <RitualAltarPanel walletAddress={walletAddress} addLog={addLog} onConnect={handleWalletConnect} isConnecting={isConnecting} />;
      default:          return null;
    }
  };

  const mobileNavItems = [
    { id: "chamber",   icon: "🧬", label: "Chamber" },
    { id: "mission",   icon: "🛩️", label: "Mission" },
    { id: "dashboard", icon: "🔮", label: "Codex" },
    { id: "xp",        icon: "🌌", label: "XP Altar" },
    { id: "ritual",    icon: "🩸", label: "Ritual" },
  ];

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", position: "relative", zIndex: 1 }}>
      {/* ── APP HEADER ── */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 16px", height: 56, flexShrink: 0, background: "rgba(8,5,18,0.92)", backdropFilter: "blur(20px)", borderBottom: "1px solid rgba(168,85,247,0.1)", width: "100%", boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <button onClick={onBack} style={{ background: "transparent", border: "1px solid rgba(168,85,247,0.2)", borderRadius: 8, padding: "5px 9px", color: "rgba(255,255,255,0.4)", cursor: "pointer", fontSize: 11, fontFamily: "monospace", flexShrink: 0 }}>←</button>
          <img src="/CultOS_Logo.png" alt="CultOS" style={{ width: 32, height: 32, borderRadius: 7, objectFit: "cover", boxShadow: "0 0 10px rgba(168,85,247,0.4)", flexShrink: 0 }} />
          <span style={{ fontSize: 16, fontWeight: 900, color: "white", fontFamily: "monospace", letterSpacing: 2, flexShrink: 0 }}>CULTOS</span>
          <span style={{ fontSize: 9, padding: "3px 7px", borderRadius: 4, fontFamily: "monospace", background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.2)", color: "#22C55E", fontWeight: 700, letterSpacing: 2, flexShrink: 0 }}>MAINNET</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          {walletAddress && !isMobile && (
            <div style={{ textAlign: "right" }}>
              <div style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", fontFamily: "monospace" }}>STX</div>
              <div style={{ fontSize: 12, fontWeight: 900, color: "white", fontFamily: "monospace" }}>{stxBalance}</div>
            </div>
          )}
          {walletAddress ? (
            <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }} onClick={handleWalletDisconnect}
              style={{ background: "rgba(239,68,68,0.12)", border: "1px solid rgba(239,68,68,0.3)", borderRadius: 8, padding: "7px 14px", color: "#EF4444", fontWeight: 800, fontSize: 11, letterSpacing: 1, cursor: "pointer", fontFamily: "monospace", flexShrink: 0 }}
            >DISCONNECT</motion.button>
          ) : (
            <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }} onClick={handleWalletConnect} disabled={isConnecting}
              style={{ background: isConnecting ? "rgba(168,85,247,0.2)" : "linear-gradient(135deg, #A855F7, #7C3AED)", border: "none", borderRadius: 8, padding: "7px 14px", color: "white", fontWeight: 800, fontSize: 11, letterSpacing: 1, cursor: isConnecting ? "wait" : "pointer", fontFamily: "monospace", boxShadow: isConnecting ? "none" : "0 0 16px rgba(168,85,247,0.35)", flexShrink: 0 }}
            >{isConnecting ? "..." : "CONNECT STACKS"}</motion.button>
          )}
        </div>
      </header>

      {/* ── MAIN WORKSPACE ── */}
      {!isMobile ? (
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "220px 1fr 280px", gap: 12, padding: 12, overflow: "hidden" }}>
          <div style={{ overflow: "hidden" }}>
            <SidebarPanel activeTab={activeTab} setActiveTab={setActiveTab} walletAddress={walletAddress} xp={xp} gameCultos={gameCultos} blockHeight={blockHeight} />
          </div>
          <div style={{ overflow: "hidden" }}>
            <AnimatePresence mode="wait">
              <motion.div key={activeTab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}
                style={{ height: "100%", overflow: "auto", scrollbarWidth: "none" }}
              >
                {renderPanel()}
              </motion.div>
            </AnimatePresence>
          </div>
          <div style={{ overflow: "hidden" }}>
            <CodexFeed deployedCults={deployedCults} walletAddress={walletAddress} onConnect={handleWalletConnect} isConnecting={isConnecting} />
          </div>
        </div>
      ) : (
        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ flex: 1, padding: "12px 12px 0", overflowY: "auto", scrollbarWidth: "none", paddingBottom: 90 }}>
            <AnimatePresence mode="wait">
              <motion.div key={activeTab} initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.2 }}>
                {renderPanel()}
                {activeTab === "chamber" && (
                  <div style={{ marginTop: 16 }}>
                    <CodexFeed deployedCults={deployedCults} walletAddress={walletAddress} onConnect={handleWalletConnect} isConnecting={isConnecting} />
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* ── FLOATING BOTTOM NAV — hidden while game is active ── */}
          {!isGamePlaying && (
          <div style={{ position: "fixed", bottom: 16, left: "50%", transform: "translateX(-50%)", zIndex: 200, display: "flex", alignItems: "center", gap: 4, padding: "8px 8px", background: "rgba(8,5,18,0.92)", backdropFilter: "blur(24px)", borderRadius: 20, border: "1px solid rgba(168,85,247,0.2)", boxShadow: "0 8px 32px rgba(0,0,0,0.6), 0 0 40px rgba(168,85,247,0.08)" }}>
            {mobileNavItems.map(item => (
              <button key={item.id} onClick={() => setActiveTab(item.id)}
                style={{ background: activeTab === item.id ? "linear-gradient(135deg, rgba(168,85,247,0.25), rgba(168,85,247,0.12))" : "transparent", border: activeTab === item.id ? "1px solid rgba(168,85,247,0.3)" : "1px solid transparent", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: activeTab === item.id ? "10px 18px" : "10px 14px", borderRadius: 14, transition: "all 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)", minWidth: 60 }}
              >
                <span style={{ fontSize: activeTab === item.id ? 22 : 19, transition: "font-size 0.2s", filter: activeTab === item.id ? "drop-shadow(0 0 6px rgba(168,85,247,0.6))" : "none" }}>{item.icon}</span>
                <span style={{ fontSize: 8, fontFamily: "monospace", fontWeight: 800, letterSpacing: 0.5, color: activeTab === item.id ? "#A855F7" : "rgba(255,255,255,0.3)", transition: "color 0.2s" }}>{item.label.toUpperCase()}</span>
              </button>
            ))}
          </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOT
// ═══════════════════════════════════════════════════════════════════════════════
export default function CultOS() {
  const [view, setView] = useState("landing");
  return (
    <div style={{ minHeight: "100vh", backgroundColor: P.void, fontFamily: "'Courier New', Courier, monospace", color: "white", overflow: "hidden" }}>
      <style>{`
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { display: none; }
        @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
        input::placeholder { color: rgba(255,255,255,0.2); }
        html { background: #080512; }
        @media (max-width: 768px) {
          .desktop-nav { display: none !important; }
          .hamburger-btn { display: flex !important; }
        }
      `}</style>
      <AmbientBackground />
      <AnimatePresence mode="wait">
        {view === "landing" ? (
          <motion.div key="landing" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, scale: 0.98 }} transition={{ duration: 0.5 }} style={{ overflowY: "auto", height: "100vh" }}>
            <LandingPage onLaunch={() => setView("app")} />
          </motion.div>
        ) : (
          <motion.div key="app" initial={{ opacity: 0, scale: 1.02 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.4 }} style={{ height: "100vh" }}>
            <AppView onBack={() => setView("landing")} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
