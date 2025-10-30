// bot.js — XRPixel Jets • Discord bot (wallet link + claims + missions + logs)
// - /link (WAF-safe #bot handoff)  /profile  /claim <amount>  /whoami  /unlink
// - /mission start [mission]  /mission turn  /mission finish
// - Optional broadcast to #battle-log via BATTLE_LOG_CHANNEL_ID
// Requirements: Node >=18, discord.js v14, express, cors, dotenv, nanoid

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
  BATTLE_LOG_CHANNEL_ID = '',
  COMMAND_REPLIES_PUBLIC = 'false',
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_APP_ID) {
  console.error('[JetsBot] Missing DISCORD_TOKEN or DISCORD_APP_ID in env.');
  process.exit(1);
}

const PORT_FINAL = Number(PORT || process.env.PORT || 8787);
const allowedOrigins = ALLOWED_ORIGINS
  ? ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)
  : [];
const repliesPublic = String(COMMAND_REPLIES_PUBLIC).toLowerCase() === 'true';

// ------- stores -------
const pendingLinks = new Map(); // code -> { uid, createdAt }
const userBinds = new Map();    // discordId -> { address, jwt, lastAt }

// ------- utils -------
const now = () => Date.now();
const makeCode = () => nanoid(8);

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
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch {}
  if (!res.ok) throw new Error(`${res.status} ${path} :: ${data.error || data.message || text}`);
  return data;
}

function buildLinkUrl(code, uid) {
  const base = `${LINK_PAGE_BASE}?code=${encodeURIComponent(code)}&uid=${encodeURIComponent(uid)}`;
  if (BOT_PUBLIC_URL) return `${base}#bot=${encodeURIComponent(BOT_PUBLIC_URL)}`;
  return base;
}

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

function whoamiEmbed(bind) {
  return new EmbedBuilder()
    .setTitle('🧩 Wallet Link')
    .setDescription('This Discord user is linked to:')
    .addFields(
      { name: 'Address', value: bind.address, inline: false },
      { name: 'Linked', value: `<t:${Math.floor(bind.lastAt / 1000)}:R>`, inline: true }
    )
    .setColor(0x49f3ff);
}

function battleEmbed(title, payload = {}) {
  // Try to extract a short log + HP + reward; robust to unknown shapes.
  const log = payload.log || payload.combatLog || payload.messages || [];
  const lastLines = Array.isArray(log) ? log.slice(-4).join('\n') : String(log || '');
  const youHP = payload.youHP ?? payload.playerHP ?? payload.hp ?? payload?.player?.hp;
  const enemyHP = payload.enemyHP ?? payload.enemyhp ?? payload?.enemy?.hp;
  const reward = payload.reward ?? payload.rewards ?? payload.jetFuel ?? payload.jf ?? null;

  const fields = [];
  if (youHP != null) fields.push({ name: 'Your HP', value: String(youHP), inline: true });
  if (enemyHP != null) fields.push({ name: 'Enemy HP', value: String(enemyHP), inline: true });
  if (reward != null) fields.push({ name: 'Reward', value: String(reward), inline: true });

  const e = new EmbedBuilder()
    .setTitle(title)
    .setColor(0x49f3ff);

  if (fields.length) e.addFields(...fields);
  if (lastLines) e.setDescription('```' + lastLines + '```');
  return e;
}

async function broadcastBattleLog(client, summary) {
  if (!BATTLE_LOG_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(BATTLE_LOG_CHANNEL_ID);
    // send a concise line; Discord embeds are heavier, keep it light
    const line = typeof summary === 'string' ? summary : 'Battle update';
    await ch.send(line);
  } catch (e) {
    console.warn('[JetsBot] battle-log broadcast failed:', e?.message || e);
  }
}

// ------- Discord client / commands -------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

const commands = [
  new SlashCommandBuilder().setName('link').setDescription('Link your XRPL wallet (Crossmark) to Discord'),
  new SlashCommandBuilder().setName('profile').setDescription('Show your XRPixel Jets profile'),
  new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Claim JETS on-ledger from your JetFuel')
    .addIntegerOption(o => o.setName('amount').setDescription('Amount of JETS to claim').setRequired(true)),
  new SlashCommandBuilder().setName('whoami').setDescription('Show linked wallet address'),
  new SlashCommandBuilder().setName('unlink').setDescription('Unlink your wallet from this Discord user'),
  // Missions with subcommands
  new SlashCommandBuilder()
    .setName('mission')
    .setDescription('Run missions in Discord')
    .addSubcommand(sc =>
      sc.setName('start')
        .setDescription('Start a mission')
        .addIntegerOption(o => o.setName('mission').setDescription('Mission/Wave number').setRequired(false))
    )
    .addSubcommand(sc =>
      sc.setName('turn')
        .setDescription('Advance the mission one turn')
    )
    .addSubcommand(sc =>
      sc.setName('finish')
        .setDescription('Finish/resolve the mission')
    ),
].map(c => c.setDefaultMemberPermissions(PermissionFlagsBits.SendMessages).toJSON());

async function registerCommands() {
  if (DISCORD_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(DISCORD_APP_ID, DISCORD_GUILD_ID), { body: commands });
    console.log('[JetsBot] Registered guild commands.');
  } else {
    await rest.put(Routes.applicationCommands(DISCORD_APP_ID), { body: commands });
    console.log('[JetsBot] Registered global commands.');
  }
}

client.on('interactionCreate', async (i) => {
  try {
    if (!i.isChatInputCommand()) return;
    const ephemeral = !repliesPublic;

    if (i.commandName === 'link') {
      const code = makeCode();
      pendingLinks.set(code, { uid: i.user.id, createdAt: now() });
      setTimeout(() => pendingLinks.delete(code), 5 * 60 * 1000);
      const url = buildLinkUrl(code, i.user.id);
      await i.reply({
        content:
          `🔗 **Link your wallet**\n` +
          `1) Click: ${url}\n` +
          `2) Sign in with Crossmark\n` +
          `3) Return here and run \`/profile\`\n\n` +
          `Code expires in 5 minutes.`,
        ephemeral,
      });
      return;
    }

    if (i.commandName === 'profile') {
      const bind = userBinds.get(i.user.id);
      if (!bind) return i.reply({ content: 'No wallet linked. Run `/link` first.', ephemeral });
      const p = await api('/profile', { wallet: bind.address, jwt: bind.jwt });
      await i.reply({ embeds: [profileEmbed(p)], ephemeral });
      return;
    }

    if (i.commandName === 'whoami') {
      const bind = userBinds.get(i.user.id);
      if (!bind) return i.reply({ content: 'No wallet linked. Run `/link` first.', ephemeral });
      await i.reply({ embeds: [whoamiEmbed(bind)], ephemeral });
      return;
    }

    if (i.commandName === 'unlink') {
      userBinds.delete(i.user.id);
      await i.reply({ content: '🔓 Unlinked. Run `/link` to connect a wallet again.', ephemeral });
      return;
    }

    if (i.commandName === 'claim') {
      const amt = i.options.getInteger('amount', true);
      if (amt <= 0) return i.reply({ content: 'Enter a positive amount.', ephemeral });

      const bind = userBinds.get(i.user.id);
      if (!bind) return i.reply({ content: 'No wallet linked. Run `/link` first.', ephemeral });

      await i.deferReply({ ephemeral });
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
        if (msg.includes('trustline_required')) return i.editReply('❗ Trustline required. Open the web game and click **Set Trustline**.');
        if (msg.includes('unauthorized'))        return i.editReply('🔐 JWT expired. Run `/link` again to refresh.');
        return i.editReply('❌ Claim failed. Try again or check logs.');
      }
      return;
    }

    if (i.commandName === 'mission') {
      const sub = i.options.getSubcommand();
      const bind = userBinds.get(i.user.id);
      if (!bind) return i.reply({ content: 'No wallet linked. Run `/link` first.', ephemeral });

      await i.deferReply({ ephemeral });
      try {
        if (sub === 'start') {
          const missionNum = i.options.getInteger('mission') ?? undefined;
          const body = missionNum ? { mission: missionNum } : undefined;
          const res = await api('/battle/start', { method: 'POST', wallet: bind.address, jwt: bind.jwt, body });
          const emb = battleEmbed('🚀 Mission started', res);
          await i.editReply({ embeds: [emb] });
          if (BATTLE_LOG_CHANNEL_ID) {
            await broadcastBattleLog(client, `🚀 ${i.user.username} started a mission${missionNum ? ` #${missionNum}` : ''}.`);
          }
        }
        else if (sub === 'turn') {
          const res = await api('/battle/turn', { method: 'POST', wallet: bind.address, jwt: bind.jwt, body: {} });
          const emb = battleEmbed('🎯 Mission turn', res);
          await i.editReply({ embeds: [emb] });
          if (BATTLE_LOG_CHANNEL_ID) await broadcastBattleLog(client, `🎯 ${i.user.username} advanced a mission.`);
        }
        else if (sub === 'finish') {
          const res = await api('/battle/finish', { method: 'POST', wallet: bind.address, jwt: bind.jwt, body: {} });
          const emb = battleEmbed('🏁 Mission finished', res);
          await i.editReply({ embeds: [emb] });
          if (BATTLE_LOG_CHANNEL_ID) await broadcastBattleLog(client, `🏁 ${i.user.username} finished a mission.`);
        }
      } catch (e) {
        const msg = String(e.message || '');
        if (msg.includes('unauthorized')) {
          return i.editReply('🔐 JWT expired. Run `/link` again to refresh.');
        }
        return i.editReply('❌ Mission error. Try again or check logs.');
      }
      return;
    }
  } catch (err) {
    console.error(err);
    try { if (i.isRepliable()) await i.reply({ content: 'Unexpected error 🤖', ephemeral: true }); } catch {}
  }
});

// ------- Webhook receiver (link-complete) -------
const app = express();
app.use(cors({ origin: allowedOrigins, credentials: false }));
app.use(express.json());

app.post('/api/link-complete', async (req, res) => {
  try {
    const { code, uid, address, jwt } = req.body || {};
    if (!code || !uid || !address || !jwt) return res.status(400).json({ ok: false, error: 'bad_params' });

    const pend = pendingLinks.get(code);
    if (!pend || pend.uid !== uid || now() - pend.createdAt > 5 * 60 * 1000) {
      return res.status(400).json({ ok: false, error: 'code_expired' });
    }

    // Validate JWT by calling /profile
    try { await api('/profile', { wallet: address, jwt }); }
    catch { return res.status(401).json({ ok: false, error: 'jwt_invalid' }); }

    pendingLinks.delete(code);
    userBinds.set(uid, { address, jwt, lastAt: now() });
    return res.json({ ok: true });
  } catch (e) {
    console.error('link-complete error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.get('/', (_req, res) => {
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>XRPixel Jets • Discord Bot</title>
  <style>body{font:14px system-ui;background:#0b0f1a;color:#e6f3ff;padding:24px}a{color:#49f3ff}</style>
  <h2>XRPixel Jets — Discord Bot</h2><p>Bot is running. Use <code>/link</code> in Discord.</p><p>Health: <a href="/healthz">/healthz</a></p>`);
});
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ------- boot -------
async function boot() {
  try {
    await registerCommands();
    await client.login(DISCORD_TOKEN);
    app.listen(PORT_FINAL, () => console.log(`[JetsBot] Webhook listening on ${PORT_FINAL}`));
  } catch (e) {
    console.error('[JetsBot] Boot error', e);
    process.exit(1);
  }
}
boot();
