import { DateTime } from 'luxon';
import { config } from './config.js';
import { queries } from './db.js';

/**
 * Add or update a signup. Returns { ok, status, position, promoted } where:
 *   ok: true if the signup was applied
 *   status: 'playing' or 'waitlist'
 *   position: 1-indexed position within their bucket
 */
export function applySignup({ gameId, senderJid, displayName, plusCount, signedUpAt }) {
  queries.addSignup.run(gameId, senderJid, displayName, plusCount, signedUpAt);
  return computeStatus(gameId, senderJid);
}

export function applyDropout({ gameId, senderJid }) {
  const existing = queries.getSignup.get(gameId, senderJid);
  if (!existing) return { ok: false, reason: 'not-signed-up' };
  queries.removeSignup.run(gameId, senderJid);

  // Figure out who got promoted (if anyone) by comparing the playing list before/after
  const newList = buildList(gameId);
  return { ok: true, newList };
}

export function getSignup(gameId, senderJid) {
  return queries.getSignup.get(gameId, senderJid);
}

/**
 * Build the ordered playing + waitlist arrays, expanding +N entries.
 * Each signup occupies (1 + plusCount) seats in arrival order.
 */
export function buildList(gameId) {
  const signups = queries.getAllSignupsForGame.all(gameId);
  const playing = [];
  const waitlist = [];

  for (const s of signups) {
    const seats = 1 + (s.plus_count || 0);
    for (let i = 0; i < seats; i++) {
      const label =
        i === 0 ? s.display_name : `${s.display_name}'s +${i}`;
      const entry = { signupId: s.id, senderJid: s.sender_jid, label, signedUpAt: s.signed_up_at };
      if (playing.length < config.maxPlayers) {
        playing.push(entry);
      } else {
        waitlist.push(entry);
      }
    }
  }
  return { playing, waitlist };
}

function computeStatus(gameId, senderJid) {
  const { playing, waitlist } = buildList(gameId);
  const inPlaying = playing.findIndex((p) => p.senderJid === senderJid);
  if (inPlaying !== -1) {
    return { ok: true, status: 'playing', position: inPlaying + 1, playing, waitlist };
  }
  const inWait = waitlist.findIndex((p) => p.senderJid === senderJid);
  if (inWait !== -1) {
    return { ok: true, status: 'waitlist', position: inWait + 1, playing, waitlist };
  }
  return { ok: false, reason: 'not-found' };
}

/**
 * Render the list as a WhatsApp message. Plain text, no markdown.
 */
export function renderList({ gameDate, playing, waitlist }) {
  const dateStr = gameDate.toFormat('EEEE LLL d');
  const lines = [];
  lines.push(`🏀 ${dateStr} pickup — live list`);
  lines.push('');
  lines.push(`Playing (${playing.length}/${config.maxPlayers}):`);
  if (playing.length === 0) {
    lines.push('  (no one yet)');
  } else {
    playing.forEach((p, i) => lines.push(`  ${i + 1}. ${p.label}`));
  }
  if (waitlist.length > 0) {
    lines.push('');
    lines.push(`Waitlist (${waitlist.length}):`);
    waitlist.forEach((p, i) => lines.push(`  ${i + 1}. ${p.label}`));
  }
  lines.push('');
  lines.push(`Updated ${DateTime.now().setZone(config.timezone).toFormat('h:mm a ZZZZ')}`);
  return lines.join('\n');
}
