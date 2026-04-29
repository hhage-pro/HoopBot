import Anthropic from '@anthropic-ai/sdk';
import { config } from './config.js';

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

/**
 * Classification result shape:
 *   { intent: 'IN' | 'OUT' | 'QUESTION' | 'CHATTER', plusCount: 0|1|2|3, source: 'regex'|'ai' }
 */

const IN_KEYWORDS = [
  /\bin\b/i,
  /\bi'?m in\b/i,
  /\bcount me in\b/i,
  /\bput me (down|in)\b/i,
  /\bsign me up\b/i,
  /\bdown\b/i, // "i'm down"
  /^\+1\b/,
  /^👍/u,
  /^✅/u,
  /^🙋/u,
  /^🏀.*\bin\b/i,
];

const OUT_KEYWORDS = [
  /\bout\b/i,
  /\bcan'?t (make it|go|come|play)\b/i,
  /\bcannot (make it|go|come|play)\b/i,
  /\bremove me\b/i,
  /\btake me off\b/i,
  /\bdrop me\b/i,
  /\bnot in\b/i,
  /\bno longer (can|able)\b/i,
];

const QUESTION_HINTS = [/\?$/, /^what time/i, /^where/i, /^when/i, /^is (this|the game)/i];

// Detect "+N" friends. Examples: "in +1", "in +2", "in plus one", "+1 me + buddy"
function extractPlusCount(text) {
  const plusMatch = text.match(/\+\s*(\d+)/);
  if (plusMatch) return Math.min(parseInt(plusMatch[1], 10), 3);
  if (/\bplus one\b|\b\+one\b/i.test(text)) return 1;
  if (/\bplus two\b|\b\+two\b/i.test(text)) return 2;
  if (/\band a friend\b|\bbringing (a )?friend\b/i.test(text)) return 1;
  return 0;
}

function regexClassify(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Very short pure-keyword cases
  const lower = trimmed.toLowerCase();
  if (lower === 'in' || lower === "i'm in" || lower === 'im in') {
    return { intent: 'IN', plusCount: 0, source: 'regex' };
  }
  if (lower === 'out' || lower === "i'm out" || lower === 'im out') {
    return { intent: 'OUT', plusCount: 0, source: 'regex' };
  }

  const looksLikeQuestion = QUESTION_HINTS.some((re) => re.test(trimmed));
  const inHit = IN_KEYWORDS.some((re) => re.test(trimmed));
  const outHit = OUT_KEYWORDS.some((re) => re.test(trimmed));

  // If both IN and OUT match, it's ambiguous — punt to AI.
  if (inHit && outHit) return null;
  // Questions about the game shouldn't count as signups even if they contain "in"
  if (looksLikeQuestion && !inHit) return { intent: 'QUESTION', plusCount: 0, source: 'regex' };
  if (looksLikeQuestion && inHit) return null; // ambiguous, ask AI

  if (inHit) return { intent: 'IN', plusCount: extractPlusCount(trimmed), source: 'regex' };
  if (outHit) return { intent: 'OUT', plusCount: 0, source: 'regex' };

  // Pure short text with no keyword → probably chatter, but if it's longer or weird, ask AI
  if (trimmed.length < 4) return { intent: 'CHATTER', plusCount: 0, source: 'regex' };

  return null; // unclear → AI
}

const SYSTEM_PROMPT = `You classify WhatsApp messages in a pickup basketball signup chat.

Categorize the message as exactly one of:
- IN: the sender wants to play (or sign up a friend with them)
- OUT: the sender is dropping out / can't make it / removing themselves
- QUESTION: the sender is asking a question about the game
- CHATTER: anything else — banter, reactions to other messages, etc.

If IN, also count how many EXTRA people they're bringing (0, 1, 2, or 3 max). "in +1" = 1 extra. "in" alone = 0 extras.

Respond with ONLY a JSON object, no other text:
{"intent": "IN|OUT|QUESTION|CHATTER", "plusCount": 0}`;

async function aiClassify(text) {
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: text }],
    });
    const raw = response.content[0]?.text?.trim() || '';
    // Strip code fences if present
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!['IN', 'OUT', 'QUESTION', 'CHATTER'].includes(parsed.intent)) {
      return { intent: 'CHATTER', plusCount: 0, source: 'ai' };
    }
    const plusCount = Math.max(0, Math.min(3, parseInt(parsed.plusCount || 0, 10)));
    return { intent: parsed.intent, plusCount, source: 'ai' };
  } catch (err) {
    console.error('AI classify failed:', err.message);
    return { intent: 'CHATTER', plusCount: 0, source: 'ai-error' };
  }
}

export async function classifyMessage(text) {
  const regexResult = regexClassify(text);
  if (regexResult) return regexResult;
  return aiClassify(text);
}
