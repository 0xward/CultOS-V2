/**
 * CultOS Firebase Service — Full Activation (V3)
 * Feed: langsung dari Stacks blockchain (cultos-factory-v2)
 * Stats: langsung dari cultos-staking contract
 * Leaderboard: dari Stacks blockchain, top 20 by XP
 */
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  increment,
  arrayUnion,
  serverTimestamp,
  type Firestore,
} from 'firebase/firestore';

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

let app: FirebaseApp | null = null;
let db: Firestore | null = null;

function isConfigured(): boolean {
  return !!(
    firebaseConfig.apiKey &&
    firebaseConfig.projectId &&
    firebaseConfig.apiKey !== 'your_firebase_api_key_here'
  );
}

function getDB(): Firestore | null {
  if (!isConfigured()) return null;
  if (!db) {
    app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
    db = getFirestore(app);
  }
  return db;
}

function getRankTitle(xp: number): string {
  if (xp >= 10000) return 'Sovereign Oracle';
  if (xp >= 5000)  return 'High Manifestor';
  if (xp >= 2000)  return 'Consensus Architect';
  if (xp >= 500)   return 'Doctrine Weaver';
  if (xp >= 100)   return 'Signal Propagator';
  return 'Neophyte';
}

function getRankBadge(xp: number): string {
  if (xp >= 10000) return '\u{1F702}';
  if (xp >= 5000)  return '\u2295';
  if (xp >= 2000)  return '\u2726';
  if (xp >= 500)   return '\u25C8';
  if (xp >= 100)   return '\u2B21';
  return '\u25CB';
}

export interface LiveCultEntry {
  id?: string;
  name: string;
  ticker: string;
  score: number;
  address: string;
  time: string;
  lore?: string;
  rawSVG?: string;
  timestamp?: any;
}

export interface GlobalStats {
  totalDeployments: number;
  uniqueDeployers: number;
  avgViralScore: number;
}

export interface LeaderboardEntry {
  rank: number;
  address: string;
  xp: number;
  deployments: number;
  title: string;
  badge: string;
}

const STACKS_API_BASE = "https://api.mainnet.hiro.so";
const FACTORY_ADDRESS = "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF";
const FACTORY_NAME    = "cultos-factory-v2";
const STAKING_ADDRESS = "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF";
const STAKING_NAME    = "cultos-staking";

export const CULTOS_TOKEN          = "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.CultOS";
export const CULTOS_TOKEN_EXPLORER = "https://explorer.hiro.so/token/SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.CultOS";

function formatRelativeTime(date: Date): string {
  const diffMs  = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60)  return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60)  return `${diffMin}m ago`;
  const diffHr  = Math.floor(diffMin / 60);
  if (diffHr  < 24)  return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

// Parse register-cult args dari satu TX
function parseCultFromTx(tx: any): LiveCultEntry | null {
  try {
    if (tx.tx_status !== 'success') return null;
    if (tx.tx_type !== 'contract_call') return null;
    if (tx.contract_call?.function_name !== 'register-cult') return null;

    const args   = tx.contract_call?.function_args ?? [];
    // Args: name(0), ticker(1), lore(2), viralScore(3), fee(4)
    const name   = args[0]?.repr?.replace(/^u?"?|"$/g, '') ?? 'UNKNOWN';
    const ticker = args[1]?.repr?.replace(/^u?"?|"$/g, '') ?? '????';
    const score  = parseInt(args[3]?.repr?.replace(/^u/, '') ?? '50', 10);
    const sender = tx.sender_address ?? 'SP???';
    const ts     = tx.burn_block_time_iso ? new Date(tx.burn_block_time_iso) : null;

    return {
      id:      tx.tx_id,
      name:    name || 'UNKNOWN',
      ticker:  ticker || '????',
      score:   isNaN(score) ? 50 : Math.min(100, Math.max(1, score)),
      address: sender,
      time:    ts ? formatRelativeTime(ts) : 'recently',
    };
  } catch {
    return null;
  }
}

// Fetch semua TX dengan pagination sampai dapat semua register-cult
async function fetchAllCultTxs(): Promise<any[]> {
  const allTxs: any[] = [];
  let   offset = 0;
  const pageSize = 50;
  const maxPages = 10; // max 500 TX

  for (let page = 0; page < maxPages; page++) {
    try {
      const res = await fetch(
        `${STACKS_API_BASE}/extended/v1/address/${FACTORY_ADDRESS}.${FACTORY_NAME}/transactions?limit=${pageSize}&offset=${offset}`
      );
      if (!res.ok) break;
      const data: any = await res.json();
      const results: any[] = data?.results ?? [];
      if (results.length === 0) break;
      allTxs.push(...results);
      if (allTxs.length >= (data?.total ?? 0)) break;
      offset += pageSize;
    } catch {
      break;
    }
  }
  return allTxs;
}

// ─── LIVE FEED — latest 5, poll tiap 15 detik ────────────────────────────────
export function subscribeLiveFeed(
  onData: (entries: LiveCultEntry[]) => void,
  onError?: (err: Error) => void
): (() => void) | null {
  let cancelled = false;

  const poll = async () => {
    if (cancelled) return;
    try {
      // Fetch hanya page pertama (50 TX terbaru) untuk feed
      const res = await fetch(
        `${STACKS_API_BASE}/extended/v1/address/${FACTORY_ADDRESS}.${FACTORY_NAME}/transactions?limit=50&offset=0`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data: any    = await res.json();
      const txs: any[]   = data?.results ?? [];

      const entries: LiveCultEntry[] = txs
        .map(parseCultFromTx)
        .filter((e): e is LiveCultEntry => e !== null)
        .slice(0, 5); // latest 5

      if (!cancelled) onData(entries);
    } catch (err: any) {
      console.error('[Feed] poll error:', err?.message);
      if (!cancelled) onError?.(err);
    }
  };

  poll();
  const interval = setInterval(poll, 15_000); // refresh tiap 15 detik
  return () => { cancelled = true; clearInterval(interval); };
}

// ─── GLOBAL STATS — dari Stacks ───────────────────────────────────────────────
export function subscribeGlobalStats(
  onData: (stats: GlobalStats) => void,
  onError?: (err: Error) => void
): (() => void) | null {
  let cancelled = false;

  const fetchStats = async () => {
    if (cancelled) return;
    try {
      const allTxs = await fetchAllCultTxs();
      const deployers = new Set<string>();
      let   scoreSum  = 0;
      let   scoreCount = 0;

      for (const tx of allTxs) {
        const entry = parseCultFromTx(tx);
        if (!entry) continue;
        deployers.add(tx.sender_address);
        if (entry.score > 0) { scoreSum += entry.score; scoreCount++; }
      }

      if (!cancelled) onData({
        totalDeployments: allTxs.filter(tx => parseCultFromTx(tx) !== null).length,
        uniqueDeployers:  deployers.size,
        avgViralScore:    scoreCount > 0 ? Math.round((scoreSum / scoreCount) * 10) / 10 : 0,
      });
    } catch (err: any) {
      console.error('[Stats] error:', err?.message);
      if (!cancelled) onError?.(err);
    }
  };

  fetchStats();
  const interval = setInterval(fetchStats, 60_000);
  return () => { cancelled = true; clearInterval(interval); };
}

// ─── LEADERBOARD — top 20 dari Stacks blockchain ─────────────────────────────
export function subscribeLiveLeaderboard(
  onData: (entries: LeaderboardEntry[]) => void,
  onError?: (err: Error) => void
): (() => void) | null {
  let cancelled = false;

  const fetchLeaderboard = async () => {
    if (cancelled) return;
    try {
      const allTxs = await fetchAllCultTxs();
      const map    = new Map<string, { deployments: number; xp: number }>();

      for (const tx of allTxs) {
        const entry = parseCultFromTx(tx);
        if (!entry) continue;
        const addr  = tx.sender_address;
        const xp    = Math.floor(entry.score * 1.5);
        const prev  = map.get(addr) ?? { deployments: 0, xp: 0 };
        map.set(addr, { deployments: prev.deployments + 1, xp: prev.xp + xp });
      }

      const sorted = Array.from(map.entries())
        .sort((a, b) => b[1].xp - a[1].xp)
        .slice(0, 20); // top 20

      const entries: LeaderboardEntry[] = sorted.map(([address, stats], idx) => ({
        rank:        idx + 1,
        address,
        xp:          stats.xp,
        deployments: stats.deployments,
        title:       getRankTitle(stats.xp),
        badge:       getRankBadge(stats.xp),
      }));

      if (!cancelled) onData(entries);
    } catch (err: any) {
      console.error('[Leaderboard] error:', err?.message);
      if (!cancelled) onError?.(err);
    }
  };

  fetchLeaderboard();
  const interval = setInterval(fetchLeaderboard, 60_000);
  return () => { cancelled = true; clearInterval(interval); };
}

// ─── PUSH ke Firebase (saat deploy lewat web UI) ──────────────────────────────
export async function pushDeploymentToFeed(
  cult: {
    upgradedName: string;
    ticker: string;
    viralScore: number;
    lore: string;
    rawSVG: string;
  },
  walletAddress: string
): Promise<boolean> {
  const database = getDB();
  if (!database) return false;
  try {
    await addDoc(collection(database, 'deployments'), {
      name:      cult.upgradedName.slice(0, 100),
      ticker:    cult.ticker.slice(0, 10),
      score:     Math.min(100, Math.max(1, Number(cult.viralScore) || 50)),
      address:   walletAddress,
      lore:      (cult.lore   || '').slice(0, 500),
      rawSVG:    (cult.rawSVG || '').slice(0, 8000),
      timestamp: serverTimestamp(),
    });
    const statsRef  = doc(database, 'meta', 'global-stats');
    const statsSnap = await getDoc(statsRef);
    if (!statsSnap.exists()) {
      await setDoc(statsRef, { totalDeployments: 1, viralScoreSum: cult.viralScore, deployers: [walletAddress] });
    } else {
      await updateDoc(statsRef, { totalDeployments: increment(1), viralScoreSum: increment(cult.viralScore), deployers: arrayUnion(walletAddress) });
    }
    const xpGained     = Math.floor(cult.viralScore * 1.5);
    const deployerRef  = doc(database, 'deployers', walletAddress);
    const deployerSnap = await getDoc(deployerRef);
    if (!deployerSnap.exists()) {
      await setDoc(deployerRef, { address: walletAddress, totalDeployments: 1, totalXP: xpGained });
    } else {
      await updateDoc(deployerRef, { totalDeployments: increment(1), totalXP: increment(xpGained) });
    }
    return true;
  } catch (err: any) {
    console.error('[Firebase] push FAILED:', err?.code, err?.message);
    return false;
  }
}

export async function fetchOnChainDeploymentCount(): Promise<number> {
  try {
    const res = await fetch(
      `${STACKS_API_BASE}/extended/v1/address/${FACTORY_ADDRESS}.${FACTORY_NAME}/transactions?limit=1`
    );
    if (!res.ok) return 0;
    const data: any = await res.json();
    return data?.total ?? 0;
  } catch {
    return 0;
  }
}

export async function fetchStakingStats(): Promise<{
  totalLocked: number;
  stakerCount: number;
  rewardsPool: number;
}> {
  try {
    const callRead = (fn: string) => fetch(
      `${STACKS_API_BASE}/v2/contracts/call-read/${STAKING_ADDRESS}/${STAKING_NAME}/${fn}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: STAKING_ADDRESS, arguments: [] }),
      }
    ).then(r => r.json());

    const [lockedData, countData, poolData] = await Promise.all([
      callRead('get-total-locked'),
      callRead('get-staker-count'),
      callRead('get-rewards-pool'),
    ]);

    const parseClarityUint = (data: any): number => {
      try {
        const result: string = data?.result ?? '';
        if (!result || result === '0x') return 0;
        const hex     = result.replace(/^0x/, '').slice(6);
        const stripped = hex.replace(/^0+/, '') || '0';
        const big     = BigInt('0x' + stripped);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return 0;
        return Number(big);
      } catch {
        return 0;
      }
    };

    return {
      totalLocked: parseClarityUint(lockedData) / 1_000_000,
      stakerCount: parseClarityUint(countData),
      rewardsPool: parseClarityUint(poolData) / 1_000_000,
    };
  } catch {
    return { totalLocked: 0, stakerCount: 0, rewardsPool: 0 };
  }
}

export { isConfigured as isFirebaseConfigured };
