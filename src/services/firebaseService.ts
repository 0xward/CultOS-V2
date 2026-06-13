/**
 * CultOS Firebase Service — Full Activation (V3)
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
    const safeSVG  = (cult.rawSVG || '').slice(0, 8000);
    const safeLore = (cult.lore   || '').slice(0, 500);

    await addDoc(collection(database, 'deployments'), {
      name:      cult.upgradedName.slice(0, 100),
      ticker:    cult.ticker.slice(0, 10),
      score:     Math.min(100, Math.max(1, Number(cult.viralScore) || 50)),
      address:   walletAddress,
      lore:      safeLore,
      rawSVG:    safeSVG,
      timestamp: serverTimestamp(),
    });

    const statsRef  = doc(database, 'meta', 'global-stats');
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
        viralScoreSum:    increment(cult.viralScore),
        deployers:        arrayUnion(walletAddress),
      });
    }

    const xpGained    = Math.floor(cult.viralScore * 1.5);
    const deployerRef = doc(database, 'deployers', walletAddress);
    const deployerSnap = await getDoc(deployerRef);
    if (!deployerSnap.exists()) {
      await setDoc(deployerRef, { address: walletAddress, totalDeployments: 1, totalXP: xpGained });
    } else {
      await updateDoc(deployerRef, { totalDeployments: increment(1), totalXP: increment(xpGained) });
    }

    console.info(`[Firebase] Pushed: ${cult.upgradedName}`);
    return true;
  } catch (err: any) {
    console.error('[Firebase] pushDeploymentToFeed FAILED:', err?.code, err?.message);
    return false;
  }
}

export function subscribeLiveFeed(
  onData: (entries: LiveCultEntry[]) => void,
  onError?: (err: Error) => void
): Unsubscribe | null {
  const database = getDB();
  if (!database) return null;
  const q = query(collection(database, 'deployments'), orderBy('timestamp', 'desc'), limit(50));
  return onSnapshot(q,
    (snapshot) => {
      const entries: LiveCultEntry[] = snapshot.docs.map((d) => {
        const data = d.data();
        const ts   = data.timestamp?.toDate?.();
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
    (err) => { console.error('[Firebase] feed error:', err); onError?.(err); }
  );
}

export function subscribeGlobalStats(
  onData: (stats: GlobalStats) => void,
  onError?: (err: Error) => void
): Unsubscribe | null {
  const database = getDB();
  if (!database) return null;
  return onSnapshot(
    doc(database, 'meta', 'global-stats'),
    (snap) => {
      if (!snap.exists()) {
        onData({ totalDeployments: 0, uniqueDeployers: 0, avgViralScore: 0 });
        return;
      }
      const data      = snap.data();
      const total     = data.totalDeployments ?? 0;
      const sum       = data.viralScoreSum    ?? 0;
      const deployers = (data.deployers ?? []) as string[];
      onData({
        totalDeployments: total,
        uniqueDeployers:  deployers.length,
        avgViralScore:    total > 0 ? Math.round((sum / total) * 10) / 10 : 0,
      });
    },
    (err) => { console.error('[Firebase] stats error:', err); onError?.(err); }
  );
}

export function subscribeLiveLeaderboard(
  onData: (entries: LeaderboardEntry[]) => void,
  onError?: (err: Error) => void
): Unsubscribe | null {
  const database = getDB();
  if (!database) return null;
  const q = query(collection(database, 'deployers'), orderBy('totalXP', 'desc'), limit(10));
  return onSnapshot(q,
    (snapshot) => {
      const entries: LeaderboardEntry[] = snapshot.docs.map((d, idx) => {
        const data = d.data();
        const xp   = data.totalXP ?? 0;
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
    (err) => { console.error('[Firebase] leaderboard error:', err); onError?.(err); }
  );
}

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

const STACKS_API_BASE = "https://api.mainnet.hiro.so";
export const CULTOS_TOKEN          = "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.CultOS";
export const CULTOS_TOKEN_EXPLORER = "https://explorer.hiro.so/token/SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.CultOS";

export async function fetchOnChainDeploymentCount(): Promise<number> {
  try {
    const res = await fetch(
      `${STACKS_API_BASE}/extended/v1/contract/SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.cultos-factory-v2/events?limit=1`
    );
    if (!res.ok) return 0;
    const data = await res.json();
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
  const stakingContract = (import.meta as any).env?.VITE_STAKING_CONTRACT
    || 'SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF.cultos-staking';

  try {
    const [address, name] = stakingContract.split('.');

    const callRead = (fn: string) => fetch(
      `${STACKS_API_BASE}/v2/contracts/call-read/${address}/${name}/${fn}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sender: address, arguments: [] }),
      }
    ).then(r => r.json());

    const [lockedData, countData, poolData] = await Promise.all([
      callRead('get-total-locked'),
      callRead('get-staker-count'),
      callRead('get-rewards-pool'),
    ]);

    // Real response format from live contract:
    // {"okay":true,"result":"0x070100000000000000000000000000000014"}
    // 07 = ResponseOk, 01 = UInt type, then 16 bytes big-endian
    // Skip first 6 hex chars (3 bytes: 07 + 01 + padding start)
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
