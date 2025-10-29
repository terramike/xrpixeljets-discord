// bot.js — XRPixel Jets • Discord bot (fragment-handoff v2)
// - /link builds URL with #bot=… fragment (WAF-safe; not seen by server).
// - /profile and /claim use your existing backend via X-Wallet + JWT.
// - Express webhook receives link-complete POST from discord-link.html.

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
  BOT_PUBLIC_URL = '',
  LINK_PAGE_BASE = 'https://mykeygo.io/jets/discord-link.html',
  ALLOWED_ORIGINS = 'https://mykeygo.io,https://www.mykeygo.io',
  PORT
} = process.env;

const PORT_FINAL = Number(PORT || process.env.PORT || 8787);

// ------- minimal stores (prototype) -------
const pendingLinks = new Map(); // code -> { uid, createdAt }
const userBinds   = new Map();  // discordId -> { address, jwt, lastAt }

const now = () => Date.now();
const makeCode = () => nanoid(8);

// ------- Discord client -------
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

const commands = [
  new SlashCommandBuilder().setName('link').setDescription('Link your XRPL wallet (Crossmark) to Discord for XRPixel Jets'),
  new SlashCommandBuilder().setName('profile').setDescription('Show your XRPixel Jets profile (energy, JetFuel, unlocked)'),
  new SlashCommandBuilder()
    .setName('claim')
    .setDescription('Claim JETS on-ledger from your JetFuel balance')
    .addIntegerOption(o => o.setName('amount').setDescription('Amount of JETS to claim').setRequired(true)),
].map(c => c.setDefaultMemberPermissions(PermissionFlagsBits.SendMessages).toJSON());

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
    .
