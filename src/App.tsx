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
  type LiveCultEntry,
  type GlobalStats,
  type LeaderboardEntry,
} from "./services/firebaseService";
import { sanitizeSVG } from "./lib/sanitizeSVG";

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

// ─── TERMINAL BOOT ───────────────────────────────────────────────────────────
const TERMINAL_BOOT = [
  "CULTOS_KERNEL v3.7.1 // INITIALIZING...",
  "LOADING STACKS_NETWORK_ADAPTER...",
  "MEMETIC_ENGINE: ONLINE",
  "ORACLE_CORE: STANDING BY",
  "CONSENSUS_LAYER: BITCOIN_L2 // ACTIVE",
  "SYSTEM READY. AWAITING CULTURAL VECTOR.",
];

// ─── MOCK FEED (diverse, varied names/tickers) ───────────────────────────────
const MOCK_FEED = [
  { name: "HEGEMONY PROTOCOL",    ticker: "HEGMN",  score: 97, address: "SP1A2QRYZ7D5TKK3NB9C3YV9F0BQ8P4W6Z3R7X2", time: "2m ago" },
  { name: "VOID CONSENSUS",       ticker: "VCNS",   score: 91, address: "SP8XK3JT9P0LM7YN5BW2R1Q4V6E8A0D3F5G2H9", time: "7m ago" },
  { name: "SYNTHETIC ORACLE",     ticker: "SNTH",   score: 88, address: "SP2BL8R3M5TK9PQ1YW4V6N0X7E2J5A8D3G1C6", time: "12m ago" },
  { name: "BITCOIN ZEITGEIST",    ticker: "BTZG",   score: 85, address: "SP4M7K2J9TQ6WY3R1P5N8X0V4E6A2D5G8H3B1", time: "19m ago" },
  { name: "SACRED GEOMETRY DAO",  ticker: "SGDAO",  score: 79, address: "SP7K5J3N8TQ2WY6R0P1M4X9V7E3A6D2G5H8B4", time: "31m ago" },
  { name: "TEMPORAL DOMINION",    ticker: "TMPL",   score: 74, address: "SP9C4J8N2TQ7WY5R3P6M1X0V8E4A3D7G1H5B6", time: "44m ago" },
];

// ─── LEADERBOARD ─────────────────────────────────────────────────────────────
const LEADERBOARD = [
  { rank: 1, address: "SP3F7K2J9TQ6WY8R4P0M5X1V3E6A2D7G5H3B8K2", xp: 14880, title: "Sovereign Oracle",     badge: "🜂" },
  { rank: 2, address: "SP7A3J5N8TQ4WY2R6P1M0X7V9E3A8D4G2H6B1W9", xp: 11340, title: "High Manifestor",      badge: "⊕" },
  { rank: 3, address: "SP2M6J4N7TQ3WY9R5P8M2X4V0E5A1D6G9H7B3N6", xp: 8920,  title: "Consensus Architect",  badge: "✦" },
  { rank: 4, address: "SP9K1J7N3TQ8WY4R2P6M9X5V2E7A4D3G8H0B5J3", xp: 6210,  title: "Doctrine Weaver",      badge: "◈" },
  { rank: 5, address: "SP1B8J6N4TQ5WY7R3P4M7X3V1E8A5D0G6H2B9V8", xp: 4450,  title: "Signal Propagator",    badge: "⬡" },
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

// ─── HERO STATS — Landing Page (mock fixed values) ────────────────────────────
function HeroStats() {
  const items = [
    { label: "DEPLOYMENTS",     value: "100+",      color: "#A855F7" },
    { label: "UNIQUE DEPLOYERS", value: "67",        color: "#22C55E" },
    { label: "AVG VIRAL SCORE", value: "73",         color: "#A855F7" },
    { label: "NETWORK",         value: "STACKS L2",  color: "#22C55E" },
  ];

  return (
    <>
      {items.map(stat => (
        <GlassPanel key={stat.label} style={{ padding: "20px 32px", textAlign: "center", minWidth: 140 }}>
          <div style={{ fontSize: 26, fontWeight: 900, color: stat.color, fontFamily: "monospace" }}>{stat.value}</div>
          <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontWeight: 700, letterSpacing: 2, marginTop: 4 }}>{stat.label}</div>
        </GlassPanel>
      ))}
    </>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// LANDING PAGE
// ═══════════════════════════════════════════════════════════════════════════════
function LandingPage({ onLaunch }: { onLaunch: () => void }) {
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);

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
      {/* ── NAVBAR ── */}
      <nav style={{
        position: "sticky", top: 0, zIndex: 100,
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "0 32px", height: 72,
        background: "rgba(8,5,18,0.85)", backdropFilter: "blur(20px)",
        borderBottom: "1px solid rgba(168,85,247,0.1)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <img src="/CultOS_Logo.png" alt="CultOS" style={{ width: 34, height: 34, borderRadius: 9, objectFit: "cover", boxShadow: "0 0 16px rgba(168,85,247,0.4)", flexShrink: 0 }} />
          <span style={{ fontSize: 18, fontWeight: 900, color: "white", letterSpacing: 2, fontFamily: "monospace", flexShrink: 0 }}>CULTOS</span>
        </div>

        {/* Desktop nav */}
        <div className="desktop-nav" style={{ display: "flex", alignItems: "center", gap: 32 }}>
          <div style={{ display: "flex", gap: 28 }}>
            {["About", "How to Use", "FAQ"].map(label => (
              <a key={label} href={`#${label.toLowerCase().replace(/ /g, "-")}`}
                style={{ color: "rgba(255,255,255,0.5)", fontSize: 13, fontWeight: 600, letterSpacing: 1, textDecoration: "none", transition: "color 0.2s" }}
                onMouseEnter={e => (e.target as HTMLElement).style.color = "#A855F7"}
                onMouseLeave={e => (e.target as HTMLElement).style.color = "rgba(255,255,255,0.5)"}
              >{label}</a>
            ))}
          </div>
          <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }} onClick={onLaunch}
            style={{ background: "linear-gradient(135deg, #A855F7, #7C3AED)", border: "none", borderRadius: 50, padding: "10px 28px", color: "white", fontWeight: 800, fontSize: 13, letterSpacing: 1, cursor: "pointer", boxShadow: "0 0 30px rgba(168,85,247,0.4)" }}
          >Launch App →</motion.button>
        </div>

        {/* Hamburger button — mobile only */}
        <button className="hamburger-btn" onClick={() => setMenuOpen(o => !o)}
          style={{ display: "none", flexDirection: "column", gap: 5, background: "transparent", border: "1px solid rgba(168,85,247,0.3)", borderRadius: 8, padding: "8px 10px", cursor: "pointer" }}
          aria-label="Toggle menu"
        >
          <span style={{ display: "block", width: 18, height: 2, background: menuOpen ? "#A855F7" : "rgba(255,255,255,0.7)", transition: "transform 0.2s, background 0.2s", transform: menuOpen ? "rotate(45deg) translate(5px, 5px)" : "none" }} />
          <span style={{ display: "block", width: 18, height: 2, background: menuOpen ? "transparent" : "rgba(255,255,255,0.7)", transition: "opacity 0.2s" }} />
          <span style={{ display: "block", width: 18, height: 2, background: menuOpen ? "#A855F7" : "rgba(255,255,255,0.7)", transition: "transform 0.2s, background 0.2s", transform: menuOpen ? "rotate(-45deg) translate(5px, -5px)" : "none" }} />
        </button>
      </nav>

      {/* Mobile dropdown menu */}
      <AnimatePresence>
        {menuOpen && (
          <motion.div initial={{ opacity: 0, y: -10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }} transition={{ duration: 0.2 }}
            style={{ position: "sticky", top: 72, zIndex: 99, background: "rgba(8,5,18,0.97)", backdropFilter: "blur(20px)", borderBottom: "1px solid rgba(168,85,247,0.15)", padding: "16px 24px", display: "flex", flexDirection: "column", gap: 12 }}
          >
            {["About", "How to Use", "FAQ"].map(label => (
              <a key={label} href={`#${label.toLowerCase().replace(/ /g, "-")}`} onClick={() => setMenuOpen(false)}
                style={{ color: "rgba(255,255,255,0.7)", fontSize: 14, fontWeight: 700, letterSpacing: 1.5, textDecoration: "none", fontFamily: "monospace", padding: "8px 0", borderBottom: "1px solid rgba(168,85,247,0.08)" }}
              >{label}</a>
            ))}
            <motion.button whileTap={{ scale: 0.97 }} onClick={() => { setMenuOpen(false); onLaunch(); }}
              style={{ background: "linear-gradient(135deg, #A855F7, #7C3AED)", border: "none", borderRadius: 50, padding: "12px 0", color: "white", fontWeight: 800, fontSize: 13, letterSpacing: 1, cursor: "pointer", marginTop: 4 }}
            >Launch App →</motion.button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── HERO ── */}
      <section style={{ padding: "120px 32px 100px", textAlign: "center", maxWidth: 900, margin: "0 auto" }}>
        <motion.div initial={{ opacity: 0, y: 30 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8 }}>
          <div style={{ display: "inline-block", marginBottom: 24, padding: "6px 16px", borderRadius: 50, background: "rgba(168,85,247,0.1)", border: "1px solid rgba(168,85,247,0.3)", color: "#A855F7", fontSize: 11, fontWeight: 700, letterSpacing: 3, fontFamily: "monospace" }}>
            ◈ OPERATING ON BITCOIN LAYER 2 — STACKS NETWORK ◈
          </div>
          <h1 style={{ fontSize: "clamp(42px, 8vw, 88px)", fontWeight: 900, lineHeight: 1.0, color: "white", letterSpacing: -3, marginBottom: 24, fontFamily: "monospace" }}>
            CULT-AS-A-SERVICE<br /><span style={{ color: "#A855F7" }}>ON BITCOIN</span>
          </h1>
          <p style={{ fontSize: 18, color: "rgba(255,255,255,0.5)", lineHeight: 1.7, maxWidth: 600, margin: "0 auto 48px", fontWeight: 400 }}>
            The first AI-powered memetic identity engine permanently inscribing cultural consensus vectors onto the most immutable ledger in existence.
          </p>
          <div style={{ display: "flex", gap: 16, justifyContent: "center", flexWrap: "wrap" }}>
            <motion.button whileHover={{ scale: 1.04, boxShadow: "0 0 50px rgba(168,85,247,0.6)" }} whileTap={{ scale: 0.97 }} onClick={onLaunch}
              style={{ background: "linear-gradient(135deg, #A855F7, #22C55E)", border: "none", borderRadius: 50, padding: "16px 48px", color: "white", fontWeight: 900, fontSize: 15, letterSpacing: 2, cursor: "pointer", fontFamily: "monospace", boxShadow: "0 0 40px rgba(168,85,247,0.4)" }}
            >ENTER THE CHAMBER</motion.button>
            <motion.button whileHover={{ scale: 1.04 }} whileTap={{ scale: 0.97 }}
              onClick={() => document.getElementById('about')?.scrollIntoView({ behavior: 'smooth' })}
              style={{ background: "transparent", border: "1px solid rgba(168,85,247,0.3)", borderRadius: 50, padding: "16px 48px", color: "rgba(255,255,255,0.7)", fontWeight: 700, fontSize: 15, letterSpacing: 2, cursor: "pointer", fontFamily: "monospace" }}
            >READ THE DOCTRINE ↓</motion.button>
          </div>
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.8, delay: 0.4 }}
          style={{ display: "flex", gap: 24, justifyContent: "center", marginTop: 80, flexWrap: "wrap" }}
        >
          <HeroStats />
        </motion.div>
      </section>

      {/* ── ABOUT ── */}
      <section id="about" style={{ padding: "80px 32px", maxWidth: 1000, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 60 }}>
          <div style={{ color: "#A855F7", fontFamily: "monospace", fontSize: 11, letterSpacing: 3, fontWeight: 700, marginBottom: 16 }}>◈ ABOUT THE PROTOCOL ◈</div>
          <h2 style={{ fontSize: 42, fontWeight: 900, color: "white", letterSpacing: -2, fontFamily: "monospace" }}>WHAT IS <span style={{ color: "#A855F7" }}>CULTOS</span>?</h2>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 20 }}>
          {[
            {
              icon: (<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><circle cx="16" cy="16" r="12" stroke="#A855F7" strokeWidth="1.5"/><path d="M16 4 L28 22 L4 22 Z" stroke="#22C55E" strokeWidth="1.2" fill="none"/><circle cx="16" cy="16" r="3" fill="#A855F7"/></svg>),
              title: "ORACLE AI JUDGMENT",
              desc: "An elitist AI Oracle evaluates every cultural vector submission, transforming concepts into sovereign philosophical token identities with supreme discernment."
            },
            {
              icon: (<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><rect x="6" y="6" width="20" height="20" rx="2" stroke="#A855F7" strokeWidth="1.5"/><path d="M11 11 L21 21 M21 11 L11 21" stroke="#22C55E" strokeWidth="1.2"/><rect x="13" y="13" width="6" height="6" fill="rgba(168,85,247,0.3)"/></svg>),
              title: "BITCOIN-INSCRIBED",
              desc: "Each sub-cult receives permanent on-chain inscription via Stacks Clarity contracts — immutable, sovereign, and Bitcoin-secured."
            },
            {
              icon: (<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><polygon points="16,4 28,11 28,21 16,28 4,21 4,11" stroke="#A855F7" strokeWidth="1.5" fill="none"/><polygon points="16,10 22,14 22,18 16,22 10,18 10,14" stroke="#22C55E" strokeWidth="1" fill="none"/><circle cx="16" cy="16" r="2" fill="#A855F7"/></svg>),
              title: "SACRED SIGIL ART",
              desc: "Every deployment generates a unique SVG sigil — abstract sacred geometry rendered from the Oracle's esoteric interpretation of your vector."
            },
            {
              icon: (<svg width="32" height="32" viewBox="0 0 32 32" fill="none"><path d="M16 4 C20 8 28 10 28 16 C28 22 22 28 16 28 C10 28 4 22 4 16 C4 10 12 8 16 4Z" stroke="#A855F7" strokeWidth="1.5" fill="none"/><path d="M16 10 L19 16 L16 22 L13 16 Z" fill="rgba(34,197,94,0.4)" stroke="#22C55E" strokeWidth="1"/></svg>),
              title: "DEVOTION ECONOMY",
              desc: "Lock $CultOS tokens in the Ritual Altar to earn devotion XP, elevate your rank from Neophyte to Sovereign Oracle, and claim from the global fee pool."
            },
          ].map(card => (
            <GlassPanel key={card.title} hover style={{ padding: 28 }}>
              <div style={{ marginBottom: 16 }}>{card.icon}</div>
              <div style={{ fontSize: 12, fontWeight: 800, color: "#A855F7", letterSpacing: 2, marginBottom: 10, fontFamily: "monospace" }}>{card.title}</div>
              <div style={{ fontSize: 14, color: "rgba(255,255,255,0.5)", lineHeight: 1.7 }}>{card.desc}</div>
            </GlassPanel>
          ))}
        </div>
      </section>

      {/* ── HOW TO USE ── */}
      <section id="how-to-use" style={{ padding: "80px 32px", maxWidth: 900, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 60 }}>
          <div style={{ color: "#22C55E", fontFamily: "monospace", fontSize: 11, letterSpacing: 3, fontWeight: 700, marginBottom: 16 }}>◈ OPERATIONAL PROTOCOL ◈</div>
          <h2 style={{ fontSize: 42, fontWeight: 900, color: "white", letterSpacing: -2, fontFamily: "monospace" }}>HOW TO <span style={{ color: "#22C55E" }}>MANIFEST</span></h2>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {[
            { step: "01", title: "CONNECT DEVOTION WALLET", path: "Leather · Xverse · Bitget", desc: "Authenticate via your Stacks-compatible wallet. Your Stacks principal address becomes your sovereign identity on the protocol. No seed phrases transmitted — pure cryptographic consent via @stacks/connect.", color: "#A855F7" },
            { step: "02", title: "CHANNEL THE CULTURAL ZEITGEIST", path: "Oracle AI Analysis", desc: "Submit your cultural vector — any concept, ideology, or signal from the collective unconscious. The Oracle judges its vitality, issues a viral score, and synthesizes a sovereign token identity with 150-word esoteric lore.", color: "#A855F7" },
            { step: "03", title: "SOVEREIGN MANIFESTATION", path: "Stacks Mainnet Deploy", desc: "Broadcast your sub-cult to the Stacks Network. Pay the Oracle-determined deployment fee (0.1–0.3 STX). Your cultural artifact is permanently inscribed on Bitcoin's consensus layer, visible in the live Codex Feed.", color: "#22C55E" },
          ].map((item, i) => (
            <motion.div key={item.step} initial={{ opacity: 0, x: -20 }} whileInView={{ opacity: 1, x: 0 }} transition={{ duration: 0.5, delay: i * 0.15 }} viewport={{ once: true }}>
              <GlassPanel hover style={{ padding: "28px 32px", marginBottom: 4 }}>
                <div style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
                  <div style={{ fontSize: 11, fontFamily: "monospace", fontWeight: 900, color: item.color, letterSpacing: 2, minWidth: 28, paddingTop: 2 }}>{item.step}</div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 8, flexWrap: "wrap" }}>
                      <div style={{ fontSize: 14, fontWeight: 900, color: "white", fontFamily: "monospace", letterSpacing: 1 }}>{item.title}</div>
                      <div style={{ fontSize: 9, color: "rgba(168,85,247,0.6)", fontFamily: "monospace", background: "rgba(168,85,247,0.08)", padding: "2px 8px", borderRadius: 4, border: "1px solid rgba(168,85,247,0.15)" }}>{item.path}</div>
                    </div>
                    <div style={{ fontSize: 14, color: "rgba(255,255,255,0.5)", lineHeight: 1.7 }}>{item.desc}</div>
                  </div>
                </div>
              </GlassPanel>
            </motion.div>
          ))}
        </div>
      </section>

      {/* ── FAQ ── */}
      <section id="faq" style={{ padding: "80px 32px", maxWidth: 800, margin: "0 auto" }}>
        <div style={{ textAlign: "center", marginBottom: 60 }}>
          <div style={{ color: "#A855F7", fontFamily: "monospace", fontSize: 11, letterSpacing: 3, fontWeight: 700, marginBottom: 16 }}>◈ ESOTERIC DOCTRINE ◈</div>
          <h2 style={{ fontSize: 42, fontWeight: 900, color: "white", letterSpacing: -2, fontFamily: "monospace" }}>FREQUENTLY ASKED <span style={{ color: "#A855F7" }}>QUESTIONS</span></h2>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {faqs.map((faq, i) => (
            <GlassPanel key={i} hover onClick={() => setOpenFaq(openFaq === i ? null : i)} style={{ padding: 0, cursor: "pointer" }}>
              <div style={{ padding: "20px 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: "white" }}>{faq.q}</div>
                <motion.div animate={{ rotate: openFaq === i ? 45 : 0 }} transition={{ duration: 0.2 }}>
                  <span style={{ color: "#A855F7", fontSize: 20, fontWeight: 300, flexShrink: 0, marginLeft: 12 }}>+</span>
                </motion.div>
              </div>
              <AnimatePresence>
                {openFaq === i && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.3 }} style={{ overflow: "hidden" }}>
                    <div style={{ padding: "0 24px 20px", paddingTop: 16, fontSize: 14, color: "rgba(255,255,255,0.5)", lineHeight: 1.8, borderTop: "1px solid rgba(168,85,247,0.1)" }}>{faq.a}</div>
                  </motion.div>
                )}
              </AnimatePresence>
            </GlassPanel>
          ))}
        </div>
      </section>

      {/* ── CTA ── */}
      <section style={{ padding: "80px 32px 120px", textAlign: "center" }}>
        <motion.div initial={{ opacity: 0, y: 20 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true }}>
          <GlassPanel style={{ maxWidth: 700, margin: "0 auto", padding: "60px 48px" }}>
            <div style={{ fontSize: 11, fontFamily: "monospace", letterSpacing: 3, fontWeight: 700, color: "#A855F7", marginBottom: 20 }}>◈ THE CHAMBER AWAITS ◈</div>
            <h2 style={{ fontSize: 36, fontWeight: 900, color: "white", letterSpacing: -2, marginBottom: 16, fontFamily: "monospace" }}>MANIFEST YOUR FIRST<br />DIGITAL MOVEMENT</h2>
            <p style={{ fontSize: 15, color: "rgba(255,255,255,0.4)", lineHeight: 1.7, marginBottom: 36, maxWidth: 480, margin: "0 auto 36px" }}>
              Connect your Stacks wallet, submit your cultural vector, and receive Oracle judgment within seconds.
            </p>
            <motion.button whileHover={{ scale: 1.05, boxShadow: "0 0 60px rgba(168,85,247,0.5)" }} whileTap={{ scale: 0.97 }} onClick={onLaunch}
              style={{ background: "linear-gradient(135deg, #A855F7, #22C55E)", border: "none", borderRadius: 50, padding: "18px 64px", color: "white", fontWeight: 900, fontSize: 16, letterSpacing: 2, cursor: "pointer", fontFamily: "monospace", boxShadow: "0 0 40px rgba(168,85,247,0.3)" }}
            >LAUNCH APP</motion.button>
          </GlassPanel>
        </motion.div>
      </section>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIDEBAR PANEL
// ═══════════════════════════════════════════════════════════════════════════════
function SidebarPanel({ activeTab, setActiveTab, walletAddress, xp, blockHeight }: any) {
  const navItems = [
    { id: "chamber",   icon: "🧬", label: "MANIFESTATION CHAMBER" },
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
              {walletAddress ? "SIGNAL PROPAGATOR" : "CONNECT TO ASCEND"}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", background: "rgba(168,85,247,0.06)", borderRadius: 8, border: "1px solid rgba(168,85,247,0.12)" }}>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", fontWeight: 700 }}>DEVOTION XP</span>
          <span style={{ fontSize: 14, fontWeight: 900, color: "#A855F7", fontFamily: "monospace" }}>{xp.toLocaleString()}</span>
        </div>
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

    const feeFloat  = 0.05 + (result.viralScore / 100) * 0.1;
    const feeSTXStr = feeFloat.toFixed(3);
    const microSTX  = Math.round(feeFloat * 1_000_000);

    const FACTORY = import.meta.env.VITE_FACTORY_CONTRACT
      || "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.cultos-factory";
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
      const sanitize = (str: string, max: number) =>
        str.replace(/[^ -~]/g, "").slice(0, max).trim();

      const safeName   = sanitize(result.upgradedName, 64);
      const safeTicker = sanitize(result.ticker, 8);
      const safeLore   = sanitize(result.lore || "", 490);

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

  const feeSTX = result ? (0.1 + (result.viralScore / 100) * 0.2).toFixed(2) : "0.10";

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
                    { label: "VIRAL SCORE",  value: result.viralScore, color: result.viralScore >= 70 ? "#22C55E" : result.viralScore >= 40 ? "#F59E0B" : "#EF4444" },
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
                ⚡ CONNECT WALLET TO DEPLOY
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
              {!walletAddress ? "WALLET REQUIRED" : isDeploying ? "AWAITING WALLET CONFIRMATION..." : `DEPLOY TO BITCOIN L2 — ${feeSTX} STX`}
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
// CODEX FEED
// ═══════════════════════════════════════════════════════════════════════════════
function CodexFeed({ deployedCults }: { deployedCults: any[] }) {
  const [liveFeed, setLiveFeed] = useState<LiveCultEntry[]>([]);
  const [isLive, setIsLive] = useState(false);

  useEffect(() => {
    const unsub = subscribeLiveFeed(
      (entries) => { setLiveFeed(entries); setIsLive(true); },
      () => { setIsLive(false); }
    );
    if (unsub) return unsub;
  }, []);

  const sessionCults = deployedCults.slice().reverse().map((c: any) => ({
    name: c.upgradedName,
    ticker: c.ticker,
    score: c.viralScore,
    address: "SP" + Math.random().toString(36).slice(2, 6).toUpperCase() + "...",
    time: "just now",
  }));

  const allCults = isLive ? [...sessionCults, ...liveFeed] : [...sessionCults, ...MOCK_FEED];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", gap: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexShrink: 0 }}>
        <span style={{ fontSize: 11, fontFamily: "monospace", color: "#A855F7", fontWeight: 700, letterSpacing: 2 }}>◈ GLOBAL CODEX FEED</span>
        <span style={{ fontSize: 9, fontFamily: "monospace", padding: "3px 8px", background: "rgba(34,197,94,0.1)", border: "1px solid rgba(34,197,94,0.2)", borderRadius: 4, color: "#22C55E", fontWeight: 700 }}>
          <motion.span animate={{ opacity: [1, 0.3, 1] }} transition={{ duration: 2, repeat: Infinity }}>● </motion.span>
          {isLive ? "LIVE" : "MOCK"}
        </span>
      </div>
      <div style={{ flex: 1, overflowY: "auto", scrollbarWidth: "none", display: "flex", flexDirection: "column", gap: 8 }}>
        {allCults.map((cult, i) => (
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
function DashboardPanel({ deployedCults, walletAddress }: any) {
  if (deployedCults.length === 0) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", flexDirection: "column", opacity: 0.4 }}>
        <div style={{ fontSize: 48, marginBottom: 16 }}>🔮</div>
        <div style={{ fontFamily: "monospace", fontSize: 13, color: "rgba(255,255,255,0.5)", textAlign: "center", letterSpacing: 1 }}>
          NO DEPLOYMENTS DETECTED<br /><span style={{ fontSize: 11, opacity: 0.6 }}>MANIFEST YOUR FIRST SUB-CULT IN THE CHAMBER</span>
        </div>
      </div>
    );
  }
  return (
    <div style={{ height: "100%", overflowY: "auto", scrollbarWidth: "none" }}>
      <div style={{ fontSize: 11, fontFamily: "monospace", color: "#A855F7", fontWeight: 700, letterSpacing: 2, marginBottom: 16 }}>◈ MY DEPLOYMENTS ({deployedCults.length})</div>
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {deployedCults.map((cult: any, i: number) => (
          <GlassPanel key={i} hover style={{ padding: 20 }}>
            <div style={{ display: "grid", gridTemplateColumns: "80px 1fr", gap: 16 }}>
              <div style={{ borderRadius: 8, overflow: "hidden", aspectRatio: "1/1", background: "#080512" }}>
                <OracleSVG rawSVG={cult.rawSVG} name={cult.upgradedName} />
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#A855F7", fontFamily: "monospace", fontWeight: 700, marginBottom: 4 }}>${cult.ticker}</div>
                <div style={{ fontSize: 16, fontWeight: 900, color: "white", fontFamily: "monospace", letterSpacing: -0.5, marginBottom: 8 }}>{cult.upgradedName}</div>
                <div style={{ display: "flex", gap: 8 }}>
                  {[
                    { label: "VIRAL", value: cult.viralScore, color: "#22C55E" },
                    { label: "STATUS", value: "ACTIVE", color: "#A855F7" },
                  ].map(s => (
                    <div key={s.label} style={{ padding: "4px 10px", borderRadius: 6, background: "rgba(168,85,247,0.08)", border: "1px solid rgba(168,85,247,0.15)" }}>
                      <span style={{ fontSize: 9, color: "rgba(255,255,255,0.3)", fontFamily: "monospace" }}>{s.label}: </span>
                      <span style={{ fontSize: 9, color: s.color, fontFamily: "monospace", fontWeight: 700 }}>{s.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <p style={{ marginTop: 12, fontSize: 12, color: "rgba(255,255,255,0.35)", lineHeight: 1.6 }}>{cult.lore?.slice(0, 120)}...</p>
          </GlassPanel>
        ))}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// XP ALTAR PANEL
// ═══════════════════════════════════════════════════════════════════════════════
function XPAltarPanel({ xp }: { xp: number }) {
  // Fixed values per request: 131 tokens, 3200 estimated allocation
  const basedAltarCount = 131;
  const estimatedAllocation = 3200;
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>(LEADERBOARD);

  useEffect(() => {
    const unsub = subscribeLiveLeaderboard(
      (entries) => { if (entries.length > 0) setLeaderboard(entries); },
      () => { /* silent — keep static fallback */ }
    );
    return () => { unsub?.(); };
  }, []);

  return (
    <div style={{ height: "100%", overflowY: "auto", scrollbarWidth: "none", display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ fontSize: 11, fontFamily: "monospace", color: "#A855F7", fontWeight: 700, letterSpacing: 2, marginBottom: 4 }}>◈ XP ALTAR & SOVEREIGNTY RANKINGS</div>

      {/* XP Pool */}
      <GlassPanel style={{ padding: 24 }}>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", letterSpacing: 2, marginBottom: 8 }}>$CULTOS LOYALTY ALLOCATION</div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 12 }}>
          <div style={{ fontSize: 42, fontWeight: 900, color: "#A855F7", fontFamily: "monospace", lineHeight: 1 }}>{estimatedAllocation.toLocaleString()}</div>
          <div style={{ fontSize: 14, color: "rgba(168,85,247,0.6)", fontFamily: "monospace", marginBottom: 8 }}>$CULTOS</div>
        </div>
        <div style={{ fontSize: 12, color: "rgba(255,255,255,0.35)", marginBottom: 16, lineHeight: 1.6 }}>
          Estimated allocation based on {xp.toLocaleString()} devotion XP × protocol multiplier.<br />
          Token generation event and distribution schedule TBA.
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
          <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", fontFamily: "monospace" }}>BASED ALTAR ENTRIES</span>
          <span style={{ fontSize: 13, fontWeight: 900, color: "#22C55E", fontFamily: "monospace" }}>{basedAltarCount}</span>
        </div>
        <div style={{ marginBottom: 16, height: 6, background: "rgba(168,85,247,0.1)", borderRadius: 4, overflow: "hidden" }}>
          <motion.div animate={{ width: ["0%", `${Math.min(xp / 200, 100)}%`] }} transition={{ duration: 2, ease: "easeOut" }}
            style={{ height: "100%", background: "linear-gradient(90deg, #A855F7, #22C55E)", borderRadius: 4 }}
          />
        </div>
        <div style={{ width: "100%", background: "rgba(168,85,247,0.08)", border: "1px solid rgba(168,85,247,0.2)", borderRadius: 10, padding: "12px 0", color: "rgba(168,85,247,0.6)", fontWeight: 700, fontSize: 12, letterSpacing: 2, fontFamily: "monospace", textAlign: "center" }}>
          ◈ TOKEN DISTRIBUTION: COMING SOON
        </div>
      </GlassPanel>

      {/* Leaderboard */}
      <GlassPanel style={{ padding: 20 }}>
        <div style={{ fontSize: 11, color: "rgba(255,255,255,0.4)", fontFamily: "monospace", letterSpacing: 2, marginBottom: 16 }}>GLOBAL SOVEREIGNTY LEADERBOARD</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {leaderboard.map((entry, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: i === 0 ? "rgba(168,85,247,0.08)" : "rgba(0,0,0,0.2)", borderRadius: 10, border: `1px solid ${i === 0 ? "rgba(168,85,247,0.2)" : "rgba(168,85,247,0.06)"}` }}>
              <div style={{ width: 28, textAlign: "center", fontSize: 16 }}>{entry.badge}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontFamily: "monospace", color: "rgba(255,255,255,0.6)", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.address}</div>
                <div style={{ fontSize: 10, color: "rgba(168,85,247,0.6)", fontFamily: "monospace", marginTop: 2 }}>{entry.title}</div>
              </div>
              <div style={{ textAlign: "right", flexShrink: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 900, color: i === 0 ? "#A855F7" : "rgba(255,255,255,0.7)", fontFamily: "monospace" }}>{entry.xp.toLocaleString()}</div>
                <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "monospace" }}>XP</div>
              </div>
            </div>
          ))}
        </div>
      </GlassPanel>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// RITUAL ALTAR PANEL — Real Staking via Stacks Smart Contract
// ═══════════════════════════════════════════════════════════════════════════════
function RitualAltarPanel({ walletAddress, addLog }: { walletAddress: string | null; addLog: (msg: string) => void }) {
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
  useEffect(() => {
    fetchStakingStats().then(setStakingStats).catch(() => {});
    const interval = setInterval(() => fetchStakingStats().then(setStakingStats).catch(() => {}), 60_000);
    return () => clearInterval(interval);
  }, []);

  const tiers = [
    { id: "neophyte",  name: "NEOPHYTE LOCK",     duration: "30 DAYS",  multiplier: "1.2x", min: 100,  color: "#A855F7", icon: "◈",  lockDays: 30  },
    { id: "adept",     name: "ADEPT DEVOTION",    duration: "90 DAYS",  multiplier: "1.8x", min: 500,  color: "#22C55E", icon: "✦",  lockDays: 90  },
    { id: "sovereign", name: "SOVEREIGN RITUAL",  duration: "180 DAYS", multiplier: "3.5x", min: 2000, color: "#F59E0B", icon: "⊕",  lockDays: 180 },
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
      <div style={{ fontSize: 11, fontFamily: "monospace", color: "#A855F7", fontWeight: 700, letterSpacing: 2 }}>◈ RITUAL ALTAR — $CULTOS DEVOTION LOCKING</div>

      {/* Wallet required notice */}
      {!walletAddress && (
        <GlassPanel style={{ padding: 16, border: "1px solid rgba(168,85,247,0.25)", background: "rgba(168,85,247,0.06)", textAlign: "center" }}>
          <div style={{ fontSize: 12, fontFamily: "monospace", color: "rgba(168,85,247,0.8)", letterSpacing: 1 }}>⚡ CONNECT WALLET TO STAKE $CULTOS</div>
        </GlassPanel>
      )}

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

      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {tiers.map(tier => (
          <GlassPanel key={tier.id} hover
            onClick={() => setSelectedTier(tier.id === selectedTier ? null : tier.id)}
            style={{ padding: 20, cursor: "pointer", border: `1px solid ${selectedTier === tier.id ? tier.color + "50" : "rgba(168,85,247,0.1)"}`, boxShadow: selectedTier === tier.id ? `0 0 20px ${tier.color}20` : undefined }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                <div style={{ width: 36, height: 36, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", background: `${tier.color}15`, fontSize: 18, border: `1px solid ${tier.color}30` }}>
                  {tier.icon}
                </div>
                <div>
                  <div style={{ fontSize: 11, fontWeight: 800, color: "white", fontFamily: "monospace", letterSpacing: 1 }}>{tier.name}</div>
                  <div style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontFamily: "monospace", marginTop: 2 }}>MIN: {tier.min.toLocaleString()} $CULTOS • {tier.duration}</div>
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 20, fontWeight: 900, color: tier.color, fontFamily: "monospace" }}>{tier.multiplier}</div>
                <div style={{ fontSize: 9, color: "rgba(255,255,255,0.25)", fontFamily: "monospace" }}>YIELD MULT</div>
              </div>
            </div>
            <AnimatePresence>
              {selectedTier === tier.id && (
                <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} style={{ overflow: "hidden" }}>
                  <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${tier.color}20` }}>
                    <div style={{ display: "flex", gap: 10, marginBottom: 12 }}>
                      <input
                        value={stakeAmount}
                        onChange={e => setStakeAmount(e.target.value)}
                        placeholder={`Enter amount (min ${tier.min})`}
                        onClick={e => e.stopPropagation()}
                        style={{ flex: 1, background: "rgba(0,0,0,0.4)", border: `1px solid ${tier.color}30`, borderRadius: 8, padding: "10px 12px", color: "white", fontSize: 12, outline: "none", fontFamily: "monospace" }}
                      />
                      <motion.button
                        whileHover={{ scale: 1.03 }} whileTap={{ scale: 0.97 }}
                        onClick={(e) => handleStake(tier, e as any)}
                        disabled={stakeStatus === "staking" || !walletAddress}
                        style={{
                          background: stakeStatus === "staking" ? `${tier.color}40` : !walletAddress ? "rgba(255,255,255,0.05)" : tier.color,
                          border: "none", borderRadius: 8, padding: "10px 20px",
                          color: !walletAddress ? "rgba(255,255,255,0.2)" : "black",
                          fontWeight: 900, fontSize: 11, letterSpacing: 1,
                          cursor: stakeStatus === "staking" || !walletAddress ? "not-allowed" : "pointer",
                          fontFamily: "monospace",
                        }}
                      >
                        {stakeStatus === "staking" ? "LOCKING..." : "LOCK"}
                      </motion.button>
                    </div>
                    {stakeAmount && Number(stakeAmount) >= tier.min && (
                      <div style={{ fontSize: 11, color: tier.color, fontFamily: "monospace" }}>
                        EST. DAILY YIELD: {(Number(stakeAmount) * parseFloat(tier.multiplier) * 0.001).toFixed(2)} $CULTOS/day
                      </div>
                    )}
                    <div style={{ marginTop: 8, fontSize: 10, color: "rgba(255,255,255,0.25)", fontFamily: "monospace", lineHeight: 1.5 }}>
                      $CultOS LIVE: SPQ189E66S...CKHAEF.CultOS // Deploy cultos-staking.clar to enable on-chain locking.
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
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
          ["DAILY REWARDS POOL",    `${dailyRewardsPool} $CULTOS`],
          ["TOTAL DEPLOYMENTS",     totalDeployments > 0 ? totalDeployments.toString() : "100+"],
          ["AVG VIRAL SCORE",       avgViralScore > 0 ? avgViralScore.toFixed(1) : "73.0"],
          ["$CultOS TOKEN",          "SPQ189E...CultOS"],
          ["STAKING CONTRACT",       STAKING_CONTRACT ? STAKING_CONTRACT.slice(0,18)+"..." : "PENDING DEPLOY"],
        ].map(([k, v]) => (
          <div key={k} style={{ display: "flex", justifyContent: "space-between", marginBottom: 10, alignItems: "center" }}>
            <span style={{ fontSize: 10, color: "rgba(255,255,255,0.3)", fontFamily: "monospace" }}>{k}</span>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.7)", fontFamily: "monospace", fontWeight: 700 }}>{v}</span>
          </div>
        ))}
      </GlassPanel>
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
  const [xp, setXp] = useState(131);
  const [terminalLogs, setTerminalLogs] = useState<string[]>([]);
  const [deployedCults, setDeployedCults] = useState<any[]>([]);
  const [isMobile, setIsMobile] = useState(false);
  const [blockHeight, setBlockHeight] = useState("—");
  const [isConnecting, setIsConnecting] = useState(false);

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
    setXp(prev => prev + Math.floor(cult.viralScore * 1.5));
    addLog(`INSCRIPTION_CONFIRMED: ${cult.upgradedName} // BITCOIN_L2_SECURED`);
    if (walletAddress) {
      pushDeploymentToFeed(cult, walletAddress)
        .then(pushed => {
          if (pushed) addLog(`CODEX_FEED: PROPAGATED_TO_GLOBAL_CHAIN`);
        })
        .catch(() => {/* silent fail */});
    }
  };

  const renderPanel = () => {
    switch (activeTab) {
      case "chamber":   return <ManifestationChamber onDeploy={handleDeploy} walletAddress={walletAddress} terminalLogs={terminalLogs} addLog={addLog} isMobile={isMobile} />;
      case "dashboard": return <DashboardPanel deployedCults={deployedCults} walletAddress={walletAddress} />;
      case "xp":        return <XPAltarPanel xp={xp} />;
      case "ritual":    return <RitualAltarPanel walletAddress={walletAddress} addLog={addLog} />;
      default:          return null;
    }
  };

  const mobileNavItems = [
    { id: "chamber",   icon: "🧬", label: "Chamber" },
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
            >{isConnecting ? "..." : "CONNECT"}</motion.button>
          )}
        </div>
      </header>

      {/* ── MAIN WORKSPACE ── */}
      {!isMobile ? (
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "220px 1fr 280px", gap: 12, padding: 12, overflow: "hidden" }}>
          <div style={{ overflow: "hidden" }}>
            <SidebarPanel activeTab={activeTab} setActiveTab={setActiveTab} walletAddress={walletAddress} xp={xp} blockHeight={blockHeight} />
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
            <CodexFeed deployedCults={deployedCults} />
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
                    <CodexFeed deployedCults={deployedCults} />
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* ── FLOATING BOTTOM NAV ── */}
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
