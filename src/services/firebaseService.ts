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
  deployXp: number;
  gameXp: number;
  deployments: number;
  title: string;
  badge: string;
}

const STACKS_API_BASE = "https://api.mainnet.hiro.so";
const FACTORY_ADDRESS  = "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF";
const FACTORY_NAME     = "cultos-factory-v2";
const REWARDS_ADDRESS  = "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF";
const REWARDS_NAME     = "cultos-game-rewards-v4";
const STAKING_ADDRESS  = "SPQ189E66S20X7ATY7794HBY6743JE9YJMCKHAEF";
const STAKING_NAME     = "cultos-staking";

// Parse Clarity read-only result → number
// Handles: (ok uint) = 0x0701 + 16 bytes, plain uint = 0x01 + 16 bytes
function parseClarityUintResult(result: string): number {
  try {
    const hex = result.replace(/^0x/, '');
    if (!hex || hex === '09') return 0; // none or error

    let valueHex = '';
    if (hex.startsWith('0701')) {
      // (ok (uint N)) — 07=ok, 01=uint, then 16 bytes
      valueHex = hex.slice(4);
    } else if (hex.startsWith('01')) {
      // plain uint — 01=uint type, then 16 bytes
      valueHex = hex.slice(2);
    } else {
      return 0;
    }

    const stripped = valueHex.replace(/^0+/, '') || '0';
    const big = BigInt('0x' + stripped);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) return 0;
    return Number(big);
  } catch { return 0; }
}

// Read get-game-xp from cultos-game-rewards-v4 for a wallet
// Uses Hiro /v2/contracts/call-read with proper Clarity principal encoding
async function fetchOnChainGameXP(wallet: string): Promise<number> {
  try {
    // Import stacks/transactions to encode principal correctly
    const { principalCV, serializeCV } = await import('@stacks/transactions');
    const principalArg = principalCV(wallet);
    // serializeCV returns Uint8Array, convert to hex string with 0x prefix
    const serialized = serializeCV(principalArg);
    const argHex = "0x" + Array.from(serialized)
      .map((b: number) => b.toString(16).padStart(2, "0"))
      .join("");

    const res = await fetch(
      `${STACKS_API_BASE}/v2/contracts/call-read/${REWARDS_ADDRESS}/${REWARDS_NAME}/get-game-xp`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender: REWARDS_ADDRESS, arguments: [argHex] }),
      }
    );
    if (!res.ok) return 0;
    const data = await res.json();
    if (!data?.okay || !data?.result) return 0;
    return parseClarityUintResult(data.result);
  } catch (e) {
    console.warn('[fetchOnChainGameXP] error for', wallet, e);
    return 0;
  }
}

// Fetch all wallets that claimed from cultos-game-rewards-v4, then read on-chain XP
async function fetchGameRewardsWallets(): Promise<Map<string, number>> {
  const walletSet = new Set<string>();

  // Scan game-rewards contract for all claim-rewards callers
  const txs = await fetchTxsFromContract(`${REWARDS_ADDRESS}.${REWARDS_NAME}`);

  for (const tx of txs) {
    if (tx.tx_status !== 'success') continue;
    if (tx.tx_type !== 'contract_call') continue;
    if (tx.contract_call?.function_name !== 'claim-rewards') continue;
    if (tx.sender_address) walletSet.add(tx.sender_address);
  }

  console.info(`[gameRewards] unique claimers found: ${walletSet.size}`);

  // Batch-fetch on-chain game XP (authoritative from contract)
  const walletXP = new Map<string, number>();
  const wallets  = Array.from(walletSet);

  for (let i = 0; i < wallets.length; i += 5) {
    const batch   = wallets.slice(i, i + 5);
    const settled = await Promise.allSettled(batch.map(w => fetchOnChainGameXP(w)));
    settled.forEach((r, idx) => {
      const xp = r.status === 'fulfilled' ? r.value : 0;
      // Always store even if 0 so wallet appears on leaderboard for deploy XP
      walletXP.set(batch[idx], xp);
    });
  }

  return walletXP;
}

// ─── PRE-IMPORT @stacks/transactions ─────────────────────────────────────────
// Import once at module level to avoid per-call dynamic import overhead
import { principalCV, serializeCV } from '@stacks/transactions';

// ─── IN-MEMORY TX CACHE (5 minute TTL) ───────────────────────────────────────
const TX_CACHE = new Map<string, { data: any[]; fetchedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function getCached(key: string): any[] | null {
  const entry = TX_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > CACHE_TTL_MS) { TX_CACHE.delete(key); return null; }
  return entry.data;
}

function setCache(key: string, data: any[]) {
  TX_CACHE.set(key, { data, fetchedAt: Date.now() });
}

// ─── PARALLEL PAGE FETCHER ────────────────────────────────────────────────────
// 1. Fetch first page to get `total`
// 2. Fire all remaining pages in parallel
// 3. Merge and return
async function fetchTxsFromContract(contractId: string): Promise<any[]> {
  const cached = getCached(contractId);
  if (cached) return cached;

  const pageSize = 50;
  const url = (offset: number) =>
    `${STACKS_API_BASE}/extended/v1/address/${contractId}/transactions?limit=${pageSize}&offset=${offset}&unanchored=true`;

  try {
    // First page — also tells us the total
    const firstRes = await fetch(url(0));
    if (!firstRes.ok) return [];
    const firstData: any = await firstRes.json();
    const firstResults: any[] = firstData?.results ?? [];
    const total: number = firstData?.total ?? 0;

    if (total <= pageSize) {
      setCache(contractId, firstResults);
      return firstResults;
    }

    // Fire remaining pages in parallel
    const offsets: number[] = [];
    for (let o = pageSize; o < total; o += pageSize) offsets.push(o);

    const pages = await Promise.allSettled(
      offsets.map(o => fetch(url(o)).then(r => r.json()))
    );

    const allResults = [...firstResults];
    for (const p of pages) {
      if (p.status === 'fulfilled') allResults.push(...(p.value?.results ?? []));
    }

    setCache(contractId, allResults);
    return allResults;
  } catch {
    return [];
  }
}

// ─── FETCH ALL CULT TXs (factory v1 + v2 in parallel) ────────────────────────
async function fetchAllCultTxs(): Promise<any[]> {
  const [v1, v2] = await Promise.allSettled([
    fetchTxsFromContract(`${FACTORY_ADDRESS}.cultos-factory`),
    fetchTxsFromContract(`${FACTORY_ADDRESS}.${FACTORY_NAME}`),
  ]);
  const combined = [
    ...(v1.status === 'fulfilled' ? v1.value : []),
    ...(v2.status === 'fulfilled' ? v2.value : []),
  ];
  const seen = new Set<string>();
  return combined.filter(tx => {
    if (seen.has(tx.tx_id)) return false;
    seen.add(tx.tx_id);
    return true;
  });
}

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

// Parse Clarity repr string → plain string
// Hiro API repr for (string-utf8 N): "HYPE" or u"HYPE"
// Hiro API repr for (uint N):        u75
function parseReprString(repr: string | undefined): string {
  if (!repr) return '';
  // Strip optional leading u, then strip surrounding double-quotes
  return repr.replace(/^u?/, '').replace(/^"|"$/g, '').trim();
}

// Parse register-cult args dari satu TX
function parseCultFromTx(tx: any): LiveCultEntry | null {
  try {
    if (tx.tx_status !== 'success') return null;
    if (tx.tx_type !== 'contract_call') return null;
    if (tx.contract_call?.function_name !== 'register-cult') return null;

    const args   = tx.contract_call?.function_args ?? [];
    // Args: name(0), ticker(1), lore(2), viralScore(3), fee(4)
    const name   = parseReprString(args[0]?.repr) || 'UNKNOWN';
    const ticker = parseReprString(args[1]?.repr) || '????';
    const score  = parseInt((args[3]?.repr ?? '').replace(/^u/, ''), 10);
    const sender = tx.sender_address ?? 'SP???';
    const ts     = tx.burn_block_time_iso ? new Date(tx.burn_block_time_iso) : null;

    return {
      id:      tx.tx_id,
      name:    name,
      ticker:  ticker,
      score:   isNaN(score) ? 50 : Math.min(100, Math.max(1, score)),
      address: sender,
      time:    ts ? formatRelativeTime(ts) : 'recently',
    };
  } catch {
    return null;
  }
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
      // Fetch from both factory contracts, merge, sort by recency, take latest 8
      const [v1Res, v2Res] = await Promise.allSettled([
        fetchTxsFromContract(`${FACTORY_ADDRESS}.cultos-factory`),
        fetchTxsFromContract(`${FACTORY_ADDRESS}.${FACTORY_NAME}`),
      ]);

      const allTxs = [
        ...(v1Res.status === 'fulfilled' ? v1Res.value : []),
        ...(v2Res.status === 'fulfilled' ? v2Res.value : []),
      ];

      // Deduplicate
      const seen = new Set<string>();
      const unique = allTxs.filter(tx => {
        if (seen.has(tx.tx_id)) return false;
        seen.add(tx.tx_id);
        return true;
      });

      const entries: LiveCultEntry[] = unique
        .map(parseCultFromTx)
        .filter((e): e is LiveCultEntry => e !== null)
        .slice(0, 8); // latest 8

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

// ─── LEADERBOARD — deploy XP dari chain + game XP dari Firestore ─────────────
export function subscribeLiveLeaderboard(
  onData: (entries: LeaderboardEntry[]) => void,
  onError?: (err: Error) => void
): (() => void) | null {
  let cancelled = false;

  const fetchLeaderboard = async () => {
      if (cancelled) return;
      try {
        // STEP 1: Deploy XP from both factory contracts (fast — cached after first load)
        const allTxs    = await fetchAllCultTxs();
        const deployMap = new Map<string, { deployments: number; deployXp: number }>();

        for (const tx of allTxs) {
          const entry = parseCultFromTx(tx);
          if (!entry) continue;
          const addr = tx.sender_address;
          const xp   = Math.floor(entry.score * 1.5);
          const prev = deployMap.get(addr) ?? { deployments: 0, deployXp: 0 };
          deployMap.set(addr, { deployments: prev.deployments + 1, deployXp: prev.deployXp + xp });
        }

        // EARLY EMIT — show deploy-only leaderboard immediately (no waiting for game XP)
        const earlyEntries: LeaderboardEntry[] = Array.from(deployMap.entries())
          .map(([address, { deployXp, deployments }]) => ({
            rank: 0, address, xp: deployXp, deployXp, gameXp: 0, deployments,
            title: getRankTitle(deployXp), badge: getRankBadge(deployXp),
          }))
          .sort((a, b) => b.xp - a.xp)
          .slice(0, 20)
          .map((e, i) => ({ ...e, rank: i + 1 }));

        if (!cancelled && earlyEntries.length > 0) onData(earlyEntries);

        // STEP 2: Game XP in parallel with Firestore (slower — network calls per wallet)
        const [chainGameXpMap, firestoreResult] = await Promise.allSettled([
          fetchGameRewardsWallets(),
          (async () => {
            const database = getDB();
            const gameMap = new Map<string, number>();
            const depMap  = new Map<string, number>();
            if (!database) return { gameMap, depMap };
            try {
              const { getDocs, collection: col } = await import('firebase/firestore');
              const snap = await getDocs(col(database, 'deployers'));
              snap.forEach(d => {
                const data = d.data();
                if (typeof data.gameXP  === 'number' && data.gameXP  > 0) gameMap.set(d.id, data.gameXP);
                if (typeof data.deployXP === 'number' && data.deployXP > 0) depMap.set(d.id,  data.deployXP);
              });
            } catch {}
            return { gameMap, depMap };
          })(),
        ]);

        const chainGameMap = chainGameXpMap.status === 'fulfilled' ? chainGameXpMap.value : new Map<string, number>();
        const { gameMap: fsGameMap, depMap: fsDepMap } = firestoreResult.status === 'fulfilled'
          ? firestoreResult.value
          : { gameMap: new Map<string, number>(), depMap: new Map<string, number>() };

        // STEP 3: Merge all sources
        const allAddresses = new Set([
          ...Array.from(deployMap.keys()),
          ...Array.from(chainGameMap.keys()),
          ...Array.from(fsGameMap.keys()),
        ]);

        const combined = Array.from(allAddresses).map(address => {
          const chainDeploy = deployMap.get(address) ?? { deployments: 0, deployXp: 0 };
          const gameXp = chainGameMap.has(address) && chainGameMap.get(address)! > 0
            ? chainGameMap.get(address)!
            : fsGameMap.get(address) ?? 0;
          const deployXp = fsDepMap.has(address) ? fsDepMap.get(address)! : chainDeploy.deployXp;
          const totalXp  = deployXp + gameXp;
          return { address, deployXp, gameXp, totalXp, deployments: chainDeploy.deployments };
        });

        const entries: LeaderboardEntry[] = combined
          .sort((a, b) => b.totalXp - a.totalXp)
          .slice(0, 20)
          .map(({ address, deployXp, gameXp, totalXp, deployments }, idx) => ({
            rank: idx + 1, address, xp: totalXp, deployXp, gameXp, deployments,
            title: getRankTitle(totalXp), badge: getRankBadge(totalXp),
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

// ─── UPDATE GAME XP — dipanggil setelah claim berhasil ───────────────────────
export async function updateGameXP(
  walletAddress: string,
  xpGained: number
): Promise<boolean> {
  const database = getDB();
  if (!database) return false;
  try {
    const deployerRef  = doc(database, 'deployers', walletAddress);
    const deployerSnap = await getDoc(deployerRef);
    if (!deployerSnap.exists()) {
      await setDoc(deployerRef, {
        address:         walletAddress,
        totalDeployments: 0,
        totalXP:         xpGained,
        gameXP:          xpGained,
      });
    } else {
      await updateDoc(deployerRef, {
        totalXP: increment(xpGained),
        gameXP:  increment(xpGained),
      });
    }
    return true;
  } catch (err: any) {
    console.error('[Firebase] updateGameXP FAILED:', err?.code, err?.message);
    return false;
  }
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
      await setDoc(deployerRef, {
        address:          walletAddress,
        totalDeployments: 1,
        totalXP:          xpGained,
        deployXP:         xpGained,
        gameXP:           0,
      });
    } else {
      await updateDoc(deployerRef, {
        totalDeployments: increment(1),
        totalXP:          increment(xpGained),
        deployXP:         increment(xpGained),
      });
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
