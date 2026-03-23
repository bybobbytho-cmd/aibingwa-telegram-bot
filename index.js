// index.js
require('dotenv').config();
const { Bot } = require('grammy');
const express = require('express');
const { resolveUpDownMarketAndPrice } = require('./src/polymarket');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('Missing TELEGRAM_BOT_TOKEN');
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);
const PORT = process.env.PORT || 3000;

// Telegram commands (only 5m and 15m – you can add 60m later if you want)
bot.command('updownbtc5m', async (ctx) => {
  const result = await resolveUpDownMarketAndPrice({ asset: 'btc', interval: '5m' });
  if (result.found) {
    await ctx.reply(
      `📈 *${result.title}*\nSlug: \`${result.slug}\`\n\n` +
      `UP (mid): ${Math.round(result.upMid * 100)}¢\n` +
      `DOWN (mid): ${Math.round(result.downMid * 100)}¢\n\n` +
      `Source: Gamma + CLOB`,
      { parse_mode: 'Markdown' }
    );
  } else {
    await ctx.reply('❌ No active BTC 5m market.');
  }
});

bot.command('updownbtc15m', async (ctx) => {
  const result = await resolveUpDownMarketAndPrice({ asset: 'btc', interval: '15m' });
  if (result.found) {
    await ctx.reply(
      `📈 *${result.title}*\nSlug: \`${result.slug}\`\n\n` +
      `UP (mid): ${Math.round(result.upMid * 100)}¢\n` +
      `DOWN (mid): ${Math.round(result.downMid * 100)}¢\n\n` +
      `Source: Gamma + CLOB`,
      { parse_mode: 'Markdown' }
    );
  } else {
    await ctx.reply('❌ No active BTC 15m market.');
  }
});

bot.command('updowneth5m', async (ctx) => {
  const result = await resolveUpDownMarketAndPrice({ asset: 'eth', interval: '5m' });
  if (result.found) {
    await ctx.reply(
      `📈 *${result.title}*\nSlug: \`${result.slug}\`\n\n` +
      `UP (mid): ${Math.round(result.upMid * 100)}¢\n` +
      `DOWN (mid): ${Math.round(result.downMid * 100)}¢\n\n` +
      `Source: Gamma + CLOB`,
      { parse_mode: 'Markdown' }
    );
  } else {
    await ctx.reply('❌ No active ETH 5m market.');
  }
});

bot.command('updowneth15m', async (ctx) => {
  const result = await resolveUpDownMarketAndPrice({ asset: 'eth', interval: '15m' });
  if (result.found) {
    await ctx.reply(
      `📈 *${result.title}*\nSlug: \`${result.slug}\`\n\n` +
      `UP (mid): ${Math.round(result.upMid * 100)}¢\n` +
      `DOWN (mid): ${Math.round(result.downMid * 100)}¢\n\n` +
      `Source: Gamma + CLOB`,
      { parse_mode: 'Markdown' }
    );
  } else {
    await ctx.reply('❌ No active ETH 15m market.');
  }
});

bot.catch((err) => {
  console.error('Bot error:', err);
});

// ==================== PRICE API ====================
const app = express();

app.get('/api/price/:asset/:interval', async (req, res) => {
  const { asset, interval } = req.params;
  // Allow 5m, 15m, and 60m intervals
  if (!['btc', 'eth'].includes(asset) || !['5m', '15m', '60m'].includes(interval)) {
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

bot.start().catch(console.error);
