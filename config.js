import 'dotenv/config';

const required = ['ANTHROPIC_API_KEY'];
for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

export const config = {
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  groupJid: process.env.GROUP_JID || '',
  timezone: process.env.TIMEZONE || 'America/New_York',
  gameDays: (process.env.GAME_DAYS || 'tuesday,thursday')
    .split(',')
    .map((d) => d.trim().toLowerCase()),
  maxPlayers: parseInt(process.env.MAX_PLAYERS || '15', 10),
  openHour: parseInt(process.env.OPEN_HOUR || '10', 10),
  openMinute: parseInt(process.env.OPEN_MINUTE || '0', 10),
};

// Map day names to Luxon weekday numbers (1=Mon..7=Sun)
export const DAY_TO_NUMBER = {
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};
