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

function calcRiskScore({ mintRenounced, freezeRenounced, devHoldingPct, topHolderPct, holderCount, bondingProgress, tokenAge }) {
  let score = 0;
  let reasons = [];

  // Mint authority not renounced = big risk
  if (!mintRenounced) {
    score += 25;
    reasons.push('Mint authority not renounced — supply can be inflated');
  }

  // Freeze authority not renounced
  if (!freezeRenounced) {
    score += 15;
    reasons.push('Freeze authority not renounced — wallets can be frozen');
  }

  // Dev holdings
  if (devHoldingPct > 20) {
    score += 30;
    reasons.push(`Dev holds ${devHoldingPct.toFixed(1)}% — very high dump risk`);
  } else if (devHoldingPct > 10) {
    score += 15;
    reasons.push(`Dev holds ${devHoldingPct.toFixed(1)}% — elevated dump risk`);
  } else if (devHoldingPct > 5) {
    score += 8;
    reasons.push(`Dev holds ${devHoldingPct.toFixed(1)}% — moderate allocation`);
  }

  // Top holder concentration
  if (topHolderPct > 25) {
    score += 20;
    reasons.push(`Top holder owns ${topHolderPct.toFixed(1)}% — extreme concentration`);
  } else if (topHolderPct > 15) {
    score += 12;
    reasons.push(`Top holder owns ${topHolderPct.toFixed(1)}% — high concentration`);
  } else if (topHolderPct > 8) {
    score += 5;
    reasons.push(`Top holder owns ${topHolderPct.toFixed(1)}% — moderate concentration`);
  }

  // Low holder count
  if (holderCount < 10) {
    score += 15;
    reasons.push('Very few holders — low distribution');
  } else if (holderCount < 50) {
    score += 8;
    reasons.push('Low holder count — limited distribution');
  }

  // Very new token
  if (tokenAge !== null && tokenAge < 3600) {
    score += 5;
    reasons.push('Token is less than 1 hour old');
  }

  return {
    score: Math.min(score, 100),
    reasons,
  };
}

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

      holders = await Promise.all(
        largestAccounts.value.slice(0, 10).map(async (acc) => {
          let owner = acc.address.toBase58();
          try {
            const info = await connection.getParsedAccountInfo(acc.address);
            owner = info.value?.data?.parsed?.info?.owner || owner;
          } catch {}
          return {
            address: owner,
            pct: (parseInt(acc.amount) / totalSupply) * 100,
            amount: acc.uiAmountString,
          };
        })
      );
    } catch {}

    // 4. Bonding curve progress
    // pump.fun curve completes at ~85 SOL real reserves (85_000_000_000 lamports)
    const GRADUATION_SOL = 85_000_000_000;
    let bondingProgress = 0;
    if (pumpData?.real_sol_reserves) {
      bondingProgress = Math.min((pumpData.real_sol_reserves / GRADUATION_SOL) * 100, 100);
    } else if (pumpData?.virtual_sol_reserves) {
      // virtual starts at 30 SOL, ends at ~115 SOL
      const virtualStart = 30_000_000_000;
      const virtualEnd = 115_000_000_000;
      const progress = (pumpData.virtual_sol_reserves - virtualStart) / (virtualEnd - virtualStart) * 100;
      bondingProgress = Math.max(0, Math.min(progress, 100));
    }

    // 5. Checks
    const mintRenounced = !mintData?.mintAuthority;
    const freezeRenounced = !mintData?.freezeAuthority;
    const creator = pumpData?.creator || null;
    const devHolder = creator ? holders.find(h => h.address === creator) : null;
    const devHoldingPct = devHolder ? devHolder.pct : 0;
    const topHolderPct = holders[0]?.pct || 0;
    const tokenAge = pumpData?.created_timestamp ? Math.floor(Date.now()/1000) - pumpData.created_timestamp : null;

    const { score: riskScore, reasons } = calcRiskScore({
      mintRenounced,
      freezeRenounced,
      devHoldingPct,
      topHolderPct,
      holderCount: holders.length,
      bondingProgress,
      tokenAge,
    });

    // 6. Market cap
    let marketCapK = '—';
    if (pumpData?.usd_market_cap) {
      marketCapK = pumpData.usd_market_cap >= 1000
        ? `$${(pumpData.usd_market_cap/1000).toFixed(1)}K`
        : `$${pumpData.usd_market_cap.toFixed(0)}`;
    } else if (dexData?.marketCap) {
      marketCapK = dexData.marketCap >= 1000
        ? `$${(dexData.marketCap/1000).toFixed(1)}K`
        : `$${parseFloat(dexData.marketCap).toFixed(0)}`;
    }

    const name = pumpData?.name || dexData?.baseToken?.name || 'Unknown';
    const symbol = pumpData?.symbol || dexData?.baseToken?.symbol || '???';
    const image = pumpData?.image_uri || dexData?.info?.imageUrl || null;

    const result = {
      riskScore,
      riskReasons: reasons,
      token: { name, symbol, address, image, description: pumpData?.description || '' },
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
        lpLocked: bondingProgress < 100,
        lpDetail: bondingProgress < 100
          ? `Token is on the pump.fun bonding curve (${bondingProgress.toFixed(1)}% complete). LP is not applicable until graduation.`
          : 'Token has graduated to PumpSwap AMM. Check LP lock status separately.',
      },
      holders,
      bondingCurve: {
        progress: parseFloat(bondingProgress.toFixed(1)),
        realSolReserves: pumpData?.real_sol_reserves || 0,
        graduationSol: 85,
        solRaised: pumpData?.real_sol_reserves ? (pumpData.real_sol_reserves / 1_000_000_000).toFixed(2) : '0',
      },
      stats: {
        marketCapK,
        age: tokenAge !== null ? timeAgo(pumpData.created_timestamp) : '—',
        holders: holders.length,
        txns: pumpData?.reply_count || dexData?.txns?.h24?.buys || 0,
      },
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
