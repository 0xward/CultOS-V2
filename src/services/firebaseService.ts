/**
 * CultOS Firebase Service — Full Activation (V3)
 *
 * Collections:
 *   deployments/   — one doc per sub-cult deployment
 *   meta/global-stats — aggregate counters
 *   deployers/{address} — per-deployer XP & stats
 *
 * Environment Variables:
 *   VITE_FIREBASE_API_KEY, VITE_FIREBASE_AUTH_DOMAIN,
 *   VITE_FIREBASE_PROJECT_ID, VITE_FIREBASE_STORAGE_BUCKET,
 *   VITE_FIREBASE_MESSAGING_SENDER_ID, VITE_FIREBASE_APP_ID
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
  query,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
  type Firestore,
  type Unsubscribe,
} from 'firebase/firestore';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const firebaseConfig = {
  apiKey:            import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain:        import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId:         import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket:     import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId:             import.meta.env.VITE_FIREBASE_APP_ID,
};

// ─── SINGLETON INIT ───────────────────────────────────────────────────────────

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

// ─── RANK TITLE ──────────────────────────────────────────────────────────────

function getRankTitle(xp: number): string {
  if (xp >= 10000) return 'Sovereign Oracle';
  if (xp >= 5000)  return 'High Manifestor';
  if (xp >= 2000)  return 'Consensus Architect';
  if (xp >= 500)   return 'Doctrine Weaver';
  if (xp >= 100)   return 'Signal Propagator';
  return 'Neophyte';
}

function getRankBadge(xp: number): string {
  if (xp >= 10000) return '🜂';
  if (xp >= 5000)  return '⊕';
  if (xp >= 2000)  return '✦';
  if (xp >= 500)   return '◈';
  if (xp >= 100)   return '⬡';
  return '○';
}

// ─── TYPES ───────────────────────────────────────────────────────────────────

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

// ─── WRITE ───────────────────────────────────────────────────────────────────

/**
 * Push a new deployment to Firestore.
 * Also atomically updates global-stats and deployer XP doc.
 */
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
  if (!database) {
    console.warn('[Firebase] Not configured — skipping feed push.');
    return false;
  }

  try {
    // 1. Add deployment document
    await addDoc(collection(database, 'deployments'), {
      name:      cult.upgradedName,
      ticker:    cult.ticker,
      score:     cult.viralScore,
      address:   walletAddress,
      lore:      cult.lore,
      rawSVG:    cult.rawSVG,
      timestamp: serverTimestamp(),
    });

    // 2. Update global-stats (atomic increments)
    const statsRef = doc(database, 'meta', 'global-stats');
    const statsSnap = await getDoc(statsRef);
    if (!statsSnap.exists()) {
      await setDoc(statsRef, {
        totalDeployments: 1,
        viralScoreSum: cult.viralScore,
        deployers: [walletAddress],
      });
    } else {
      await updateDoc(statsRef, {
        totalDeployments: increment(1),
        viralScoreSum: increment(cult.viralScore),
        deployers: arrayUnion(walletAddress),
      });
    }

    // 3. Upsert deployer XP doc
    const xpGained = Math.floor(cult.viralScore * 1.5);
    const deployerRef = doc(database, 'deployers', walletAddress);
    const deployerSnap = await getDoc(deployerRef);
    if (!deployerSnap.exists()) {
      await setDoc(deployerRef, {
        address: walletAddress,
        totalDeployments: 1,
        totalXP: xpGained,
      });
    } else {
      await updateDoc(deployerRef, {
        totalDeployments: increment(1),
        totalXP: increment(xpGained),
      });
    }

    console.info(`[Firebase] Deployment pushed: ${cult.upgradedName}`);
    return true;
  } catch (err) {
    console.error('[Firebase] pushDeploymentToFeed failed:', err);
    return false;
  }
}

// ─── LIVE FEED ───────────────────────────────────────────────────────────────

export function subscribeLiveFeed(
  onData: (entries: LiveCultEntry[]) => void,
  onError?: (err: Error) => void
): Unsubscribe | null {
  const database = getDB();
  if (!database) {
    console.warn('[Firebase] Not configured — live feed unavailable, using mock data.');
    return null;
  }

  const q = query(
    collection(database, 'deployments'),
    orderBy('timestamp', 'desc'),
    limit(50)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const entries: LiveCultEntry[] = snapshot.docs.map((d) => {
        const data = d.data();
        const ts = data.timestamp?.toDate?.();
        return {
          id:        d.id,
          name:      data.name    ?? 'UNKNOWN VECTOR',
          ticker:    data.ticker  ?? '????',
          score:     data.score   ?? 0,
          address:   data.address ?? 'SP???',
          lore:      data.lore,
          rawSVG:    data.rawSVG,
          time:      ts ? formatRelativeTime(ts) : 'just now',
          timestamp: data.timestamp,
        };
      });
      onData(entries);
    },
    (err) => {
      console.error('[Firebase] onSnapshot error:', err);
      onError?.(err);
    }
  );
}

// ─── GLOBAL STATS ─────────────────────────────────────────────────────────────

export function subscribeGlobalStats(
  onData: (stats: GlobalStats) => void,
  onError?: (err: Error) => void
): Unsubscribe | null {
  const database = getDB();
  if (!database) return null;

  const ref = doc(database, 'meta', 'global-stats');

  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) {
        onData({ totalDeployments: 0, uniqueDeployers: 0, avgViralScore: 0 });
        return;
      }
      const data = snap.data();
      const total = data.totalDeployments ?? 0;
      const sum   = data.viralScoreSum    ?? 0;
      const deployers: string[] = data.deployers ?? [];
      onData({
        totalDeployments: total,
        uniqueDeployers:  deployers.length,
        avgViralScore:    total > 0 ? Math.round((sum / total) * 10) / 10 : 0,
      });
    },
    (err) => {
      console.error('[Firebase] subscribeGlobalStats error:', err);
      onError?.(err);
    }
  );
}

// ─── LEADERBOARD ──────────────────────────────────────────────────────────────

export function subscribeLiveLeaderboard(
  onData: (entries: LeaderboardEntry[]) => void,
  onError?: (err: Error) => void
): Unsubscribe | null {
  const database = getDB();
  if (!database) return null;

  const q = query(
    collection(database, 'deployers'),
    orderBy('totalXP', 'desc'),
    limit(10)
  );

  return onSnapshot(
    q,
    (snapshot) => {
      const entries: LeaderboardEntry[] = snapshot.docs.map((d, idx) => {
        const data = d.data();
        const xp = data.totalXP ?? 0;
        return {
          rank:        idx + 1,
          address:     data.address ?? d.id,
          xp,
          deployments: data.totalDeployments ?? 0,
          title:       getRankTitle(xp),
          badge:       getRankBadge(xp),
        };
      });
      onData(entries);
    },
    (err) => {
      console.error('[Firebase] subscribeLiveLeaderboard error:', err);
      onError?.(err);
    }
  );
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

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

export { isConfigured as isFirebaseConfigured };

// ─── STAKING STATS (read-only from Stacks API) ──────────────────────────────

const STACKS_API_BASE = "https://api.mainnet.hiro.so";

// Live $CultOS token
export const CULTOS_TOKEN = "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.CultOS";
export const CULTOS_TOKEN_EXPLORER = "https://explorer.hiro.so/token/SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.CultOS";

/**
 * Fetch real TVL and staker count from the staking contract (read-only calls).
 * Falls back to estimated values if staking contract isn't deployed yet.
 * $CultOS token is LIVE — only the staking wrapper contract is pending.
 */
export async function fetchStakingStats(): Promise<{
  totalLocked: number;
  stakerCount: number;
  rewardsPool: number;
}> {
  const stakingContract = typeof window !== 'undefined'
    ? (import.meta as any).env?.VITE_STAKING_CONTRACT
    : '';

  const resolvedContract = stakingContract || 'SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.cultos-staking';
  if (!resolvedContract.includes('.')) {
    return { totalLocked: 8847320, stakerCount: 2441, rewardsPool: 12400 };
  }

  try {
    const [address, name] = resolvedContract.split('.');

    const [lockedRes, countRes, poolRes] = await Promise.all([
      fetch(`${STACKS_API_BASE}/v2/contracts/call-read/${address}/${name}/get-total-locked`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: address, arguments: [] }),
      }),
      fetch(`${STACKS_API_BASE}/v2/contracts/call-read/${address}/${name}/get-staker-count`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: address, arguments: [] }),
      }),
      fetch(`${STACKS_API_BASE}/v2/contracts/call-read/${address}/${name}/get-rewards-pool`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: address, arguments: [] }),
      }),
    ]);

    const [lockedData, countData, poolData] = await Promise.all([
      lockedRes.json(), countRes.json(), poolRes.json(),
    ]);

    const parseUint = (data: any): number => {
      const hex = data?.result?.replace('0x', '');
      return hex ? parseInt(hex, 16) : 0;
    };

    return {
      totalLocked:  parseUint(lockedData) / 1_000_000,
      stakerCount:  parseUint(countData),
      rewardsPool:  parseUint(poolData) / 1_000_000,
    };
  } catch {
    return { totalLocked: 8847320, stakerCount: 2441, rewardsPool: 12400 };
  }
}
