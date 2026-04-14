import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import http from 'http';
import fs from 'fs';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DISCORD_WEBHOOK   = process.env.DISCORD_WEBHOOK_URL;
const CHECK_EVERY_HOURS = parseInt(process.env.CHECK_INTERVAL_HOURS || '6');
const STATE_FILE        = '/tmp/alert_state.json';

// ─── Health check server (keeps Railway happy) ────────────────────────────────

const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200);
  res.end('TV Price Monitor running\n');
}).listen(PORT, () => {
  console.log(`Health check server listening on port ${PORT}`);
});

// ─── Model Config ─────────────────────────────────────────────────────────────
//
// WATCHED_MODELS is a JSON array set via Railway env var, e.g.:
//
// [
//   { "name": "LG C4 55\"",  "query": "LG C4 55 tommer OLED55C44LA", "threshold": 7000 },
//   { "name": "LG C4 65\"",  "query": "LG C4 65 tommer OLED65C44LA", "threshold": 9500 },
//   { "name": "LG C5 65\"",  "query": "LG C5 65 tommer OLED65C54LA", "threshold": 11000 }
// ]

function loadModels() {
  const raw = process.env.WATCHED_MODELS;
  if (!raw) {
    return [
      { name: 'LG C4 55"', query: 'LG C4 55 tommer OLED55C44LA', threshold: 7000 },
      { name: 'LG C4 65"', query: 'LG C4 65 tommer OLED65C44LA', threshold: 9500 },
    ];
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error('Failed to parse WATCHED_MODELS env var — using defaults.', e.message);
    return [];
  }
}

// ─── Price Check ─────────────────────────────────────────────────────────────

async function checkPrices() {
  const models = loadModels();
  if (models.length === 0) {
    console.error('No models configured. Set WATCHED_MODELS env var.');
    return;
  }

  console.log(`[${new Date().toISOString()}] Checking ${models.length} model(s)...`);

  const modelList = models
    .map((m, i) => `${i + 1}. ${m.name} — search: "${m.query}"`)
    .join('\n');

  const responseShape = models
    .map(m => `  { "model": "${m.name}", "price_dkk": <number>, "retailer": "<string>", "url": "<string>" }`)
    .join(',\n');

  const messages = [
    {
      role: 'user',
      content: `Search for current NEW (in-stock) prices in Denmark for each of these TV models:

${modelList}

Check Danish retailers and price comparison sites: pricerunner.dk, prisjagt.dk, power.dk, elgiganten.dk, avxperten.dk, lbs.dk, and any others you find.

For each model, find the LOWEST current new-stock price available.

Respond ONLY with raw JSON (no markdown, no explanation):
{
  "prices": [
${responseShape}
  ]
}

Only include entries where you actually found a price. Omit models with no results.`,
    },
  ];

  let finalText = null;
  for (let i = 0; i < 10; i++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages,
    });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      if (textBlock) finalText = textBlock.text;
      break;
    }

    if (response.stop_reason === 'tool_use') {
      const toolResults = response.content
        .filter(b => b.type === 'tool_use')
        .map(b => ({
          type: 'tool_result',
          tool_use_id: b.id,
          content: b.output ?? '',
        }));
      messages.push({ role: 'user', content: toolResults });
    } else {
      break;
    }
  }

  if (!finalText) {
    console.error('No text response received from Claude.');
    return;
  }

  let data;
  try {
    const clean = finalText.replace(/```json|```/g, '').trim();
    data = JSON.parse(clean);
  } catch (e) {
    console.error('Failed to parse JSON response:', finalText);
    return;
  }

  const prices = data.prices || [];
  console.log(`Found ${prices.length} price(s):`, JSON.stringify(prices, null, 2));

  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}

  for (const item of prices) {
    const modelConfig = models.find(m => m.name === item.model);
    if (!modelConfig) {
      console.warn(`Unknown model in response: ${item.model}`);
      continue;
    }

    const { threshold } = modelConfig;
    const key = `${item.model}_${item.retailer}`.toLowerCase().replace(/\s/g, '_');

    if (item.price_dkk <= threshold) {
      const lastAlerted = state[key] ?? Infinity;
      if (item.price_dkk < lastAlerted) {
        console.log(`🔥 ALERT: ${item.model} at ${item.price_dkk} kr from ${item.retailer}`);
        await sendDiscordAlert(item, threshold);
        state[key] = item.price_dkk;
      } else {
        console.log(`Skipped (already alerted at ${lastAlerted} kr): ${item.model} @ ${item.retailer}`);
      }
    } else {
      if (state[key] !== undefined) {
        console.log(`Price rose above threshold for ${item.model} @ ${item.retailer}, resetting state.`);
        delete state[key];
      }
    }
  }

  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log(`[${new Date().toISOString()}] Check complete.`);
}

// ─── Discord Alert ────────────────────────────────────────────────────────────

async function sendDiscordAlert(item, threshold) {
  const saving = threshold - item.price_dkk;
  const emoji = saving >= 2000 ? '🚨' : saving >= 1000 ? '🔥' : '💡';

  const payload = {
    username: 'TV Price Monitor',
    avatar_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/20/LG_symbol.svg/256px-LG_symbol.svg.png',
    embeds: [
      {
        title: `${emoji} ${item.model} – ${item.price_dkk.toLocaleString('da-DK')} kr.`,
        description: `Below your threshold of **${threshold.toLocaleString('da-DK')} kr.** by **${saving.toLocaleString('da-DK')} kr.**`,
        color: 0x00c853,
        fields: [
          { name: '💰 Price',    value: `**${item.price_dkk.toLocaleString('da-DK')} kr.**`, inline: true },
          { name: '🏪 Retailer', value: item.retailer,                                        inline: true },
          { name: '📉 Saving',   value: `${saving.toLocaleString('da-DK')} kr. under limit`, inline: true },
        ],
        ...(item.url ? { url: item.url } : {}),
        timestamp: new Date().toISOString(),
        footer: { text: 'TV Price Monitor • Denmark' },
      },
    ],
  };

  const res = await fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    console.error('Discord webhook error:', res.status, await res.text());
  }
}

// ─── Startup + Scheduler ──────────────────────────────────────────────────────

const models = loadModels();
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  TV Price Monitor — Starting up');
models.forEach(m => console.log(`  ${m.name.padEnd(16)} threshold: ${m.threshold.toLocaleString('da-DK')} kr.`));
console.log(`  Check interval : every ${CHECK_EVERY_HOURS} hours`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Run immediately on start
checkPrices().catch(console.error);

// Schedule — for intervals >24h we use a daily cron and track time manually
if (CHECK_EVERY_HOURS <= 24) {
  const cronExpr = `0 */${CHECK_EVERY_HOURS} * * *`;
  cron.schedule(cronExpr, () => checkPrices().catch(console.error));
} else {
  // Fall back to setInterval for multi-day intervals
  const ms = CHECK_EVERY_HOURS * 60 * 60 * 1000;
  setInterval(() => checkPrices().catch(console.error), ms);
}
