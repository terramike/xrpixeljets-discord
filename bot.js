// bot.js — XRPixel Jets • Discord bot (fragment-handoff v2, no top-level await)

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  EmbedBuilder,
  SlashCommandBuilder,
  PermissionFlagsBits,
} from 'discord.js';
import { nanoid } from 'nanoid';

// ------- env -------
const {
  DISCORD_TOKEN,
  DISCORD_APP_ID,
  DISCORD_GUILD_ID,
  API_BASE = 'https://xrpixeljets.onrender.com',
  BOT_PUBLIC_URL = '',
  LINK_PAGE_BASE = 'https://mykeygo.io/jets/discord-link.html',
  ALLOWED_ORIGINS = 'https://mykeygo.io,https://www.mykeygo.io',
  PORT,
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_APP_ID) {
  console.error('[JetsBot] Missing DISCORD_TOKEN or DISCORD_APP_ID in env.');
  process.exit(1);
}

const PORT_FINAL = Number(PORT || process.env.PORT || 8787);
const allowedOrigins = ALLOWED_ORIGINS
  ? ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];

// ------- minimal stores (prototype) -------
/** code -> { uid, createdAt } */
const pendingLinks = new Map();
/** discordId -> { address, jwt, lastAt } */
const userBinds = new Map();

const now = () => Date.now();
const makeCode = () => nanoid(8);

// ------- Discord client / commands -------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commandDefs = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your XRPL wallet (Crossmark) to Discord for XRPixel Jets'),
  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Show your XRPixel Jets profile (energy, JetFuel, unlocked)'),
  new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Claim JETS on-ledger from your JetFuel balance')
    .addIntegerOption((o) =>
      o.setName('amount').setDescription('Amount of JETS to claim').setRequired(true)
    ),
].map((c) =>
  c.setDefaultMemberPermissions(PermissionFlagsBits.SendMessages).toJSON()
);

const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function registerCommands() {
  if (DISCORD_GUILD_ID) {
    await rest.put(
      Routes.applicationGuildCommands(DISCORD_APP_ID, DISCORD_GUILD_ID),
      { body: commandDefs }
    );
    console.log('[JetsBot] Registered guild commands.');
  } else {
    await rest.put(Routes.applicationCommands(DISCORD_APP_ID), { body: commandDefs });
    console.log('[JetsBot] Registered global commands.');
  }
}

// Helper: fetch JSON with headers
async function api(path, { method = 'GET', wallet = '', jwt = '', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (wallet) headers['X-Wallet'] = wallet;
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
  const res = await fetch(API_BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return {}; } })() : {};
  if (!res.ok) throw new Error(`${res.status} ${path} :: ${data.error || data.message || text}`);
  return data;
}

// Embeds
function profileEmbed(p) {
  const ms = p?.ms?.current || p?.ms?.base || {};
  return new EmbedBuilder()
    .setTitle('🛠️ XRPixel Jets — Profile')
    .addFields(
      { name: 'Energy', value: `${p.energy ?? 0}/${ms.energyCap ?? 100}`, inline: true },
      { name: 'Regen', value: `${ms.regenPerMin ?? 0}/min`, inline: true },
      { name: 'JetFuel', value: String(p.jetFuel ?? 0), inline: true },
      { name: 'Unlocked Wave', value: String(p.unlockedLevel ?? 1), inline: true }
    )
    .setColor(0x49f3ff)
    .setFooter({ text: 'Play at mykeygo.io/jets — claim on-ledger with Crossmark' });
}

// Build a WAF-safe handoff URL (bot URL in fragment; server never sees it)
function buildLinkUrl(code, uid) {
  const base = `${LINK_PAGE_BASE}?code=${encodeURIComponent(code)}&uid=${encodeURIComponent(uid)}`;
  if (BOT_PUBLIC_URL) return `${base}#bot=${encodeURIComponent(BOT_PUBLIC_URL)}`;
  return base; // page will fall back to default if hash missing
}

// ------- Discord interactions -------
client.on('interactionCreate', async (i) => {
  try {
    if (!i.isChatInputCommand()) return;

    if (i.commandName === 'link') {
      const code = makeCode();
      pendingLinks.set(code, { uid: i.user.id, createdAt: now() });
      setTimeout(() => pendingLinks.delete(code), 5 * 60 * 1000); // expire after 5 min

      const url = buildLinkUrl(code, i.user.id);
      await i.reply({
        content:
          `🔗 **Link your wallet**\n` +
          `1) Click: ${url}\n` +
          `2) Sign in with Crossmark\n` +
          `3) Return here and run \`/profile\`\n\n` +
          `Code expires in 5 minutes.`,
        ephemeral: true,
      });
      return;
    }

    if (i.commandName === 'profile') {
      const bind = userBinds.get(i.user.id);
      if (!bind) {
        await i.reply({ content: 'No wallet linked. Run `/link` first.', ephemeral: true });
        return;
      }
      const p = await api('/profile', { wallet: bind.address, jwt: bind.jwt });
      await i.reply({ embeds: [profileEmbed(p)], ephemeral: true });
      return;
    }

    if (i.commandName === 'claim') {
      const amt = i.options.getInteger('amount', true);
      if (amt <= 0) {
        await i.reply({ content: 'Enter a positive amount.', ephemeral: true });
        return;
      }
      const bind = userBinds.get(i.user.id);
      if (!bind) {
        await i.reply({ content: 'No wallet linked. Run `/link` first.', ephemeral: true });
        return;
      }

      await i.deferReply({ ephemeral: true });
      try {
        const res = await api('/claim/start', {
          method: 'POST',
          wallet: bind.address,
          jwt: bind.jwt,
          body: { amount: amt },
        });
        if (res?.txid) {
          await i.editReply(`✅ Claim sent: **${res.txid}**\nExplorer: https://xrpscan.com/tx/${res.txid}`);
        } else if (res?.txJSON) {
          await i.editReply('✅ Claim prepared (server not in hot mode).');
        } else {
          await i.editReply('✅ Claim acknowledged (mock mode).');
        }
      } catch (e) {
        const msg = String(e.message || '');
        if (msg.includes('trustline_required')) {
          await i.editReply('❗ Trustline required. Open the web game and click **Set Trustline**.');
        } else if (msg.includes('unauthorized')) {
          await i.editReply('🔐 JWT expired. Run `/link` again to refresh.');
        } else {
          await i.editReply('❌ Claim failed. Try again or check logs.');
        }
      }
      return;
    }
  } catch (err) {
    console.error(err);
    try {
      if (i.isRepliable()) {
        await i.reply({ content: 'Unexpected error 🤖', ephemeral: true });
      }
    } catch {}
  }
});

// ------- Webhook receiver -------
const app = express();
app.use(cors({ origin: allowedOrigins, credentials: false }));
app.use(express.json());

app.post('/api/link-complete', async (req, res) => {
  try {
    const { code, uid, address, jwt } = req.body || {};
    if (!code || !uid || !address || !jwt) {
      return res.status(400).json({ ok: false, error: 'bad_params' });
    }

    const pend = pendingLinks.get(code);
    if (!pend || pend.uid !== uid || now() - pend.createdAt > 5 * 60 * 1000) {
      return res.status(400).json({ ok: false, error: 'code_expired' });
    }

    // Validate JWT by calling /profile
    try {
      await api('/profile', { wallet: address, jwt });
    } catch {
      return res.status(401).json({ ok: false, error: 'jwt_invalid' });
    }

    pendingLinks.delete(code);
    userBinds.set(uid, { address, jwt, lastAt: now() });
    return res.json({ ok: true });
  } catch (e) {
    console.error('link-complete error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ------- boot -------
async function boot() {
  try {
    await registerCommands();
    await client.login(DISCORD_TOKEN);
    app.listen(PORT_FINAL, () => {
      console.log(`[JetsBot] Webhook listening on ${PORT_FINAL}`);
    });
  } catch (e) {
    console.error('[JetsBot] Boot error', e);
    process.exit(1);
  }
}
boot();
