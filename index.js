import {
  default as makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import { DateTime } from 'luxon';
import cron from 'node-cron';
import path from 'path';
import fs from 'fs';

import { config } from './config.js';
import { classifyMessage } from './classifier.js';
import { applySignup, applyDropout, buildList, renderList, getSignup } from './signups.js';
import { queries } from './db.js';
import { getCurrentGameContext } from './schedule.js';

const AUTH_DIR = process.env.AUTH_DIR || './auth';
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

const logger = pino({ level: 'warn' });

let sock = null;
let lastListMessageId = null; // not strictly needed since we repost, but useful for debugging

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: state,
    printQRInTerminal: false, // we handle it ourselves
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) {
      console.log('\n📱 Scan this QR with the bot phone\'s WhatsApp (Linked Devices):\n');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = reason !== DisconnectReason.loggedOut;
      console.log(`Connection closed (reason ${reason}). Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) setTimeout(start, 3000);
      else console.log('Logged out — delete ./auth and restart to re-link.');
    } else if (connection === 'open') {
      console.log('✅ WhatsApp connected.');
      logGroups();
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleMessage(msg);
      } catch (err) {
        console.error('Error handling message:', err);
      }
    }
  });
}

async function logGroups() {
  try {
    const groups = await sock.groupFetchAllParticipating();
    console.log('\n📋 Groups this bot is in:');
    for (const [jid, info] of Object.entries(groups)) {
      const marker = jid === config.groupJid ? '  👈 active' : '';
      console.log(`  ${info.subject || '(no name)'} — ${jid}${marker}`);
    }
    if (!config.groupJid) {
      console.log('\n⚠️  GROUP_JID not set. Copy the JID of your basketball group into your .env and restart.');
    }
    console.log('');
  } catch (err) {
    console.error('Could not fetch groups:', err.message);
  }
}

function getSenderName(msg) {
  return msg.pushName || msg.key.participant?.split('@')[0] || 'Someone';
}

function getMessageText(msg) {
  return (
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    ''
  );
}

async function handleMessage(msg) {
  if (!msg.message || msg.key.fromMe) return;
  if (msg.key.remoteJid !== config.groupJid) return;

  const text = getMessageText(msg).trim();
  if (!text) return;

  const senderJid = msg.key.participant || msg.key.remoteJid;
  const senderName = getSenderName(msg);
  const messageTimestamp = DateTime.fromSeconds(Number(msg.messageTimestamp)).setZone(config.timezone);

  const { gameDate, openAt, isOpen, secondsUntilOpen } = getCurrentGameContext(messageTimestamp);

  // Ensure a game row exists in DB
  const gameRow = queries.getOrCreateGame.get(
    gameDate.toISODate(),
    openAt.toISO(),
  );

  const classification = await classifyMessage(text);

  if (classification.intent === 'CHATTER' || classification.intent === 'QUESTION') {
    return; // bot stays quiet for non-signup chatter
  }

  // Time gate: if signups aren't open yet, reject IN messages
  if (classification.intent === 'IN' && !isOpen) {
    const minutes = Math.ceil(secondsUntilOpen / 60);
    const when =
      minutes > 60
        ? openAt.toFormat("EEEE 'at' h:mm a")
        : `in ${minutes} min (${openAt.toFormat('h:mm a')})`;
    await sock.sendMessage(config.groupJid, {
      text: `⏰ Hold up @${senderName} — signups for ${gameDate.toFormat('EEEE')}'s game open ${when}. Try again then!`,
    });
    return;
  }

  if (classification.intent === 'IN') {
    // Mark game as open if it's the first signup
    if (gameRow.status !== 'open') {
      queries.setGameStatus.run('open', gameRow.id);
    }
    const previous = getSignup(gameRow.id, senderJid);
    const result = applySignup({
      gameId: gameRow.id,
      senderJid,
      displayName: senderName,
      plusCount: classification.plusCount,
      signedUpAt: messageTimestamp.toISO(),
    });
    if (result.ok) {
      const action = previous ? 'updated' : 'added';
      await postList(gameDate, result.playing, result.waitlist, {
        announcement:
          action === 'added'
            ? `✅ ${senderName}${classification.plusCount ? ` (+${classification.plusCount})` : ''} — ${result.status === 'playing' ? `you're in (#${result.position})` : `waitlist #${result.position}`}`
            : `✏️ ${senderName} updated their signup`,
      });
    }
    return;
  }

  if (classification.intent === 'OUT') {
    const result = applyDropout({ gameId: gameRow.id, senderJid });
    if (!result.ok) return; // they weren't signed up; ignore silently
    const promoted = findPromoted(gameRow.id, result.newList);
    let announcement = `❌ ${senderName} dropped out`;
    if (promoted.length > 0) {
      announcement += `\n⬆️ Promoted from waitlist: ${promoted.map((p) => p.label).join(', ')}`;
    }
    await postList(gameDate, result.newList.playing, result.newList.waitlist, {
      announcement,
    });
    return;
  }
}

// Track which jids were on the playing list before the last buildList call,
// so we can detect promotions. Simple approach: stash the previous playing-jid set per game.
const lastPlayingByGame = new Map();

function findPromoted(gameId, newList) {
  const newPlayingJids = new Set(newList.playing.map((p) => p.senderJid + '#' + p.label));
  const previous = lastPlayingByGame.get(gameId) || new Set();
  const promoted = newList.playing.filter(
    (p) => !previous.has(p.senderJid + '#' + p.label),
  );
  lastPlayingByGame.set(gameId, newPlayingJids);
  // First call after restart has no baseline → don't claim everyone is promoted
  if (previous.size === 0) return [];
  return promoted;
}

async function postList(gameDate, playing, waitlist, { announcement } = {}) {
  const body = renderList({ gameDate, playing, waitlist });
  const text = announcement ? `${announcement}\n\n${body}` : body;
  const sent = await sock.sendMessage(config.groupJid, { text });
  lastListMessageId = sent?.key?.id;
}

// Cron: at 9:59am day before each game day, send a heads-up.
// At 10:00am sharp, post the empty list to "open" the signup window visibly.
cron.schedule('* * * * *', async () => {
  if (!sock || !config.groupJid) return;
  const now = DateTime.now().setZone(config.timezone);

  try {
    const { gameDate, openAt, isOpen } = getCurrentGameContext(now);
    const diffSec = Math.abs(openAt.diff(now, 'seconds').seconds);

    // 60s before open: heads-up
    if (!isOpen && diffSec < 65 && diffSec >= 55) {
      await sock.sendMessage(config.groupJid, {
        text: `⏰ Signups for ${gameDate.toFormat('EEEE')}'s pickup open in 1 minute (${openAt.toFormat('h:mm a')}).`,
      });
    }

    // Within 60s of opening: post the opening message
    if (isOpen && now.diff(openAt, 'seconds').seconds < 60) {
      const game = queries.getOrCreateGame.get(gameDate.toISODate(), openAt.toISO());
      if (game.status !== 'open') {
        queries.setGameStatus.run('open', game.id);
        await sock.sendMessage(config.groupJid, {
          text: `🏀 Signups for ${gameDate.toFormat('EEEE LLL d')} are now OPEN. Reply "in" to sign up. First ${config.maxPlayers} play, rest are waitlisted. "+1" to bring a friend.`,
        });
      }
    }
  } catch (err) {
    console.error('Cron error:', err.message);
  }
});

start().catch((err) => {
  console.error('Fatal start error:', err);
  process.exit(1);
});
