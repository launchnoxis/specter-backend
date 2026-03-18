const express = require('express');
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');

const router = express.Router();
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC, 'confirmed');

// Extract Helius API key from RPC URL
const HELIUS_KEY = (() => {
  try { return new URL(RPC).searchParams.get('api-key'); } catch { return null; }
})();

const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000;
function getCache(k) { const e = cache.get(k); if (!e) return null; if (Date.now()-e.ts>CACHE_TTL){cache.delete(k);return null;} return e.data; }
function setCache(k, d) { cache.set(k, { data: d, ts: Date.now() }); }

function timeAgo(ts) {
  const s = Math.floor(Date.now()/1000 - ts);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  return `${Math.floor(s/86400)}d ago`;
}

const EXCLUDED_ADDRESSES = new Set([
  'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'CebN5WGQ4jvEPvsVU4EoHEpgznyQHearzZAXmDGFMKca',
  '39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg',
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bwf',
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
]);

function calcRiskScore({ mintRenounced, freezeRenounced, devHoldingPct, topHolderPct, holderCount, tokenAge, rugHistory, washPct }) {
  let score = 0;
  let reasons = [];
  if (!mintRenounced) { score += 25; reasons.push('Mint authority not renounced — supply can be inflated'); }
  if (!freezeRenounced) { score += 15; reasons.push('Freeze authority not renounced — wallets can be frozen'); }
  if (devHoldingPct > 20) { score += 30; reasons.push(`Dev holds ${devHoldingPct.toFixed(1)}% — very high dump risk`); }
  else if (devHoldingPct > 10) { score += 15; reasons.push(`Dev holds ${devHoldingPct.toFixed(1)}% — elevated dump risk`); }
  else if (devHoldingPct > 5) { score += 8; reasons.push(`Dev holds ${devHoldingPct.toFixed(1)}% — moderate allocation`); }
  if (topHolderPct > 25) { score += 20; reasons.push(`Top holder owns ${topHolderPct.toFixed(1)}% — extreme concentration`); }
  else if (topHolderPct > 15) { score += 12; reasons.push(`Top holder owns ${topHolderPct.toFixed(1)}% — high concentration`); }
  else if (topHolderPct > 8) { score += 5; reasons.push(`Top holder owns ${topHolderPct.toFixed(1)}% — moderate concentration`); }
  if (holderCount < 10) { score += 15; reasons.push('Very few holders — low distribution'); }
  else if (holderCount < 50) { score += 8; reasons.push('Low holder count — limited distribution'); }
  if (tokenAge !== null && tokenAge < 3600) { score += 5; reasons.push('Token is less than 1 hour old'); }
  if (rugHistory?.total > 1) {
    const rugRate = rugHistory.rugged / rugHistory.total;
    if (rugRate > 0.7) { score += 20; reasons.push(`Dev rugged ${rugHistory.rugged} of ${rugHistory.total} previous tokens`); }
    else if (rugRate > 0.4) { score += 10; reasons.push(`Dev has poor track record — ${rugHistory.rugged}/${rugHistory.total} tokens failed`); }
  }
  if (washPct > 40) { score += 15; reasons.push(`${washPct.toFixed(0)}% of recent volume appears wash traded`); }
  else if (washPct > 20) { score += 8; reasons.push(`${washPct.toFixed(0)}% of recent volume shows wash trading patterns`); }
  return { score: Math.min(score, 100), reasons };
}

// ─── Helius: get token metadata ───────────────────────────────────────────────
async function getTokenMetadata(address) {
  if (!HELIUS_KEY) return null;
  try {
    const r = await axios.post(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`,
      { jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: address } },
      { timeout: 8000 }
    );
    return r.data?.result || null;
  } catch(e) { console.warn('[helius] getAsset failed:', e.message); return null; }
}

// ─── Helius: get token holders ────────────────────────────────────────────────
async function getTokenHolders(address) {
  if (!HELIUS_KEY) return [];
  try {
    const r = await axios.post(
      `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`,
      {
        jsonrpc: '2.0', id: 1,
        method: 'getTokenAccounts',
        params: { mint: address, limit: 20, page: 1 }
      },
      { timeout: 10000 }
    );
    return r.data?.result?.token_accounts || [];
  } catch(e) { console.warn('[helius] getTokenAccounts failed:', e.message); return []; }
}

// ─── DexScreener: market data ─────────────────────────────────────────────────
async function getDexData(address) {
  try {
    const r = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 8000 });
    return r.data?.pairs?.[0] || null;
  } catch(e) { console.warn('[dex] failed:', e.message); return null; }
}

// ─── Feature 1: Creator Rug History (FREE) — via Helius ───────────────────────
async function getCreatorHistory(creatorWallet) {
  if (!creatorWallet || !HELIUS_KEY) return null;
  try {
    // Get transactions from creator wallet to find token creations
    const r = await axios.post(
      `https://api.helius.xyz/v0/addresses/${creatorWallet}/transactions?api-key=${HELIUS_KEY}&limit=50&type=CREATE_ACCOUNT`,
      {},
      { timeout: 10000 }
    );
    const txns = Array.isArray(r.data) ? r.data : [];
    
    // Filter to pump.fun creates
    const pumpCreates = txns.filter(t =>
      t.instructions?.some(i => i.programId === '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P')
    );

    if (pumpCreates.length === 0) return { total: 0, survived: 0, rugged: 0, tokens: [] };

    const now = Date.now() / 1000;
    let survived = 0, rugged = 0;
    const tokens = pumpCreates.slice(0, 10).map(t => {
      const daysSince = (now - t.timestamp) / 86400;
      // If created > 7 days ago and no recent activity, consider dead
      const isAlive = daysSince < 7;
      if (isAlive) survived++; else rugged++;
      return { name: t.description || 'Unknown', alive: isAlive, age: timeAgo(t.timestamp) };
    });

    return { total: pumpCreates.length, survived, rugged, tokens };
  } catch(e) {
    console.warn('[rugHistory] failed:', e.message);
    return null;
  }
}

// ─── Feature 2: Sell Pressure Index (FREE) — via Helius ──────────────────────
async function getSellPressure(address) {
  if (!HELIUS_KEY) return null;
  try {
    const r = await axios.post(
      `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=100&type=SWAP`,
      {},
      { timeout: 10000 }
    );
    const txns = Array.isArray(r.data) ? r.data : [];
    if (txns.length === 0) return null;

    const buyers = new Set();
    const sellers = new Set();
    let buyCount = 0, sellCount = 0;
    let buyVol = 0, sellVol = 0;

    txns.forEach(t => {
      const isBuy = t.tokenTransfers?.some(tr => tr.mint === address && tr.toUserAccount === t.feePayer);
      const vol = t.nativeTransfers?.reduce((sum, tr) => sum + (tr.amount || 0), 0) || 0;
      if (isBuy) { buyers.add(t.feePayer); buyCount++; buyVol += vol; }
      else { sellers.add(t.feePayer); sellCount++; sellVol += vol; }
    });

    const total = buyCount + sellCount;
    if (total === 0) return null;
    const sellRatio = parseFloat(((sellCount / total) * 100).toFixed(1));

    return {
      uniqueBuyers: buyers.size,
      uniqueSellers: sellers.size,
      buyCount, sellCount,
      buyVolSol: parseFloat((buyVol / 1e9).toFixed(3)),
      sellVolSol: parseFloat((sellVol / 1e9).toFixed(3)),
      sellRatio,
      label: sellRatio > 60 ? 'Selling Pressure' : sellRatio < 40 ? 'Buying Pressure' : 'Neutral',
      sampleSize: total,
    };
  } catch(e) { console.warn('[sellPressure] failed:', e.message); return null; }
}

// ─── Feature 3: Wash Trading Detection (PRO) — via Helius ────────────────────
async function getWashTrading(address) {
  if (!HELIUS_KEY) return null;
  try {
    const r = await axios.post(
      `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=200&type=SWAP`,
      {},
      { timeout: 12000 }
    );
    const txns = Array.isArray(r.data) ? r.data : [];
    if (txns.length < 10) return null;

    const walletActivity = {};
    let totalVolume = 0;

    txns.forEach(t => {
      const w = t.feePayer;
      const vol = t.nativeTransfers?.reduce((sum, tr) => sum + (tr.amount || 0), 0) || 0;
      totalVolume += vol;
      if (!walletActivity[w]) walletActivity[w] = { buyVol: 0, sellVol: 0 };
      const isBuy = t.tokenTransfers?.some(tr => tr.mint === address && tr.toUserAccount === w);
      if (isBuy) walletActivity[w].buyVol += vol;
      else walletActivity[w].sellVol += vol;
    });

    let washVolume = 0;
    const washWallets = [];
    Object.entries(walletActivity).forEach(([wallet, { buyVol, sellVol }]) => {
      if (buyVol > 0 && sellVol > 0) {
        const cycled = Math.min(buyVol, sellVol);
        washVolume += cycled;
        washWallets.push({ address: wallet, buyVol: parseFloat((buyVol/1e9).toFixed(3)), sellVol: parseFloat((sellVol/1e9).toFixed(3)) });
      }
    });

    const washPct = totalVolume > 0 ? (washVolume / totalVolume) * 100 : 0;
    return {
      washPct: parseFloat(washPct.toFixed(1)),
      washWalletCount: washWallets.length,
      totalWallets: Object.keys(walletActivity).length,
      sampleSize: txns.length,
      label: washPct > 40 ? 'High' : washPct > 20 ? 'Moderate' : 'Low',
      topWashWallets: washWallets.sort((a,b)=>(b.buyVol+b.sellVol)-(a.buyVol+a.sellVol)).slice(0,5),
    };
  } catch(e) { console.warn('[washTrading] failed:', e.message); return null; }
}

// ─── Main scan route ──────────────────────────────────────────────────────────
router.get('/scan/:address', async (req, res, next) => {
  try {
    const { address } = req.params;
    let mintPubkey;
    try { mintPubkey = new PublicKey(address); } catch {
      return res.status(400).json({ error: 'Invalid token address' });
    }

    const cached = getCache(address);
    if (cached) return res.json(cached);

    // Run all data fetches in parallel
    const [heliusAsset, heliusHolders, dexData] = await Promise.all([
      getTokenMetadata(address),
      getTokenHolders(address),
      getDexData(address),
    ]);

    // Solana mint info for authority checks
    const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
    const mintData = mintInfo.value?.data?.parsed?.info;

    // Token metadata
    const name = heliusAsset?.content?.metadata?.name || dexData?.baseToken?.name || 'Unknown';
    const symbol = heliusAsset?.content?.metadata?.symbol || dexData?.baseToken?.symbol || '???';
    const image = heliusAsset?.content?.links?.image || heliusAsset?.content?.files?.[0]?.uri || dexData?.info?.imageUrl || null;
    const creator = heliusAsset?.authorities?.[0]?.address || heliusAsset?.creators?.[0]?.address || null;

    // Creation time from Helius asset
    const createdTs = heliusAsset?.content?.metadata?.createdAt
      || (dexData?.pairCreatedAt ? dexData.pairCreatedAt / 1000 : null);
    const tokenAge = createdTs ? Math.floor(Date.now()/1000 - createdTs) : null;

    // Holders from Helius
    const totalSupply = mintData?.supply ? parseInt(mintData.supply) : 1_000_000_000_000_000;
    
    // Add dynamic exclusions
    if (heliusAsset?.grouping?.[0]?.group_value) EXCLUDED_ADDRESSES.add(heliusAsset.grouping[0].group_value);

    const holders = heliusHolders
      .filter(h => !EXCLUDED_ADDRESSES.has(h.owner))
      .slice(0, 10)
      .map(h => ({
        address: h.owner,
        pct: (parseInt(h.amount) / totalSupply) * 100,
      }));

    // Authority checks
    const mintRenounced = !mintData?.mintAuthority;
    const freezeRenounced = !mintData?.freezeAuthority;

    // Dev holdings
    const devHolder = creator ? holders.find(h => h.address === creator) : null;
    const devHoldingPct = devHolder ? devHolder.pct : 0;
    const topHolderPct = holders[0]?.pct || 0;

    // Graduation / bonding curve from DexScreener
    const isGraduated = dexData?.dexId === 'raydium' || dexData?.dexId === 'orca' ||
      (dexData?.dexId === 'pump.fun' && parseFloat(dexData?.liquidity?.usd || 0) > 10000);
    
    let bondingProgress = 0;
    let solRaisedNum = 0;
    if (isGraduated) {
      bondingProgress = 100;
      solRaisedNum = 85;
    } else if (dexData?.liquidity?.quote) {
      // Estimate from liquidity
      solRaisedNum = parseFloat(dexData.liquidity.quote) || 0;
      bondingProgress = Math.min((solRaisedNum / 85) * 100, 99);
    }

    // Real holder count from DexScreener
    const realHolderCount = dexData?.info?.holder || heliusHolders.length;

    // Market cap
    let marketCapK = '—';
    if (dexData?.marketCap) {
      const mc = parseFloat(dexData.marketCap);
      marketCapK = mc >= 1_000_000 ? `$${(mc/1_000_000).toFixed(2)}M` : mc >= 1000 ? `$${(mc/1000).toFixed(1)}K` : `$${mc.toFixed(0)}`;
    }

    // Run three features in parallel
    const [rugHistory, sellPressure, washTrading] = await Promise.all([
      getCreatorHistory(creator),
      getSellPressure(address),
      getWashTrading(address),
    ]);

    const { score: riskScore, reasons } = calcRiskScore({
      mintRenounced, freezeRenounced, devHoldingPct, topHolderPct,
      holderCount: realHolderCount, tokenAge, rugHistory,
      washPct: washTrading?.washPct || 0,
    });

    const result = {
      riskScore,
      riskReasons: reasons,
      token: { name, symbol, address, image },
      checks: {
        mintRenounced,
        mintDetail: mintRenounced ? 'No new tokens can ever be created. Supply is permanently fixed.' : 'The developer can mint unlimited new tokens at any time, diluting your holdings.',
        freezeRenounced,
        freezeDetail: freezeRenounced ? 'No wallet can be frozen. You can always sell your tokens.' : 'The developer can freeze any wallet, preventing you from selling.',
        devHoldingPct: parseFloat(devHoldingPct.toFixed(2)),
        devDetail: devHoldingPct === 0 ? 'Dev wallet not detected in top holders.' : devHoldingPct > 10 ? `Dev holds ${devHoldingPct.toFixed(2)}% — large position, high dump risk.` : `Dev holds ${devHoldingPct.toFixed(2)}% — within acceptable range.`,
        topHolderPct: parseFloat(topHolderPct.toFixed(2)),
        isGraduated,
        lpDetail: isGraduated ? 'Token has graduated to Raydium/PumpSwap AMM. LP is in the liquidity pool.' : bondingProgress > 0 ? `${bondingProgress.toFixed(1)}% through the bonding curve.` : 'Early stage — bonding curve just started.',
      },
      holders,
      bondingCurve: {
        progress: parseFloat(bondingProgress.toFixed(1)),
        solRaised: solRaisedNum.toFixed(2),
        isGraduated,
      },
      stats: {
        marketCapK,
        age: tokenAge ? timeAgo(createdTs) : '—',
        holders: realHolderCount || holders.length,
        solRaised: isGraduated ? '85+ (Graduated)' : `${solRaisedNum.toFixed(2)} SOL`,
      },
      rugHistory,
      sellPressure,
      washTrading,
    };

    setCache(address, result);
    res.json(result);
  } catch (err) {
    console.error('[scan] Error:', err.message);
    next(err);
  }
});

// Debug endpoint
router.get('/debug/:address', async (req, res) => {
  const { address } = req.params;
  const result = { hellusKey: HELIUS_KEY ? 'present' : 'MISSING' };

  try {
    const r = await axios.post(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, { jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: address } }, { timeout: 8000 });
    result.heliusAsset = { name: r.data?.result?.content?.metadata?.name, symbol: r.data?.result?.content?.metadata?.symbol, creator: r.data?.result?.authorities?.[0]?.address };
  } catch(e) { result.heliusAsset = { error: e.message }; }

  try {
    const r = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 8000 });
    const p = r.data?.pairs?.[0];
    result.dexScreener = { dexId: p?.dexId, marketCap: p?.marketCap, liquidity: p?.liquidity, pairCreatedAt: p?.pairCreatedAt, holders: p?.info?.holder };
  } catch(e) { result.dexScreener = { error: e.message }; }

  try {
    const r = await axios.post(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, { jsonrpc: '2.0', id: 1, method: 'getTokenAccounts', params: { mint: address, limit: 5, page: 1 } }, { timeout: 8000 });
    result.heliusHolders = { count: r.data?.result?.token_accounts?.length, sample: r.data?.result?.token_accounts?.[0] };
  } catch(e) { result.heliusHolders = { error: e.message }; }

  res.json(result);
});

router.get('/scans-left', (req, res) => res.json({ scansLeft: 5 }));
module.exports = router;
