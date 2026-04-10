// api_only.js – Minimal price API server (no Telegram bot)
require('dotenv').config();
const express = require('express');
const { resolveUpDownMarketAndPrice } = require('./src/polymarket');

const PORT = process.env.PORT || 3000;
const app = express();

app.get('/api/price/:asset/:interval', async (req, res) => {
  const { asset, interval } = req.params;
  if (!['btc', 'eth'].includes(asset) || !['5m', '15m', '1h'].includes(interval)) {
    return res.status(400).json({ error: 'Invalid asset or interval' });
  }

  try {
    const result = await resolveUpDownMarketAndPrice({ asset, interval });
    if (result.found) {
      res.json({
        asset,
        interval,
        title: result.title,
        slug: result.slug,
        up: result.upMid,
        down: result.downMid,
        upCents: Math.round(result.upMid * 100),
        downCents: Math.round(result.downMid * 100),
      });
    } else {
      res.status(404).json({ error: 'Market not found or inactive' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`📡 Price API running on port ${PORT}`);
});
