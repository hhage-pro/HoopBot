import { DateTime } from 'luxon';
import { config, DAY_TO_NUMBER } from './config.js';

/**
 * Given "now" (in the configured timezone), find the next game date
 * (in the configured timezone) that matches one of the GAME_DAYS.
 * Returns a Luxon DateTime at midnight of the game day.
 */
export function getNextGameDate(now = DateTime.now().setZone(config.timezone)) {
  const gameDayNumbers = config.gameDays.map((d) => DAY_TO_NUMBER[d]).filter(Boolean);
  if (gameDayNumbers.length === 0) {
    throw new Error('No valid game days configured');
  }

  // Look up to 14 days ahead
  for (let offset = 0; offset < 14; offset++) {
    const candidate = now.plus({ days: offset }).startOf('day');
    if (gameDayNumbers.includes(candidate.weekday)) {
      // If it's today and we're past 10am of yesterday's open, this game might already be in progress.
      // We treat the next game as the soonest game whose signup hasn't fully closed yet.
      // Closing happens when game day ends.
      if (candidate.endOf('day') > now) {
        return candidate;
      }
    }
  }
  throw new Error('Could not find next game date');
}

/**
 * For a given game date, return the Luxon DateTime when signups open
 * (10:00 the day before, in configured timezone).
 */
export function getOpenTimeForGame(gameDate) {
  return gameDate
    .minus({ days: 1 })
    .set({ hour: config.openHour, minute: config.openMinute, second: 0, millisecond: 0 });
}

/**
 * Determine the "current relevant game" for a given moment.
 * This is the next upcoming game whose signups are open or pending.
 * Returns { gameDate, openAt, isOpen, secondsUntilOpen }.
 */
export function getCurrentGameContext(now = DateTime.now().setZone(config.timezone)) {
  const gameDate = getNextGameDate(now);
  const openAt = getOpenTimeForGame(gameDate);
  const isOpen = now >= openAt;
  const secondsUntilOpen = Math.max(0, Math.floor(openAt.diff(now, 'seconds').seconds));
  return { gameDate, openAt, isOpen, secondsUntilOpen };
}
