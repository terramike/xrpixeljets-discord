// bot.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Client, GatewayIntentBits, REST, Routes, EmbedBuilder, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { nanoid } from 'nanoid';

// ------- env -------
const {
  DISCORD_TOKEN,
  DISCORD_APP_ID,
  DISCORD_GUILD_ID,
  API_BASE = 'https://xrpixeljets.onrender.com',
  BOT_PUBLIC_URL,
  LINK_PAGE_BASE = 'https://mykeygo.io/jets/discord-link.html',
  ALLOWED_ORIGINS = 'https://mykeygo.io,https://www.mykeygo.io,http://localhost:8000',
  PORT = 8787
} = process.env;

// ------- minimal stores (prototype) -------
/** pendingLinks: code -> { uid, createdAt } */
const pendingLinks = new Map();
/** userBinds: discordId -> { address, jwt, lastAt } (JWT rotates hourly; overwrite as needed) */
const userBinds = new Map();

function makeCode() { return nanoid(8); }
function now() { return Date.now(); }

// ------- Discord client -------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Slash commands
const commands = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your XRPL wallet (Crossmark) to Discord for XRPixel Jets'),
  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Show your XRPixel Jets profile (energy, JetFuel, unlocked wave)'),
  new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Claim JETS on-ledger from your JetFuel balance')
    .addIntegerOption(o =>
      o.setName('amount').setDescription('Amount of JETS to claim').setRequired(true)
    ),
].map(c => c.setDefaultMemberPermissions(PermissionFlagsBits.SendMessages).toJSON());

// Register commands (guild-scoped for fast iteration)
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
async function registerCommands() {
  if (DISCORD_GUILD_ID) {
    await rest.put(Routes.applicationGuildCommands(DISCORD_APP_ID, DISCORD_GUILD_ID), { body: commands });
    console.log('[JetsBot] Registered guild commands.');
  } else {
    await rest.put(Routes.applicationCommands(DISCORD_APP_ID), { body: commands });
    console.log('[JetsBot] Registered global commands.');
  }
}

// Helper: fetch JSON with headers
async function api(path, { method = 'GET', wallet = '', jwt = '', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (wallet) headers['X-Wallet'] = wallet;
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
  const res = await fetch(API_BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
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
      { name: 'Regen',  value: `${ms.regenPerMin ?? 0}/min`, inline: true },
      { name: 'JetFuel', value: String(p.jetFuel ?? 0), inline: true },
      { name: 'Unlocked Wave', value: String(p.unlockedLevel ?? 1), inline: true },
    )
    .setColor(0x49f3ff)
    .setFooter({ text: 'Play at mykeygo.io/jets — claim on-ledger with Crossmark' });
}

// ------- Discord interactions -------
client.on('interactionCreate', async (i) => {
  try {
    if (!i.isChatInputCommand()) return;

    if (i.commandName === 'link') {
      const code = makeCode();
      pendingLinks.set(code, { uid: i.user.id, createdAt: now() });
      // auto-expire in 5 min
      setTimeout(() => pendingLinks.delete(code), 5 * 60 * 1000);

      const url = `${LINK_PAGE_BASE}?code=${encodeURIComponent(code)}&uid=${encodeURIComponent(i.user.id)}&bot=${encodeURIComponent(BOT_PUBLIC_URL)}`;
      await i.reply({ content: `🔗 **Link your wallet**\n1) Click: ${url}\n2) Sign in with Crossmark\n3) Return here and run \`/profile\`\n\nCode expires in 5 minutes.`, ephemeral: true });
    }

    if (i.commandName === 'profile') {
      const bind = userBinds.get(i.user.id);
      if (!bind) {
        return i.reply({ content: 'No wallet linked. Run `/link` first.', ephemeral: true });
      }
      const p = await api('/profile', { wallet: bind.address, jwt: bind.jwt });
      await i.reply({ embeds: [profileEmbed(p)], ephemeral: true });
    }

    if (i.commandName === 'claim') {
      const amt = i.options.getInteger('amount', true);
      if (amt <= 0) return i.reply({ content: 'Enter a positive amount.', ephemeral: true });

      const bind = userBinds.get(i.user.id);
      if (!bind) return i.reply({ content: 'No wallet linked. Run `/link` first.', ephemeral: true });

      await i.deferReply({ ephemeral: true });
      try {
        const res = await api('/claim/start', { method: 'POST', wallet: bind.address, jwt: bind.jwt, body: { amount: amt } });
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
    }
  } catch (err) {
    console.error(err);
    if (i.isRepliable()) i.reply({ content: 'Unexpected error 🤖', ephemeral: true }).catch(() => {});
  }
});

// ------- Webhook receiver (no server changes needed) -------
// Your link page will sign-in via XRPixel Jets server and POST here.
const app = express();
app.use(cors({
  origin: ALLOWED_ORIGINS.split(',').map(s => s.trim()),
  credentials: false
}));
app.use(express.json());

app.post('/api/link-complete', async (req, res) => {
  try {
    const { code, uid, address, jwt } = req.body || {};
    if (!code || !uid || !address || !jwt) return res.status(400).json({ ok: false, error: 'bad_params' });

    const pend = pendingLinks.get(code);
    if (!pend || pend.uid !== uid || (now() - pend.createdAt) > 5 * 60 * 1000) {
      return res.status(400).json({ ok: false, error: 'code_expired' });
    }

    // Verify JWT by calling /profile (server is source of truth)
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

app.get('/healthz', (_, res) => res.json({ ok: true }));

// ------- boot -------
await registerCommands();
await client.login(DISCORD_TOKEN);
app.listen(Number(PORT), () => console.log(`[JetsBot] Webhook listening on ${PORT}`));
