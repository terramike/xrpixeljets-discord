// bot.js — XRPixel Jets • Discord bot (robust replies + persistence + hangar fixes)
// Node >=18 • discord.js v14 • express • cors • dotenv • nanoid • xrpl

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fs from 'node:fs/promises';
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

  // Hangar / XRPL
  NFT_TAXON = '200',
  XRPL_WSS_PRIMARY = 'wss://xrplcluster.com',
  XRPL_WSS_FALLBACK = 'wss://s1.ripple.com',
  XRPL_TIMEOUT_MS = '15000',
  HANGAR_CACHE_TTL_SEC = '300',

  // Linking / JWT
  LINK_TTL_SEC = '900',          // 15m
  BIND_FILE = './binds.json',
  JWT_LEEWAY_SEC = '15',
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_APP_ID) {
  console.error('[JetsBot] Missing DISCORD_TOKEN or DISCORD_APP_ID in env.');
  process.exit(1);
}

const PORT_FINAL = Number(PORT || process.env.PORT || 8787);
const allowedOrigins = (ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const repliesPublic = String(COMMAND_REPLIES_PUBLIC).toLowerCase() === 'true';
const TAXON = Number(NFT_TAXON || '200');
const LINK_TTL_MS = Math.max(60, Number(LINK_TTL_SEC || '900')) * 1000;
const XRPL_TIMEOUT = Math.max(5000, Number(XRPL_TIMEOUT_MS || '15000'));
const HANGAR_CACHE_TTL = Math.max(30, Number(HANGAR_CACHE_TTL_SEC || '300')) * 1000;
const JWT_LEEWAY = Math.max(0, Number(JWT_LEEWAY_SEC || '15'));

// ------- stores -------
const pendingLinks = new Map(); // code -> { uid, createdAt }
const userBinds = new Map();    // discordId -> { address, jwt, lastAt, exp }
const lastBattle = new Map();   // discordId -> { youHP, enemyHP }
const hangarCache = new Map();  // address -> { at, items }

// ------- persist binds -------
async function loadBinds() {
  try {
    const raw = await fs.readFile(BIND_FILE, 'utf8').catch(() => '{}');
    const obj = JSON.parse(raw || '{}');
    for (const [uid, v] of Object.entries(obj)) userBinds.set(uid, v);
    console.log(`[JetsBot] Loaded ${userBinds.size} binds from ${BIND_FILE}`);
  } catch (e) {
    console.warn('[JetsBot] Failed to load binds:', e.message);
  }
}
let saveTimer = null;
async function saveBindsSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const obj = {};
      for (const [k, v] of userBinds) obj[k] = v;
      await fs.writeFile(BIND_FILE, JSON.stringify(obj, null, 2));
    } catch (e) { console.warn('[JetsBot] Failed to save binds:', e.message); }
  }, 400);
}

// ------- helpers: jwt + replies -------
const now = () => Date.now();
const makeCode = () => nanoid(8);

function decodeJwtExp(jwt) {
  try {
    const [, b64] = jwt.split('.');
    const json = JSON.parse(Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return typeof json.exp === 'number' ? json.exp : null;
  } catch { return null; }
}
function isJwtExpired(bind) {
  if (!bind?.jwt) return true;
  const exp = bind.exp ?? decodeJwtExp(bind.jwt);
  if (!exp) return false;
  const nowSec = Math.floor(Date.now()/1000);
  return (nowSec + JWT_LEEWAY) >= exp;
}

// Robust interaction response: always defer ASAP, then edit
async function openReply(i, ephemeral) {
  try {
    if (!i.deferred && !i.replied) {
      await i.deferReply({ ephemeral }); // NOTE: using ephemeral for d.js v14; warning is harmless
    }
  } catch { /* swallow to avoid 'Unknown interaction' cascades */ }
}
async function say(i, payload) {
  try { return await i.editReply(payload); }
  catch {
    try {
      if (!i.replied) return await i.reply(payload);
    } catch {}
  }
}

// ------- API client -------
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
  return BOT_PUBLIC_URL ? `${base}#bot=${encodeURIComponent(BOT_PUBLIC_URL)}` : base;
}

// ------- embeds -------
function profileEmbed(p) {
  const ms = p?.ms?.current || p?.ms?.base || {};
  return new EmbedBuilder()
    .setTitle('🛠️ XRPixel Jets — Profile')
    .addFields(
      { name: 'Energy', value: `${p.energy ?? 0}/${ms.energyCap ?? 100}`, inline: true },
      { name: 'Regen',  value: `${ms.regenPerMin ?? 0}/min`,            inline: true },
      { name: 'JetFuel',value: String(p.jetFuel ?? 0),                   inline: true },
      { name: 'Unlocked Wave', value: String(p.unlockedLevel ?? 1),      inline: true },
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
      { name: 'Linked',  value: `<t:${Math.floor((bind.lastAt||now()) / 1000)}:R>`, inline: true },
      ...(bind.exp ? [{ name: 'JWT expires', value: `<t:${bind.exp}:R>`, inline: true }] : [])
    )
    .setColor(0x49f3ff);
}

// --- combat display helpers ---
function synthSummary(payload = {}, prev = null) {
  const parts = [];
  const dmgOut = payload.damage ?? payload.dealt ?? payload.hit ?? payload.dmg ?? null;
  const dmgIn  = payload.damageTaken ?? payload.taken ?? payload.hurt ?? null;
  const crit   = payload.crit ?? payload.critical ?? null;
  const block  = payload.block ?? payload.blocked ?? payload.defended ?? null;
  const miss   = payload.miss ?? payload.missed ?? null;
  const jf     = payload.reward ?? payload.rewards ?? payload.jetFuel ?? payload.jf ?? null;
  const en     = payload.energySpent ?? payload.energy ?? null;
  if (dmgOut != null) parts.push(`💥 dealt ${dmgOut}`);
  if (crit)          parts.push(`⚡ crit`);
  if (block)         parts.push(`🛡️ block`);
  if (miss)          parts.push(`〰️ miss`);
  if (dmgIn != null) parts.push(`💢 took ${dmgIn}`);
  if (en != null)    parts.push(`⚙️ energy ${en}`);
  if (jf != null)    parts.push(`⛽ +${jf} JF`);
  const youHP   = payload.youHP ?? payload.playerHP ?? payload.hp ?? payload?.player?.hp;
  const enemyHP = payload.enemyHP ?? payload.enemyhp ?? payload?.enemy?.hp;
  const dy = prev && youHP   != null && prev.youHP   != null ? youHP   - prev.youHP   : null;
  const de = prev && enemyHP != null && prev.enemyHP != null ? enemyHP - prev.enemyHP : null;
  if (de != null && de !== 0) parts.push(`👾 enemy ${de > 0 ? `+${de}` : `${de}`} HP`);
  if (dy != null && dy !== 0) parts.push(`🧑 you ${dy > 0 ? `+${dy}` : `${dy}`} HP`);
  return parts.length ? parts.join(' · ') : '…';
}
function battleEmbed(kind, payload = {}, prev = null) {
  const log = payload.log || payload.combatLog || payload.messages || payload.turnLog || [];
  const lastLines = Array.isArray(log) ? log.slice(-8).join('\n') : String(log || '');
  const youHP   = payload.youHP ?? payload.playerHP ?? payload.hp ?? payload?.player?.hp;
  const enemyHP = payload.enemyHP ?? payload.enemyhp ?? payload?.enemy?.hp;
  const reward  = payload.reward ?? payload.rewards ?? payload.jetFuel ?? payload.jf ?? null;
  const wave    = payload.wave ?? payload.level ?? payload.mission ?? null;
  const fields = [];
  if (youHP   != null) fields.push({ name: 'Your HP',  value: String(youHP),   inline: true });
  if (enemyHP != null) fields.push({ name: 'Enemy HP', value: String(enemyHP), inline: true });
  if (reward  != null) fields.push({ name: 'Reward',   value: String(reward),  inline: true });
  const titlePieces = [];
  if (kind === 'start')  titlePieces.push('🚀 Mission started');
  if (kind === 'turn')   titlePieces.push('🎯 Mission turn');
  if (kind === 'finish') titlePieces.push('🏁 Mission finished');
  if (wave != null)      titlePieces.push(`(Wave ${wave})`);
  const e = new EmbedBuilder().setTitle(titlePieces.join(' ')).setColor(kind === 'finish' ? 0x65f0a0 : 0x49f3ff);
  if (fields.length) e.addFields(...fields);
  e.setDescription(lastLines ? '```' + lastLines + '```' : '`' + synthSummary(payload, prev) + '`');
  return e;
}
async function broadcastBattleLog(client, summary) {
  if (!BATTLE_LOG_CHANNEL_ID) return;
  try {
    const ch = await client.channels.fetch(BATTLE_LOG_CHANNEL_ID);
    await ch.send(typeof summary === 'string' ? summary : 'Battle update');
  } catch (e) { console.warn('[JetsBot] battle-log broadcast failed:', e?.message || e); }
}

// ------- Discord client / commands -------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

// Slash commands
const missionCmd = new SlashCommandBuilder()
  .setName('mission').setDescription('Run missions in Discord')
  .addSubcommand(sc => sc.setName('start').setDescription('Start a mission')
    .addIntegerOption(o => o.setName('mission').setDescription('Mission/Wave number').setRequired(false)))
  .addSubcommand(sc => sc.setName('turn').setDescription('Advance the mission one turn'))
  .addSubcommand(sc => sc.setName('finish').setDescription('Finish/resolve the mission'));
const mCmd = new SlashCommandBuilder()
  .setName('m').setDescription('Missions (short)')
  .addSubcommand(sc => sc.setName('start').setDescription('Start a mission')
    .addIntegerOption(o => o.setName('mission').setDescription('Mission/Wave number').setRequired(false)))
  .addSubcommand(sc => sc.setName('turn').setDescription('Advance the mission one turn'))
  .addSubcommand(sc => sc.setName('finish').setDescription('Finish/resolve the mission'));
const commands = [
  new SlashCommandBuilder().setName('link').setDescription('Link your XRPL wallet (Crossmark) to Discord'),
  new SlashCommandBuilder().setName('profile').setDescription('Show your XRPixel Jets profile'),
  new SlashCommandBuilder().setName('claim').setDescription('Claim JETS on-ledger from your JetFuel')
    .addIntegerOption(o => o.setName('amount').setDescription('Amount of JETS to claim').setRequired(true)),
  new SlashCommandBuilder().setName('whoami').setDescription('Show linked wallet address'),
  new SlashCommandBuilder().setName('unlink').setDescription('Unlink your wallet from this Discord user'),
  missionCmd, mCmd,
  new SlashCommandBuilder().setName('hangar').setDescription('List your XRPixel Jets (reads XRPL account NFTs)')
    .addIntegerOption(o => o.setName('limit').setDescription('How many to show (default 6, max 12)').setRequired(false)),
  new SlashCommandBuilder().setName('jets').setDescription('Alias for /hangar')
    .addIntegerOption(o => o.setName('limit').setDescription('How many to show (default 6, max 12)').setRequired(false)),
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

// ---- XRPL NFT helpers / hangar ----
function hexToUtf8(hex) { try { return Buffer.from(hex, 'hex').toString('utf8').replace(/\0+$/,''); } catch { return ''; } }
function ipfsToHttp(u, alt=false) { if (!u) return ''; if (u.startsWith('ipfs://')) return `${alt ? 'https://cloudflare-ipfs.com/ipfs/' : 'https://ipfs.io/ipfs/'}${u.slice(7)}`; return u; }
async function fetchJSON(u) { const r = await fetch(u); if (!r.ok) throw new Error(`HTTP ${r.status}`); return await r.json(); }

async function xrplAccountNfts(address) {
  const { Client } = await import('xrpl');
  for (const url of [XRPL_WSS_PRIMARY, XRPL_WSS_FALLBACK]) {
    const client = new Client(url, { timeout: XRPL_TIMEOUT });
    try {
      await client.connect();
      const items = [];
      let marker;
      do {
        const out = await client.request({ command: 'account_nfts', account: address, limit: 400, marker });
        items.push(...(out.result?.account_nfts || []));
        marker = out.result?.marker;
      } while (marker);
      try { await client.disconnect(); } catch {}
      if (items.length || url === XRPL_WSS_FALLBACK) return items;
    } catch { try { await client.disconnect(); } catch {} }
  }
  return [];
}
async function listAccountJets(address, limit = 6) {
  const hit = hangarCache.get(address);
  if (hit && (now() - hit.at) < HANGAR_CACHE_TTL) return hit.items.slice(0, Math.min(12, Math.max(1, limit)));
  let all = [];
  try { all = await xrplAccountNfts(address); } catch { throw new Error('XRPL gateway error'); }
  const jets = all.filter(n => Number(n.nft_taxon) === TAXON);
  const top = jets.slice(0, Math.min(12, Math.max(1, limit)));
  const enriched = [];
  for (const n of top) {
    const id = n.NFTokenID || n.nft_id || n.nftoken_id;
    const uri = hexToUtf8(n.uri || '');
    let meta = null;
    const u1 = ipfsToHttp(uri, false), u2 = ipfsToHttp(uri, true);
    try { if (u1) meta = await fetchJSON(u1); } catch { try { if (u2) meta = await fetchJSON(u2); } catch {} }
    enriched.push({ id, taxon: n.nft_taxon, uri, meta });
  }
  hangarCache.set(address, { at: now(), items: enriched });
  return enriched;
}
function hangarEmbeds(items, address) {
  const chunks = [];
  const chunkSize = 6;
  const header = `Wallet: ${address.slice(0,6)}…${address.slice(-6)} · Taxon ${TAXON}`;
  if (!items.length) {
    return [ new EmbedBuilder().setTitle('🛩️ Hangar — Your XRPixel Jets').setColor(0x49f3ff).setDescription('No XRPixel Jets found for this wallet.').setFooter({ text: header }) ];
  }
  for (let i = 0; i < items.length; i += chunkSize) {
    const slice = items.slice(i, i + chunkSize);
    const e = new EmbedBuilder().setTitle('🛩️ Hangar — Your XRPixel Jets').setColor(0x49f3ff).setFooter({ text: header });
    const lines = slice.map((it) => {
      const name = it.meta?.name || `Jet ${it.id?.slice(-6)}`;
      const attrs = Array.isArray(it.meta?.attributes)
        ? it.meta.attributes.map(a => `${a.trait_type || a.trait || ''}${a.value != null ? `: ${a.value}` : ''}`)
            .filter(Boolean).slice(0, 5).join(' · ')
        : '';
      return `• **${name}**  ${attrs ? `— ${attrs}` : ''}`;
    });
    e.setDescription(lines.join('\n'));
    chunks.push(e);
  }
  return chunks;
}

// ------- interactions -------
client.on('interactionCreate', async (i) => {
  try {
    if (!i.isChatInputCommand()) return;
    const ephemeral = !repliesPublic;
    const cmd = i.commandName;

    // Only read subcommand for commands that have them
    let sub = null;
    if (cmd === 'mission' || cmd === 'm') { try { sub = i.options.getSubcommand(); } catch { sub = null; } }

    // mini helper to require a valid bind
    const needBind = () => {
      const bind = userBinds.get(i.user.id);
      if (!bind) return null;
      if (isJwtExpired(bind)) return { ...bind, expired: true };
      return bind;
    };

    // /link
    if (cmd === 'link') {
      await openReply(i, ephemeral);
      const code = makeCode();
      pendingLinks.set(code, { uid: i.user.id, createdAt: now() });
      setTimeout(() => pendingLinks.delete(code), LINK_TTL_MS);
      const url = buildLinkUrl(code, i.user.id);
      const ttlMin = Math.max(1, Math.round(LINK_TTL_MS / 60000));
      await say(i, {
        content:
          `🔗 **Link your wallet**\n` +
          `1) Click: ${url}\n` +
          `2) Sign in with Crossmark\n` +
          `3) Return here and run \`/profile\`\n\n` +
          `Code expires in ${ttlMin} minute${ttlMin===1?'':'s'}.`
      });
      return;
    }

    // /profile
    if (cmd === 'profile') {
      await openReply(i, ephemeral);
      const bind = needBind();
      if (!bind) return say(i, { content: 'No wallet linked. Run `/link` first.' });
      if (bind.expired) return say(i, { content: '🔐 JWT expired. Run `/link` to refresh.' });

      const p = await api('/profile', { wallet: bind.address, jwt: bind.jwt }).catch(e => {
        if (String(e.message||'').includes('401')) return null; throw e;
      });
      if (!p) return say(i, { content: '🔐 JWT expired. Run `/link` to refresh.' });
      await say(i, { embeds: [profileEmbed(p)] });
      return;
    }

    // /whoami
    if (cmd === 'whoami') {
      await openReply(i, ephemeral);
      const bind = userBinds.get(i.user.id);
      if (!bind) return say(i, { content: 'No wallet linked. Run `/link` first.' });
      await say(i, { embeds: [whoamiEmbed(bind)] });
      return;
    }

    // /unlink
    if (cmd === 'unlink') {
      await openReply(i, ephemeral);
      userBinds.delete(i.user.id);
      await saveBindsSoon();
      await say(i, { content: '🔓 Unlinked. Run `/link` to connect a wallet again.' });
      return;
    }

    // /claim
    if (cmd === 'claim') {
      await openReply(i, ephemeral);
      const amt = i.options.getInteger('amount', true);
      if (amt <= 0) return say(i, { content: 'Enter a positive amount.' });
      const bind = needBind();
      if (!bind) return say(i, { content: 'No wallet linked. Run `/link` first.' });
      if (bind.expired) return say(i, { content: '🔐 JWT expired. Run `/link` to refresh.' });

      try {
        const res = await api('/claim/start', {
          method: 'POST',
          wallet: bind.address,
          jwt: bind.jwt,
          body: { amount: amt },
        });
        if (res?.txid) {
          await say(i, { content: `✅ Claim sent: **${res.txid}**\nExplorer: https://xrpscan.com/tx/${res.txid}` });
        } else if (res?.txJSON) {
          await say(i, { content: '✅ Claim prepared (server not in hot mode).' });
        } else {
          await say(i, { content: '✅ Claim acknowledged (mock mode).' });
        }
      } catch (e) {
        const msg = String(e.message || '');
        if (msg.includes('trustline_required')) return say(i, { content: '❗ Trustline required. Open the web game and click **Set Trustline**.' });
        if (msg.includes('cooldown'))            return say(i, { content: '⏱️ Claim cooldown active. Try again soon.' });
        if (msg.includes('insufficient_funds'))  return say(i, { content: '💤 Not enough JetFuel to claim that amount.' });
        if (msg.includes('unauthorized'))        return say(i, { content: '🔐 JWT expired. Run `/link` again to refresh.' });
        return say(i, { content: '❌ Claim failed. Try again or check logs.' });
      }
      return;
    }

    // /mission and /m
    if ((cmd === 'mission' || cmd === 'm') && sub) {
      await openReply(i, ephemeral);
      const bind = needBind();
      if (!bind) return say(i, { content: 'No wallet linked. Run `/link` first.' });
      if (bind.expired) return say(i, { content: '🔐 JWT expired. Run `/link` to refresh.' });

      try {
        if (sub === 'start') {
          const missionNum = i.options.getInteger('mission') ?? undefined;
          const body = missionNum ? { mission: missionNum } : undefined;
          const res = await api('/battle/start', { method: 'POST', wallet: bind.address, jwt: bind.jwt, body });
          const emb = battleEmbed('start', res, null);
          const youHP   = res.youHP ?? res.playerHP ?? res.hp ?? res?.player?.hp ?? null;
          const enemyHP = res.enemyHP ?? res.enemyhp ?? res?.enemy?.hp ?? null;
          lastBattle.set(i.user.id, { youHP, enemyHP });
          await say(i, { embeds: [emb] });
          if (BATTLE_LOG_CHANNEL_ID) await broadcastBattleLog(client, `🚀 ${i.user.username} started a mission${missionNum ? ` #${missionNum}` : ''}.`);
        }
        else if (sub === 'turn') {
          const prev = lastBattle.get(i.user.id) || null;
          const res = await api('/battle/turn', { method: 'POST', wallet: bind.address, jwt: bind.jwt, body: { verbose: true } });
          const emb = battleEmbed('turn', res, prev);
          const youHP   = res.youHP ?? res.playerHP ?? res.hp ?? res?.player?.hp ?? null;
          const enemyHP = res.enemyHP ?? res.enemyhp ?? res?.enemy?.hp ?? null;
          lastBattle.set(i.user.id, { youHP, enemyHP });
          await say(i, { embeds: [emb] });
          if (BATTLE_LOG_CHANNEL_ID) await broadcastBattleLog(client, `🎯 ${i.user.username} took a turn.`);
        }
        else if (sub === 'finish') {
          const prev = lastBattle.get(i.user.id) || null;
          const res = await api('/battle/finish', { method: 'POST', wallet: bind.address, jwt: bind.jwt, body: {} });
          const emb = battleEmbed('finish', res, prev);
          lastBattle.delete(i.user.id);
          await say(i, { embeds: [emb] });
          if (BATTLE_LOG_CHANNEL_ID) await broadcastBattleLog(client, `🏁 ${i.user.username} finished a mission.`);
        }
      } catch (e) {
        const msg = String(e.message || '');
        if (msg.includes('unauthorized')) return say(i, { content: '🔐 JWT expired. Run `/link` again to refresh.' });
        return say(i, { content: '❌ Mission error. Try again or check logs.' });
      }
      return;
    }

    // /hangar and /jets
    if (cmd === 'hangar' || cmd === 'jets') {
      await openReply(i, ephemeral);
      const bind = needBind();
      if (!bind) return say(i, { content: 'No wallet linked. Run `/link` first.' });
      if (bind.expired) return say(i, { content: '🔐 JWT expired. Run `/link` to refresh.' });

      const lim = Math.min(12, Math.max(1, i.options.getInteger('limit') ?? 6));
      try {
        const items = await listAccountJets(bind.address, lim);
        const embeds = hangarEmbeds(items, bind.address);
        await say(i, { embeds });
      } catch (e) {
        await say(i, { content: `Could not load hangar: ${e.message || e}.` });
      }
      return;
    }

  } catch (err) {
    console.error('[JetsBot] interaction error', {
      cmd: i?.commandName,
      user: i?.user?.id,
      err: err?.message,
      stack: err?.stack?.slice?.(0, 500),
    });
    try { if (i.isRepliable()) await openReply(i, true); await say(i, { content: 'Unexpected error 🤖' }); } catch {}
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
    if (!pend || pend.uid !== uid || (now() - pend.createdAt) > LINK_TTL_MS) {
      return res.status(400).json({ ok: false, error: 'code_expired' });
    }
    let exp = null;
    try { await api('/profile', { wallet: address, jwt }); exp = decodeJwtExp(jwt); }
    catch { return res.status(401).json({ ok: false, error: 'jwt_invalid' }); }
    pendingLinks.delete(code);
    userBinds.set(uid, { address, jwt, lastAt: now(), exp });
    await saveBindsSoon();
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
    await loadBinds();
    await registerCommands();
    await client.login(DISCORD_TOKEN);
    app.listen(PORT_FINAL, () => console.log(`[JetsBot] Webhook listening on ${PORT_FINAL}`));
  } catch (e) {
    console.error('[JetsBot] Boot error', e);
    process.exit(1);
  }
}
boot();
