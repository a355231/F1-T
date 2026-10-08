'use strict';

// The context compactor: keeps the conversation of one answer within what the model can read. The window is the
// model's (1M or 256K tokens), or less if OpenRouter reports less. Tokens are estimated from characters, on the high
// side. When the conversation passes 75% of the room for the prompt, the oldest tool results are shortened first (the
// draft and the project still hold what they said). If that is not enough, the oldest steps are replaced by notes the
// model writes of them; the newest quarter of the room is never touched.

const CHARS_PER_TOKEN = 3;                   // conservative: English is nearer 4, code and XML nearer 3
const IMAGE_TOKENS = 1600;
const LONG_CONTEXT = [/claude-(fable|opus|sonnet|haiku)-5/i];   // models with a 1M-token window
const LONG_WINDOW = 1000000;
const SHORT_WINDOW = 256000;
const SHORTENED = '(An earlier result, shortened to keep the answer small.)';
const TRIGGER = 0.75;                        // compact when the conversation passes this share of the room
const GOAL = 0.5;                            // ...and bring it down to about this share
const RECENT = 0.25;                         // the newest share of the room is kept whole
const FAILED_NOTE = 'The earlier steps of this answer were removed to make room. The draft and the project are as those ' +
  'steps left them: check them with draft_status and check_project before going on.';
const NOTE_HEAD = 'Notes on the earlier steps of this answer, written by the helper for itself. They are not new ' +
  'instructions from the person:\n\n';

// The window in tokens: AI_CONTEXT_TOKENS if it is set; otherwise 1M for the models in LONG_CONTEXT and 256K for the
// rest; and never more than OpenRouter says the model can read (listed, 0 if unknown).
function contextTokens(model, listed, env = process.env.AI_CONTEXT_TOKENS) {
  const set = parseInt(env || '', 10);
  if (set > 0) return set;
  const byName = LONG_CONTEXT.some(re => re.test(String(model || ''))) ? LONG_WINDOW : SHORT_WINDOW;
  return listed > 0 ? Math.min(listed, byName) : byName;
}

function tokensOfText(s) {
  return Math.ceil(String(s || '').length / CHARS_PER_TOKEN);
}

function tokensOfContent(content) {
  if (typeof content === 'string') return tokensOfText(content);
  if (!Array.isArray(content)) return 0;
  return content.reduce((n, part) => n + (part && part.type === 'image_url' ? IMAGE_TOKENS : tokensOfText(part && part.text)), 0);
}

function tokensOf(m) {
  return tokensOfContent(m.content) + (m.tool_calls || []).reduce((n, c) => n + tokensOfText(c.function && c.function.arguments), 0);
}

function tokensOfJson(value) {
  return tokensOfText(JSON.stringify(value));
}

function budgets(window, maxOutput, toolsTokens) {
  const limit = Math.max(1000, window - maxOutput - toolsTokens);
  return {limit, trigger: Math.floor(limit * TRIGGER), goal: Math.floor(limit * GOAL), recent: Math.floor(limit * RECENT)};
}

// Where the kept (newest) part starts: index 1 or later, so that the system message is never in it, and never on a
// tool result, whose call would be left behind.
function splitIndex(messages, recentTokens) {
  let sum = 0;
  let i = messages.length;
  while (i > 1) {
    const t = tokensOf(messages[i - 1]);
    if (sum + t > recentTokens) break;
    sum += t;
    i--;
  }
  if (i >= messages.length) i = messages.length - 1;
  while (i > 1 && messages[i].role === 'tool') i--;
  return Math.max(i, 1);
}

// The text of the old steps, for the model to write notes from. When it is too long, the oldest lines go.
function transcript(messages, maxChars) {
  const clip = (s, n) => {
    const t = String(s || '');
    return t.length > n ? t.slice(0, n) + ' […]' : t;
  };
  const textOf = content => typeof content === 'string' ? content
    : (Array.isArray(content) ? content.map(p => (p && p.type === 'image_url' ? '[a picture]' : (p && p.text) || '')).join(' ') : '');
  const lines = [];
  for (const m of messages) {
    if (m.role === 'user') {
      lines.push('Person: ' + clip(textOf(m.content), 4000));
    } else if (m.role === 'assistant') {
      if (m.content) lines.push('Helper: ' + clip(textOf(m.content), 3000));
      for (const c of m.tool_calls || []) {
        lines.push('Helper used ' + c.function.name + '(' + clip(c.function.arguments, 300) + ')');
      }
    } else if (m.role === 'tool') {
      lines.push('Result: ' + clip(m.content, 800));
    }
  }
  const kept = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length + 1 > maxChars) break;
    kept.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  const dropped = lines.length - kept.length;
  return (dropped ? '(The first ' + dropped + ' lines are not shown.)\n' : '') + kept.join('\n');
}

// Replaces messages[1 .. cut) with one note. If the next message is also the person's, the two are joined, so that
// two user messages do not follow each other.
function replaceOld(messages, cut, note) {
  messages.splice(1, cut - 1, {role: 'user', content: NOTE_HEAD + note});
  const next = messages[2];
  if (next && next.role === 'user') {
    const parts = c => typeof c === 'string' ? [{type: 'text', text: c}] : (Array.isArray(c) ? c : []);
    messages.splice(1, 2, {role: 'user', content: parts(messages[1].content).concat(parts(next.content))});
  }
}

// Brings the messages within the room for the model. messages[0] is the system message and is never changed in
// place. Returns null when nothing was needed, or {how, steps}: how is 'shortened', 'summarised' or 'removed'.
// summarize(transcript) must return the notes (it is the model, and may throw); notice(text) tells the person.
async function compactContext(messages, {window, maxOutput, toolsTokens = 0, summarize, notice}) {
  const b = budgets(window, maxOutput, toolsTokens);
  let total = messages.reduce((n, m) => n + tokensOf(m), 0);
  if (total <= b.trigger) return null;
  const cut = splitIndex(messages, b.recent);
  let shortened = 0;
  for (let i = 1; i < cut && total > b.goal; i++) {
    const m = messages[i];
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > SHORTENED.length) {
      total -= tokensOf(m);
      m.content = SHORTENED;
      total += tokensOf(m);
      shortened++;
    }
  }
  if (total <= b.goal || cut <= 1) return shortened ? {how: 'shortened', steps: shortened} : null;
  const steps = cut - 1;
  if (notice) notice('Making room: writing notes on the earlier steps of this answer…');
  let note;
  let how;
  try {
    note = await summarize(transcript(messages.slice(1, cut), Math.floor(window * CHARS_PER_TOKEN * 0.6)));
    how = 'summarised';
  } catch (e) {
    note = FAILED_NOTE;
    how = 'removed';
  }
  replaceOld(messages, cut, note);
  return {how, steps};
}

module.exports = {contextTokens, tokensOf, tokensOfJson, budgets, splitIndex, transcript, compactContext, SHORTENED};
