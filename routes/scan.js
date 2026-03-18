const express = require('express');
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');

const router = express.Router();

const RPC = process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';
const connection = new Connection(RPC, 'confirmed');

// Cache scans for 2 minutes to avoid hammering RPC
const cache = new Map();
const CACHE_TTL = 2 * 60 * 1000;

function getCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) { cache.delete(key); return null; }
  return entry.data;
}
function setCache(key, data) {
  cache.set(key, { data, ts: Date.now() });
}

function timeAgo(timestamp) {
  const seconds = Math.floor((Date.now() / 1000) - timestamp);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds/60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds/3600)}h ago`;
  return `${Math.floor(seconds/86400)}d ago`;
}

function calcRiskScore(checks) {
  let score = 0;
  if (!checks.lpLocked) score += 30;
  if (!checks.mintRenounced) score += 25;
  if (!checks.freezeRenounced) score += 15;
  if (checks.devHoldingPct > 15) score += 20;
  else if (checks.devHoldingPct > 8) score += 10;
  if (checks.topHolder > 30) score += 10;
  return Math.min(score, 100);
}

// GET /api/scan/:address
router.get('/scan/:address', async (req, res, next) => {
  try {
    const { address } = req.params;

    // Validate address
    let mintPubkey;
    try { mintPubkey = new PublicKey(address); } catch {
      return res.status(400).json({ error: 'Invalid token address' });
    }

    // Check cache
    const cached = getCache(address);
    if (cached) return res.json(cached);

    // 1. Fetch pump.fun token data
    let pumpData = null;
    try {
      const pumpRes = await axios.get(`https://frontend-api.pump.fun/coins/${address}`, { timeout: 8000 });
      pumpData = pumpRes.data;
    } catch (e) {
      console.warn('[scan] pump.fun API failed:', e.message);
    }

    // 2. Fetch token mint info from Solana
    const mintInfo = await connection.getParsedAccountInfo(mintPubkey);
    const mintData = mintInfo.value?.data?.parsed?.info;

    // 3. Fetch largest token accounts (holders)
    let holders = [];
    try {
      const largestAccounts = await connection.getTokenLargestAccounts(mintPubkey);
      const totalSupply = mintData?.supply ? parseInt(mintData.supply) : 1_000_000_000_000_000;

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
          };
        })
      );
    } catch (e) {
      console.warn('[scan] holders fetch failed:', e.message);
    }

    // 4. Build checks
    const mintRenounced = !mintData?.mintAuthority;
    const freezeRenounced = !mintData?.freezeAuthority;
    const lpLocked = pumpData ? false : false; // pump.fun bonding curve tokens don't have traditional LP
    const devHoldingPct = pumpData?.creator
      ? holders.find(h => h.address === pumpData.creator)?.pct || 0
      : 0;
    const topHolder = holders[0]?.pct || 0;

    const bondingProgress = pumpData
      ? Math.min((pumpData.virtual_sol_reserves / 800) * 100, 100)
      : 0;

    const checks = {
      lpLocked,
      lpLockDuration: lpLocked ? '180 days' : 'N/A',
      lpLockPct: lpLocked ? 75 : 0,
      mintRenounced,
      freezeRenounced,
      devHoldingPct: parseFloat(devHoldingPct.toFixed(2)),
      topHolder: parseFloat(topHolder.toFixed(2)),
    };

    const riskScore = calcRiskScore(checks);

    // 5. Build stats
    const mcapSol = pumpData?.usd_market_cap
      ? pumpData.usd_market_cap
      : 0;

    const result = {
      riskScore,
      token: {
        name: pumpData?.name || 'Unknown',
        symbol: pumpData?.symbol || '???',
        address,
        image: pumpData?.image_uri || null,
        description: pumpData?.description || '',
      },
      checks,
      holders: holders.slice(0, 10),
      bondingCurve: {
        progress: parseFloat(bondingProgress.toFixed(1)),
      },
      stats: {
        marketCapK: mcapSol > 0 ? (mcapSol / 1000).toFixed(1) : '—',
        age: pumpData?.created_timestamp ? timeAgo(pumpData.created_timestamp) : '—',
        holders: holders.length,
        txns: pumpData?.reply_count || 0,
      },
    };

    setCache(address, result);
    res.json(result);
  } catch (err) {
    console.error('[scan] Error:', err.message);
    next(err);
  }
});

router.get('/scans-left', (req, res) => {
  res.json({ scansLeft: 5 });
});

module.exports = router;
