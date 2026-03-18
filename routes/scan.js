const express = require('express');
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');

const router = express.Router();
const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC, 'confirmed');

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

// Known LP / program addresses to exclude from holder analysis
const EXCLUDED_ADDRESSES = new Set([
  'TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM',
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
  'CebN5WGQ4jvEPvsVU4EoHEpgznyQHearzZAXmDGFMKca',
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJe1bwf',
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

  // Rug history adds to score
  if (rugHistory && rugHistory.total > 1) {
    const rugRate = rugHistory.rugged / rugHistory.total;
    if (rugRate > 0.7) { score += 20; reasons.push(`Dev has rugged ${rugHistory.rugged} of ${rugHistory.total} previous tokens`); }
    else if (rugRate > 0.4) { score += 10; reasons.push(`Dev has a poor track record — ${rugHistory.rugged}/${rugHistory.total} tokens failed`); }
  }

  // Wash trading adds to score
  if (washPct > 40) { score += 15; reasons.push(`${washPct.toFixed(0)}% of recent volume appears to be wash traded`); }
  else if (washPct > 20) { score += 8; reasons.push(`${washPct.toFixed(0)}% of recent volume shows wash trading patterns`); }

  return { score: Math.min(score, 100), reasons };
}

// ─── Feature 1: Creator Rug History (FREE) ───────────────────────────────────
// Fetches all tokens ever launched by this dev wallet from pump.fun
// A token is considered "dead" if its last trade was > 7 days ago
async function getCreatorHistory(creatorWallet) {
  if (!creatorWallet) return null;
  try {
    const r = await axios.get(
      `https://frontend-api.pump.fun/coins/user-created-coins/${creatorWallet}?offset=0&limit=50&includeNsfw=true`,
      { timeout: 8000 }
    );
    const coins = Array.isArray(r.data) ? r.data : [];
    if (coins.length === 0) return { total: 0, survived: 0, rugged: 0, tokens: [] };

    const now = Date.now() / 1000;
    const DEAD_THRESHOLD_DAYS = 7;

    let survived = 0;
    let rugged = 0;
    const tokens = coins.slice(0, 20).map(c => {
      // A token is alive if it has recent trade activity
      const lastActivity = c.last_trade_timestamp || c.created_timestamp || 0;
      const daysSinceActivity = (now - lastActivity) / 86400;
      const isAlive = daysSinceActivity < DEAD_THRESHOLD_DAYS || c.complete === true;
      if (isAlive) survived++; else rugged++;
      return {
        name: c.name,
        symbol: c.symbol,
        mint: c.mint,
        alive: isAlive,
        age: timeAgo(c.created_timestamp),
      };
    });

    return { total: coins.length, survived, rugged, tokens };
  } catch (e) {
    console.warn('[rugHistory] Failed:', e.message);
    return null;
  }
}

// ─── Feature 2: Sell Pressure Index (FREE) ───────────────────────────────────
// Fetches recent trades from pump.fun and counts unique buyers vs sellers
// Returns factual counts — no guesswork
async function getSellPressure(address) {
  try {
    const r = await axios.get(
      `https://frontend-api.pump.fun/trades/latest/${address}?limit=100&minimumSize=0`,
      { timeout: 8000 }
    );
    const trades = Array.isArray(r.data) ? r.data : [];
    if (trades.length === 0) return null;

    const buyers = new Set();
    const sellers = new Set();
    let buyVol = 0;
    let sellVol = 0;

    trades.forEach(t => {
      if (t.is_buy) {
        buyers.add(t.user);
        buyVol += t.sol_amount || 0;
      } else {
        sellers.add(t.user);
        sellVol += t.sol_amount || 0;
      }
    });

    const totalTrades = trades.length;
    const buyCount = trades.filter(t => t.is_buy).length;
    const sellCount = totalTrades - buyCount;

    return {
      uniqueBuyers: buyers.size,
      uniqueSellers: sellers.size,
      buyCount,
      sellCount,
      buyVolSol: parseFloat((buyVol / 1e9).toFixed(3)),
      sellVolSol: parseFloat((sellVol / 1e9).toFixed(3)),
      // Pressure: >60% sells = selling pressure, <40% = buying pressure
      sellRatio: parseFloat(((sellCount / totalTrades) * 100).toFixed(1)),
      label: sellCount / totalTrades > 0.6 ? 'Selling Pressure' : sellCount / totalTrades < 0.4 ? 'Buying Pressure' : 'Neutral',
      sampleSize: totalTrades,
    };
  } catch (e) {
    console.warn('[sellPressure] Failed:', e.message);
    return null;
  }
}

// ─── Feature 3: Wash Trading Detection (PRO) ─────────────────────────────────
// A wallet that BOTH buys AND sells the same token within a short window
// is a strong signal of wash trading. We look at the last 200 trades.
async function getWashTrading(address) {
  try {
    const r = await axios.get(
      `https://frontend-api.pump.fun/trades/latest/${address}?limit=200&minimumSize=0`,
      { timeout: 10000 }
    );
    const trades = Array.isArray(r.data) ? r.data : [];
    if (trades.length < 10) return null;

    // Track each wallet's buy and sell volumes
    const walletActivity = {};
    let totalVolume = 0;

    trades.forEach(t => {
      const w = t.user;
      const vol = t.sol_amount || 0;
      totalVolume += vol;
      if (!walletActivity[w]) walletActivity[w] = { buyVol: 0, sellVol: 0 };
      if (t.is_buy) walletActivity[w].buyVol += vol;
      else walletActivity[w].sellVol += vol;
    });

    // Wallets that both bought and sold are suspicious
    let washVolume = 0;
    const washWallets = [];
    Object.entries(walletActivity).forEach(([wallet, { buyVol, sellVol }]) => {
      if (buyVol > 0 && sellVol > 0) {
        // The wash volume is the minimum of buy/sell (the cycled amount)
        const cycled = Math.min(buyVol, sellVol);
        washVolume += cycled;
        washWallets.push({
          address: wallet,
          buyVol: parseFloat((buyVol / 1e9).toFixed(3)),
          sellVol: parseFloat((sellVol / 1e9).toFixed(3)),
        });
      }
    });

    const washPct = totalVolume > 0 ? (washVolume / totalVolume) * 100 : 0;

    return {
      washPct: parseFloat(washPct.toFixed(1)),
      washWalletCount: washWallets.length,
      totalWallets: Object.keys(walletActivity).length,
      sampleSize: trades.length,
      label: washPct > 40 ? 'High' : washPct > 20 ? 'Moderate' : 'Low',
      // Only expose top wash wallets for Pro
      topWashWallets: washWallets.sort((a,b) => (b.buyVol+b.sellVol)-(a.buyVol+a.sellVol)).slice(0,5),
    };
  } catch (e) {
    console.warn('[washTrading] Failed:', e.message);
    return null;
  }
}

// ─── Main scan route ─────────────────────────────────────────────────────────
router.get('/scan/:address', async (req, res, next) => {
  try {
    const { address } = req.params;
    let mintPubkey;
    try { mintPubkey = new PublicKey(address); } catch {
      return res.status(400).json({ error: 'Invalid token address' });
    }

    const cached = getCache(address);
    if (cached) return res.json(cached);

    // 1. Fetch pump.fun data
    let pumpData = null;
    try {
      const r = await axios.get(`https://frontend-api.pump.fun/coins/${address}`, { timeout: 8000 });
      pumpData = r.data;
    } catch {}

    if (!pumpData?.name) {
      try {
        const r = await axios.get(`https://client-api-2-74b1891ee9f9.herokuapp.com/coins/${address}`, { timeout: 8000 });
        pumpData = r.data;
      } catch {}
    }

    // DexScreener fallback
    let dexData = null;
    try {
      const r = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${address}`, { timeout: 8000 });
      dexData = r.data?.pairs?.[0];
    } catch {}

    // 2. Solana mint info
    const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
    const mintData = mintInfo.value?.data?.parsed?.info;

    // 3. Holders
    let holders = [];
    let totalSupply = 1_000_000_000_000_000;
    try {
      const largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
      if (mintData?.supply) totalSupply = parseInt(mintData.supply);
      holders = (await Promise.all(
        largestAccounts.value.slice(0, 20).map(async (acc) => {
          let owner = acc.address.toBase58();
          try {
            const info = await connection.getParsedAccountInfo(acc.address);
            owner = info.value?.data?.parsed?.info?.owner || owner;
          } catch {}
          return { address: owner, pct: (parseInt(acc.amount) / totalSupply) * 100 };
        })
      )).filter(h => !EXCLUDED_ADDRESSES.has(h.address)).slice(0, 10);
    } catch {}

    // 4. Bonding curve progress
    const GRADUATION_SOL = 85_000_000_000;
    let bondingProgress = 0;
    if (pumpData?.real_sol_reserves) {
      bondingProgress = Math.min((pumpData.real_sol_reserves / GRADUATION_SOL) * 100, 100);
    } else if (pumpData?.virtual_sol_reserves) {
      const virtualStart = 30_000_000_000;
      const virtualEnd = 115_000_000_000;
      bondingProgress = Math.max(0, Math.min(((pumpData.virtual_sol_reserves - virtualStart) / (virtualEnd - virtualStart)) * 100, 100));
    }

    // 5. Core checks
    const mintRenounced = !mintData?.mintAuthority;
    const freezeRenounced = !mintData?.freezeAuthority;
    const creator = pumpData?.creator || null;
    const devHolder = creator ? holders.find(h => h.address === creator) : null;
    const devHoldingPct = devHolder ? devHolder.pct : 0;
    const topHolderPct = holders[0]?.pct || 0;
    const tokenAge = pumpData?.created_timestamp ? Math.floor(Date.now()/1000) - pumpData.created_timestamp : null;

    // 6. Run the three new features in parallel
    const [rugHistory, sellPressure, washTrading] = await Promise.all([
      getCreatorHistory(creator),
      getSellPressure(address),
      getWashTrading(address),
    ]);

    const { score: riskScore, reasons } = calcRiskScore({
      mintRenounced, freezeRenounced, devHoldingPct, topHolderPct,
      holderCount: holders.length, tokenAge,
      rugHistory,
      washPct: washTrading?.washPct || 0,
    });

    // 7. Market cap
    let marketCapK = '—';
    if (pumpData?.usd_market_cap) {
      marketCapK = pumpData.usd_market_cap >= 1000 ? `$${(pumpData.usd_market_cap/1000).toFixed(1)}K` : `$${pumpData.usd_market_cap.toFixed(0)}`;
    } else if (dexData?.marketCap) {
      marketCapK = parseFloat(dexData.marketCap) >= 1000 ? `$${(parseFloat(dexData.marketCap)/1000).toFixed(1)}K` : `$${parseFloat(dexData.marketCap).toFixed(0)}`;
    }

    const result = {
      riskScore,
      riskReasons: reasons,
      token: {
        name: pumpData?.name || dexData?.baseToken?.name || 'Unknown',
        symbol: pumpData?.symbol || dexData?.baseToken?.symbol || '???',
        address,
        image: pumpData?.image_uri || dexData?.info?.imageUrl || null,
      },
      checks: {
        mintRenounced,
        mintDetail: mintRenounced
          ? 'No new tokens can ever be created. Supply is permanently fixed.'
          : 'The developer can mint unlimited new tokens at any time, diluting your holdings.',
        freezeRenounced,
        freezeDetail: freezeRenounced
          ? 'No wallet can be frozen. You can always sell your tokens.'
          : 'The developer can freeze any wallet, preventing you from selling.',
        devHoldingPct: parseFloat(devHoldingPct.toFixed(2)),
        devDetail: devHoldingPct === 0
          ? 'Dev wallet not detected in top holders.'
          : devHoldingPct > 10
          ? `Dev holds ${devHoldingPct.toFixed(2)}% — a large position that could crash the price if sold.`
          : `Dev holds ${devHoldingPct.toFixed(2)}% — within an acceptable range.`,
        topHolderPct: parseFloat(topHolderPct.toFixed(2)),
        lpDetail: bondingProgress < 100
          ? `Token is on the pump.fun bonding curve (${bondingProgress.toFixed(1)}% complete). LP is not applicable until graduation.`
          : 'Token has graduated to PumpSwap AMM. Check LP lock status separately.',
      },
      holders,
      bondingCurve: {
        progress: parseFloat(bondingProgress.toFixed(1)),
        solRaised: pumpData?.real_sol_reserves ? (pumpData.real_sol_reserves / 1_000_000_000).toFixed(2) : '0',
      },
      stats: {
        marketCapK,
        age: tokenAge !== null ? timeAgo(pumpData.created_timestamp) : '—',
        holders: holders.length,
        solRaised: pumpData?.real_sol_reserves ? (pumpData.real_sol_reserves / 1_000_000_000).toFixed(2) : '0',
      },
      // The three unique features
      rugHistory,       // FREE
      sellPressure,     // FREE
      washTrading,      // PRO
    };

    setCache(address, result);
    res.json(result);
  } catch (err) {
    console.error('[scan] Error:', err.message);
    next(err);
  }
});

router.get('/scans-left', (req, res) => res.json({ scansLeft: 5 }));
module.exports = router;
