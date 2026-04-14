import Anthropic from '@anthropic-ai/sdk';
import cron from 'node-cron';
import fs from 'fs';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const DISCORD_WEBHOOK   = process.env.DISCORD_WEBHOOK_URL;
const THRESHOLD_55      = parseInt(process.env.PRICE_THRESHOLD_55 || '7000');
const THRESHOLD_65      = parseInt(process.env.PRICE_THRESHOLD_65 || '10000');
const CHECK_EVERY_HOURS = process.env.CHECK_INTERVAL_HOURS || '6';
const STATE_FILE        = '/tmp/alert_state.json';

// ─── Price Check ─────────────────────────────────────────────────────────────

async function checkPrices() {
  console.log(`[${new Date().toISOString()}] Starting price check...`);

  const messages = [
    {
      role: 'user',
      content: `Search for current prices of the LG C4 OLED TV in Denmark right now.
Look for both sizes on Danish price comparison sites and retailers:
- 55" model: OLED55C44LA / LG C4 55 tommer
- 65" model: OLED65C44LA / LG C4 65 tommer

Check sites like pricerunner.dk, prisjagt.dk, komplett.dk, elgiganten.dk, power.dk, avxperten.dk, etc.
Focus on NEW (not used) stock that is actually available to order.

Respond ONLY with raw JSON (no markdown fences, no explanation):
{
  "prices": [
    { "size": "55", "price_dkk": 6500, "retailer": "Komplett.dk", "url": "https://..." },
    { "size": "65", "price_dkk": 9800, "retailer": "Elgiganten.dk", "url": "https://..." }
  ]
}

If a size is not found anywhere, omit it. If nothing is found at all, return { "prices": [] }.`,
    },
  ];

  // Agentic loop — web_search may require multiple turns
  let finalText = null;
  for (let i = 0; i < 8; i++) {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1024,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      messages,
    });

    // Accumulate assistant turn
    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(b => b.type === 'text');
      if (textBlock) { finalText = textBlock.text; }
      break;
    }

    if (response.stop_reason === 'tool_use') {
      // Feed tool results back so the model can continue
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

  // Parse JSON
  let data;
  try {
    const clean = finalText.replace(/```json|```/g, '').trim();
    data = JSON.parse(clean);
  } catch (e) {
    console.error('Failed to parse JSON response:', finalText);
    return;
  }

  const prices = data.prices || [];
  console.log(`Found ${prices.length} price(s):`, prices);

  // Load persisted state (tracks lowest alerted price per size+retailer)
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}

  // Check each price against threshold
  for (const item of prices) {
    const threshold = item.size === '55' ? THRESHOLD_55 : THRESHOLD_65;

    if (item.price_dkk <= threshold) {
      const key = `${item.size}_${item.retailer.toLowerCase().replace(/\s/g, '_')}`;
      const lastAlerted = state[key] ?? Infinity;

      // Only alert if this is a new low (avoids spam on unchanged prices)
      if (item.price_dkk < lastAlerted) {
        console.log(`🔥 ALERT: ${item.size}" at ${item.price_dkk} kr from ${item.retailer}`);
        await sendDiscordAlert(item, threshold);
        state[key] = item.price_dkk;
      } else {
        console.log(`Skipped (already alerted at ${lastAlerted} kr): ${item.size}" @ ${item.retailer}`);
      }
    }
  }

  // Reset state entries if price has risen back above threshold (so future drops re-alert)
  for (const item of prices) {
    const threshold = item.size === '55' ? THRESHOLD_55 : THRESHOLD_65;
    const key = `${item.size}_${item.retailer.toLowerCase().replace(/\s/g, '_')}`;
    if (item.price_dkk > threshold && state[key] !== undefined) {
      console.log(`Price rose above threshold for ${item.size}" @ ${item.retailer}, resetting state.`);
      delete state[key];
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
    username: 'LG C4 Price Monitor',
    avatar_url: 'https://upload.wikimedia.org/wikipedia/commons/thumb/2/20/LG_symbol.svg/256px-LG_symbol.svg.png',
    embeds: [
      {
        title: `${emoji} LG C4 ${item.size}" – ${item.price_dkk.toLocaleString('da-DK')} kr.`,
        description: `Below your threshold of **${threshold.toLocaleString('da-DK')} kr.** by **${saving.toLocaleString('da-DK')} kr.**`,
        color: 0x00c853,
        fields: [
          { name: '💰 Price',    value: `**${item.price_dkk.toLocaleString('da-DK')} kr.**`, inline: true },
          { name: '🏪 Retailer', value: item.retailer,                                        inline: true },
          { name: '📉 Saving',   value: `${saving.toLocaleString('da-DK')} kr. under limit`, inline: true },
        ],
        ...(item.url ? { url: item.url } : {}),
        timestamp: new Date().toISOString(),
        footer: { text: 'LG C4 Price Monitor • Denmark' },
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

// ─── Startup ──────────────────────────────────────────────────────────────────

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('  LG C4 Price Monitor — Starting up');
console.log(`  55" threshold : ${THRESHOLD_55.toLocaleString('da-DK')} kr.`);
console.log(`  65" threshold : ${THRESHOLD_65.toLocaleString('da-DK')} kr.`);
console.log(`  Check interval: every ${CHECK_EVERY_HOURS} hours`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

// Run immediately on start, then on schedule
checkPrices().catch(console.error);

const cronExpr = `0 */${CHECK_EVERY_HOURS} * * *`;
cron.schedule(cronExpr, () => checkPrices().catch(console.error));
