// Telegram bot that relays its owner's messages to Claude Code on this server and sends
// back the replies. One conversation continues until the owner sends /new.
// Claude's permissions live in .claude/settings.json next to this file.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER = Number(process.env.TELEGRAM_OWNER_ID || 0);
const HERE = import.meta.dirname;
const STATE = path.join(process.env.STATE_DIR ?? path.join(HERE, '.state'), 'state.json');
const CLAUDE = process.env.CLAUDE_BIN ?? `${process.env.HOME}/.local/bin/claude`;
const TIME_ZONE = 'Europe/London';
const LIMIT = 4000; // Telegram allows 4096 characters per message

fs.mkdirSync(path.dirname(STATE), { recursive: true });
const state = fs.existsSync(STATE) ? JSON.parse(fs.readFileSync(STATE, 'utf8')) : { offset: 0, session: null };
const save = () => fs.writeFileSync(STATE, JSON.stringify(state));

async function telegram(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${method}: ${json.description}`);
  return json.result;
}

async function reply(chat, text) {
  for (let i = 0; i < text.length || i === 0; i += LIMIT) {
    await telegram('sendMessage', { chat_id: chat, text: text.slice(i, i + LIMIT) || '(no reply)' });
  }
}

// Claude runs without the bot's or 1Password's tokens in its environment.
function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(TELEGRAM_|OP_)/.test(key)) delete env[key];
  return env;
}

function askClaude(text) {
  const sent = new Date().toLocaleString('en-GB', { timeZone: TIME_ZONE, dateStyle: 'full', timeStyle: 'short' });
  const args = [
    '-p', `${text}\n\n(Sent from Telegram on ${sent}, ${TIME_ZONE} time.)`,
    '--output-format', 'json',
    '--setting-sources', 'project',
    '--strict-mcp-config',
    '--permission-mode', 'dontAsk',
  ];
  if (state.session) args.push('--resume', state.session);
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, args, { cwd: HERE, env: childEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const timer = setTimeout(() => child.kill('SIGTERM'), 15 * 60_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(out);
        state.session = result.session_id ?? state.session;
        save();
        resolve(result.result || `(Claude finished without a reply: ${result.subtype})`);
      } catch {
        resolve(`Claude failed (exit ${code}): ${(err || out).slice(-500)}`);
      }
    });
  });
}

async function handle(message) {
  const chat = message.chat.id;
  if (message.from?.id !== OWNER) {
    // Lets the owner find their ID during setup; tells strangers nothing else.
    if (!OWNER) await reply(chat, `Your Telegram user ID is ${message.from?.id}.`);
    console.log(`ignored message from ${message.from?.id}`);
    return;
  }
  const text = message.text ?? message.caption;
  if (!text) return reply(chat, 'I can only read text messages.');
  if (text.trim() === '/new') {
    state.session = null;
    save();
    return reply(chat, 'Started a new conversation.');
  }
  const typing = setInterval(() => telegram('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {}), 4000);
  telegram('sendChatAction', { chat_id: chat, action: 'typing' }).catch(() => {});
  try {
    await reply(chat, await askClaude(text));
  } finally {
    clearInterval(typing);
  }
}

// Long polling: one message at a time, in order.
for (;;) {
  try {
    const updates = await telegram('getUpdates', { offset: state.offset, timeout: 50, allowed_updates: ['message'] });
    for (const update of updates) {
      state.offset = update.update_id + 1;
      save();
      if (update.message) await handle(update.message).catch((e) => console.error('handle failed:', e.message));
    }
  } catch (e) {
    console.error('poll failed:', e.message);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
