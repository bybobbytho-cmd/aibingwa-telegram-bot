const { Bot } = require('grammy');
const express = require('express');
const { resolveUpDownMarketAndPrice } = require('./src/polymarket');

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const PORT = process.env.PORT || 3000;

// ==================== TELEGRAM BOT ====================
const bot = new Bot(TELEGRAM_TOKEN);

bot.command('start', (ctx) => ctx.reply(
  '🤖 *Polymarket Price Bot*\n\n' +
  'Commands:\n' +
  '/updownbtc5m – BTC 5m prices\n' +
  '/updownbtc15m – BTC 15m prices\n' +
  '/updowneth5m – ETH 5m prices\n' +
  '/updowneth15m – ETH 15m prices',
  { parse_mode: 'Markdown' }
));

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

// ==================== PRICE ORACLE API ====================
const app = express();

app.get('/api/price/:asset/:interval', async (req, res) => {
  const { asset, interval } = req.params;
  if (!['btc', 'eth'].includes(asset) || !['5m', '15m'].includes(interval)) {
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
  console.log(`📡 Price oracle API running on port ${PORT}`);
});

// Start the Telegram bot
bot.start().catch(console.error);
