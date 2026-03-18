const express = require('express');
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');

const router = express.Router();
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC, 'confirmed');

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
  let score = 0, reasons = [];
  if (!mintRenounced) { score += 25; reasons.push('Mint authority not renounced — supply can be inflated'); }
  if (!freezeRenounced) { score += 15; reasons.push('Freeze authority not renounced — wallets can be frozen'); }
  if (devHoldingPct > 20) { score += 30; reasons.push(`Dev holds ${devHoldingPct.toFixed(1)}% — very high dump risk`); }
  else if (devHoldingPct > 10) { score += 15; reasons.push(`Dev holds ${devHoldingPct.toFixed(1)}% — elevated dump risk`); }
  else if (devHoldingPct > 5) { score += 8; reasons.push(`Dev holds ${devHoldingPct.toFixed(1)}% — moderate allocation`); }
  if (topHolderPct > 25) { score += 20; reasons.push(`Top holder owns ${topHolderPct.toFixed(1)}% — extreme concentration`); }
  else if (topHolderPct > 15) { score += 12; reasons.push(`Top holder owns ${topHolderPct.toFixed(1)}% — high concentration`); }
  else if (topHolderPct > 8) { score += 5; reasons.push(`Top holder owns ${topHolderPct.toFixed(1)}% — moderate concentration`); }
  if (holderCount > 0 && holderCount < 10) { score += 15; reasons.push('Very few holders — low distribution'); }
  else if (holderCount > 0 && holderCount < 50) { score += 8; reasons.push('Low holder count — limited distribution'); }
  if (tokenAge !== null && tokenAge < 3600) { score += 5; reasons.push('Token is less than 1 hour old'); }
  if (rugHistory?.total > 1) {
    const rate = rugHistory.rugged / rugHistory.total;
    if (rate > 0.7) { score += 20; reasons.push(`Dev rugged ${rugHistory.rugged} of ${rugHistory.total} previous tokens`); }
    else if (rate > 0.4) { score += 10; reasons.push(`Dev poor track record — ${rugHistory.rugged}/${rugHistory.total} tokens failed`); }
  }
  if (washPct > 40) { score += 15; reasons.push(`${washPct.toFixed(0)}% of recent volume appears wash traded`); }
  else if (washPct > 20) { score += 8; reasons.push(`${washPct.toFixed(0)}% of volume shows wash trading patterns`); }
  return { score: Math.min(score, 100), reasons };
}

// ─── Get token metadata via Helius DAS ───────────────────────────────────────
async function getTokenMeta(address) {
  if (!HELIUS_KEY) return {};
  try {
    // Try fungible token metadata
    const r = await axios.post(`https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`, {
      jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: address, displayOptions: { showFungible: true } }
    }, { timeout: 8000 });
    const asset = r.data?.result;
    if (!asset) return {};
    return {
      name: asset.content?.metadata?.name,
      symbol: asset.content?.metadata?.symbol,
      image: asset.content?.links?.image || asset.content?.files?.[0]?.uri,
      creator: asset.ownership?.owner || asset.creators?.[0]?.address,
    };
  } catch(e) { return {}; }
}

// ─── Get holders via Solana RPC (proven to work) ─────────────────────────────
async function getHolders(mintPubkey, totalSupply, extraExclusions = []) {
  try {
    const largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
    const allExclusions = new Set([...EXCLUDED_ADDRESSES, ...extraExclusions]);

    const resolved = await Promise.all(
      largestAccounts.value.slice(0, 25).map(async (acc) => {
        let owner = acc.address.toBase58();
        try {
          const info = await connection.getParsedAccountInfo(acc.address);
          owner = info.value?.data?.parsed?.info?.owner || owner;
        } catch {}
        return { address: owner, pct: (parseInt(acc.amount) / totalSupply) * 100 };
      })
    );
    return resolved.filter(h => !allExclusions.has(h.address)).slice(0, 10);
  } catch { return []; }
}

// ─── Get market data via DexScreener ─────────────────────────────────────────
async function getMarketData(address) {
  try {
    const r = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 8000 });
    const pairs = r.data?.pairs;
    if (!Array.isArray(pairs) || pairs.length === 0) return null;
    // Prefer the most liquid pair
    return pairs.sort((a, b) => parseFloat(b.liquidity?.usd || 0) - parseFloat(a.liquidity?.usd || 0))[0];
  } catch { return null; }
}

// ─── Feature 1: Creator Rug History (FREE) ───────────────────────────────────
async function getCreatorHistory(creator) {
  if (!creator || !HELIUS_KEY) return null;
  try {
    const r = await axios.get(
      `https://api.helius.xyz/v0/addresses/${creator}/transactions?api-key=${HELIUS_KEY}&limit=100`,
      { timeout: 10000 }
    );
    const txns = Array.isArray(r.data) ? r.data : [];

    // Find pump.fun token creates — they have the pump program in accounts
    const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
    const creates = txns.filter(t =>
      t.type === 'CREATE' ||
      t.accountData?.some(a => a.account === PUMP_PROGRAM) ||
      t.instructions?.some(i => i.programId === PUMP_PROGRAM && i.data)
    );

    if (creates.length === 0) return { total: 0, survived: 0, rugged: 0, tokens: [] };

    const now = Date.now() / 1000;
    let survived = 0, rugged = 0;
    const tokens = creates.slice(0, 10).map(t => {
      const age = now - (t.timestamp || now);
      const isAlive = age < 7 * 86400;
      if (isAlive) survived++; else rugged++;
      return { name: t.description?.split(' ')?.[0] || 'Token', alive: isAlive, age: timeAgo(t.timestamp || now) };
    });

    return { total: creates.length, survived, rugged, tokens };
  } catch(e) { console.warn('[rugHistory]', e.message); return null; }
}

// ─── Feature 2: Sell Pressure Index (FREE) ───────────────────────────────────
async function getSellPressure(address) {
  if (!HELIUS_KEY) return null;
  try {
    const r = await axios.get(
      `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=100`,
      { timeout: 10000 }
    );
    const txns = Array.isArray(r.data) ? r.data : [];
    const swaps = txns.filter(t => t.type === 'SWAP' || t.type === 'SWAP_EXACT_IN' || t.type === 'SWAP_EXACT_OUT' || t.tokenTransfers?.length > 0);
    if (swaps.length === 0) return null;

    const buyers = new Set(), sellers = new Set();
    let buyCount = 0, sellCount = 0, buyVol = 0, sellVol = 0;

    swaps.forEach(t => {
      const wallet = t.feePayer;
      const vol = Math.abs(t.nativeTransfers?.reduce((s, tr) => s + (tr.amount || 0), 0) || 0);
      // If wallet received this token, it's a buy
      const received = t.tokenTransfers?.some(tr => tr.mint === address && tr.toUserAccount === wallet);
      if (received) { buyers.add(wallet); buyCount++; buyVol += vol; }
      else { sellers.add(wallet); sellCount++; sellVol += vol; }
    });

    const total = buyCount + sellCount;
    if (total === 0) return null;
    const sellRatio = parseFloat(((sellCount / total) * 100).toFixed(1));
    return {
      uniqueBuyers: buyers.size, uniqueSellers: sellers.size,
      buyCount, sellCount,
      buyVolSol: parseFloat((buyVol / 1e9).toFixed(3)),
      sellVolSol: parseFloat((sellVol / 1e9).toFixed(3)),
      sellRatio,
      label: sellRatio > 60 ? 'Selling Pressure' : sellRatio < 40 ? 'Buying Pressure' : 'Neutral',
      sampleSize: total,
    };
  } catch(e) { console.warn('[sellPressure]', e.message); return null; }
}

// ─── Feature 3: Wash Trading Detection (PRO) ─────────────────────────────────
async function getWashTrading(address) {
  if (!HELIUS_KEY) return null;
  try {
    const r = await axios.get(
      `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=200`,
      { timeout: 12000 }
    );
    const txns = Array.isArray(r.data) ? r.data : [];
    const swaps = txns.filter(t => t.tokenTransfers?.length > 0);
    if (swaps.length < 10) return null;

    const walletActivity = {};
    let totalVolume = 0;

    swaps.forEach(t => {
      const w = t.feePayer;
      const vol = Math.abs(t.nativeTransfers?.reduce((s, tr) => s + (tr.amount || 0), 0) || 0);
      totalVolume += vol;
      if (!walletActivity[w]) walletActivity[w] = { buyVol: 0, sellVol: 0 };
      const received = t.tokenTransfers?.some(tr => tr.mint === address && tr.toUserAccount === w);
      if (received) walletActivity[w].buyVol += vol;
      else walletActivity[w].sellVol += vol;
    });

    let washVolume = 0;
    const washWallets = [];
    Object.entries(walletActivity).forEach(([wallet, { buyVol, sellVol }]) => {
      if (buyVol > 0 && sellVol > 0) {
        washVolume += Math.min(buyVol, sellVol);
        washWallets.push({ address: wallet, buyVol: parseFloat((buyVol/1e9).toFixed(3)), sellVol: parseFloat((sellVol/1e9).toFixed(3)) });
      }
    });

    const washPct = totalVolume > 0 ? (washVolume / totalVolume) * 100 : 0;
    return {
      washPct: parseFloat(washPct.toFixed(1)),
      washWalletCount: washWallets.length,
      totalWallets: Object.keys(walletActivity).length,
      sampleSize: swaps.length,
      label: washPct > 40 ? 'High' : washPct > 20 ? 'Moderate' : 'Low',
      topWashWallets: washWallets.sort((a,b)=>(b.buyVol+b.sellVol)-(a.buyVol+a.sellVol)).slice(0,5),
    };
  } catch(e) { console.warn('[washTrading]', e.message); return null; }
}

// ─── Main scan ────────────────────────────────────────────────────────────────
router.get('/scan/:address', async (req, res, next) => {
  try {
    const { address } = req.params;
    let mintPubkey;
    try { mintPubkey = new PublicKey(address); } catch {
      return res.status(400).json({ error: 'Invalid token address' });
    }

    const cached = getCache(address);
    if (cached) return res.json(cached);

    // Run fetches in parallel
    const [mintInfo, metaData, dexData] = await Promise.all([
      connection.getParsedAccountInfo(mintPubkey),
      getTokenMeta(address),
      getMarketData(address),
    ]);

    const mintData = mintInfo.value?.data?.parsed?.info;
    const totalSupply = mintData?.supply ? parseInt(mintData.supply) : 1_000_000_000_000_000;

    // Build exclusion list dynamically from dex data
    const dynamicExclusions = [];
    if (dexData?.pairAddress) dynamicExclusions.push(dexData.pairAddress);

    // Get holders via Solana RPC
    const holders = await getHolders(mintPubkey, totalSupply, dynamicExclusions);

    // Token identity — DexScreener is most reliable for graduated tokens
    const name = dexData?.baseToken?.name || metaData.name || 'Unknown';
    const symbol = dexData?.baseToken?.symbol || metaData.symbol || '???';
    const image = dexData?.info?.imageUrl || metaData.image || null;

    // Creator
    const creator = metaData.creator || null;

    // Creation time
    const createdTs = dexData?.pairCreatedAt ? dexData.pairCreatedAt / 1000 : null;
    const tokenAge = createdTs ? Math.floor(Date.now()/1000 - createdTs) : null;

    // Authority checks
    const mintRenounced = !mintData?.mintAuthority;
    const freezeRenounced = !mintData?.freezeAuthority;

    // Dev / top holder
    const devHolder = creator ? holders.find(h => h.address === creator) : null;
    const devHoldingPct = devHolder ? devHolder.pct : 0;
    const topHolderPct = holders[0]?.pct || 0;

    // Graduation — check dex
    const isGraduated = dexData?.dexId === 'raydium' ||
      (dexData && dexData.dexId !== 'pump.fun') ||
      (dexData?.liquidity?.usd && parseFloat(dexData.liquidity.usd) > 15000);
    const liquidityQuote = parseFloat(dexData?.liquidity?.quote || 0);
    const solRaisedNum = isGraduated ? 85 : Math.min(liquidityQuote, 85);
    const bondingProgress = isGraduated ? 100 : parseFloat(((solRaisedNum / 85) * 100).toFixed(1));

    // Holder count
    const realHolderCount = dexData?.info?.holder || 0;

    // Market cap
    let marketCapK = '—';
    if (dexData?.marketCap) {
      const mc = parseFloat(dexData.marketCap);
      marketCapK = mc >= 1_000_000 ? `$${(mc/1_000_000).toFixed(2)}M` : mc >= 1000 ? `$${(mc/1000).toFixed(1)}K` : `$${mc.toFixed(0)}`;
    }

    // Three features in parallel
    const [rugHistory, sellPressure, washTrading] = await Promise.all([
      getCreatorHistory(creator),
      getSellPressure(address),
      getWashTrading(address),
    ]);

    const { score: riskScore, reasons } = calcRiskScore({
      mintRenounced, freezeRenounced, devHoldingPct, topHolderPct,
      holderCount: realHolderCount || holders.length, tokenAge,
      rugHistory, washPct: washTrading?.washPct || 0,
    });

    const result = {
      riskScore,
      riskReasons: reasons,
      token: { name, symbol, address, image },
      checks: {
        mintRenounced,
        mintDetail: mintRenounced ? 'No new tokens can ever be created. Supply is permanently fixed.' : 'The developer can mint unlimited new tokens at any time.',
        freezeRenounced,
        freezeDetail: freezeRenounced ? 'No wallet can be frozen. You can always sell your tokens.' : 'The developer can freeze any wallet, preventing you from selling.',
        devHoldingPct: parseFloat(devHoldingPct.toFixed(2)),
        devDetail: devHoldingPct === 0 ? 'Dev wallet not detected in top holders.' : devHoldingPct > 10 ? `Dev holds ${devHoldingPct.toFixed(2)}% — high dump risk.` : `Dev holds ${devHoldingPct.toFixed(2)}% — acceptable range.`,
        topHolderPct: parseFloat(topHolderPct.toFixed(2)),
        isGraduated,
        lpDetail: isGraduated ? 'Graduated to AMM. Trading on Raydium/PumpSwap.' : `${bondingProgress.toFixed(1)}% through the bonding curve. ${(85 - solRaisedNum).toFixed(1)} SOL to graduation.`,
      },
      holders,
      bondingCurve: {
        progress: bondingProgress,
        solRaised: isGraduated ? '85+' : solRaisedNum.toFixed(2),
        isGraduated,
      },
      stats: {
        marketCapK,
        age: createdTs ? timeAgo(createdTs) : '—',
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

// Debug
router.get('/debug/:address', async (req, res) => {
  const { address } = req.params;
  const out = { heliusKey: HELIUS_KEY ? 'present' : 'MISSING', rpc: RPC.slice(0,50) };

  try {
    const r = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 8000 });
    const p = r.data?.pairs;
    out.dexScreener = { pairCount: p?.length, first: p?.[0] ? { dexId: p[0].dexId, name: p[0].baseToken?.name, symbol: p[0].baseToken?.symbol, mcap: p[0].marketCap, liquidity: p[0].liquidity, created: p[0].pairCreatedAt, holders: p[0].info?.holder } : null };
  } catch(e) { out.dexScreener = { error: e.message }; }

  try {
    const mintInfo = await connection.getParsedAccountInfo(new PublicKey(address));
    const d = mintInfo.value?.data?.parsed?.info;
    out.mintInfo = { supply: d?.supply, mintAuthority: d?.mintAuthority, freezeAuthority: d?.freezeAuthority, decimals: d?.decimals };
  } catch(e) { out.mintInfo = { error: e.message }; }

  try {
    const r = await connection.getTokenLargestAccounts(new PublicKey(address));
    out.largestAccounts = { count: r.value.length, top3: r.value.slice(0,3).map(a => ({ address: a.address.toBase58(), amount: a.uiAmountString })) };
  } catch(e) { out.largestAccounts = { error: e.message }; }

  try {
    const r = await axios.get(`https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${HELIUS_KEY}&limit=5`, { timeout: 8000 });
    out.heliusTxns = { count: Array.isArray(r.data) ? r.data.length : 0, firstType: r.data?.[0]?.type };
  } catch(e) { out.heliusTxns = { error: e.message }; }

  res.json(out);
});

router.get('/scans-left', (req, res) => res.json({ scansLeft: 5 }));
module.exports = router;
