'use strict';

const test = require('node:test');
const assert = require('node:assert');
const c = require('../ai-context');

const big = n => 'x'.repeat(n);

test('the room is 1M tokens for the newer Claude models and 256K for the rest, and never more than OpenRouter says', () => {
  assert.strictEqual(c.contextTokens('anthropic/claude-sonnet-5.5', 0, undefined), 1000000);
  assert.strictEqual(c.contextTokens('anthropic/claude-haiku-5-5', 0, undefined), 1000000);
  assert.strictEqual(c.contextTokens('some/model', 0, undefined), 256000);
  assert.strictEqual(c.contextTokens('some/model', 1000000, undefined), 256000, 'a bigger room is not assumed');
  assert.strictEqual(c.contextTokens('some/model', 128000, undefined), 128000, 'a smaller one is respected');
  assert.strictEqual(c.contextTokens('anthropic/claude-sonnet-5.5', 200000, undefined), 200000);
  assert.strictEqual(c.contextTokens('some/model', 0, '64000'), 64000, 'AI_CONTEXT_TOKENS wins');
});

test('a conversation under the trigger is left alone', async () => {
  const messages = [{role: 'system', content: 'rules'}, {role: 'user', content: 'hi'}, {role: 'assistant', content: 'hello'}];
  const before = JSON.stringify(messages);
  const r = await c.compactContext(messages, {window: 256000, maxOutput: 8000, summarize: async () => { throw new Error('no'); }});
  assert.strictEqual(r, null);
  assert.strictEqual(JSON.stringify(messages), before);
});

test('old tool results are shortened first; the newest are kept, and no notes are written if that is enough', async () => {
  const messages = [{role: 'system', content: 'rules'}, {role: 'user', content: 'build it'}];
  for (let i = 0; i < 10; i++) {
    messages.push({role: 'assistant', content: null, tool_calls: [{id: 't' + i, type: 'function', function: {name: 'read_file', arguments: '{}'}}]});
    messages.push({role: 'tool', tool_call_id: 't' + i, content: big(60000)});
  }
  messages.push({role: 'assistant', content: 'latest'});
  let summarised = false;
  const r = await c.compactContext(messages, {window: 60000, maxOutput: 1000,
    summarize: async () => { summarised = true; return 'notes'; }});
  assert.strictEqual(r.how, 'shortened');
  assert.strictEqual(summarised, false);
  assert.strictEqual(messages[2].content, null, 'the calls stay');
  assert.strictEqual(messages[messages.length - 2].content, big(60000), 'the newest result is kept whole');
  assert.strictEqual(messages[messages.length - 1].content, 'latest');
});

test('when shortening is not enough, the oldest steps become the notes the model wrote, and the newest are kept', async () => {
  const messages = [{role: 'system', content: 'rules'}, {role: 'user', content: 'Build a quiz app with a score screen'}];
  for (let i = 0; i < 12; i++) {
    messages.push({role: 'assistant', content: 'step ' + i + ' ' + big(3000), tool_calls: [{id: 'c' + i, type: 'function', function: {name: 'draft_write', arguments: '{"content":"' + big(3000) + '"}'}}]});
    messages.push({role: 'tool', tool_call_id: 'c' + i, content: 'done ' + i});
  }
  messages.push({role: 'user', content: 'and now?'});
  const seen = [];
  const notices = [];
  const r = await c.compactContext(messages, {window: 20000, maxOutput: 1000,
    notice: t => notices.push(t),
    summarize: async text => { seen.push(text); return 'NOTES: a quiz app with a score screen; screen 1 done'; }});
  assert.strictEqual(r.how, 'summarised');
  assert.ok(r.steps > 0);
  assert.match(seen[0], /Person: Build a quiz app with a score screen/, 'the notes are written from the real steps');
  assert.strictEqual(notices.length, 1, 'the person is told once');
  assert.strictEqual(messages[0].content, 'rules');
  assert.strictEqual(messages[1].role, 'user');
  assert.match(JSON.stringify(messages[1]), /NOTES: a quiz app with a score screen/);
  assert.strictEqual(messages[messages.length - 1].content, 'and now?', 'the newest message is kept');
});

test('the kept part never starts with a tool result, and no two user messages are left side by side', async () => {
  const messages = [{role: 'system', content: 's'}, {role: 'user', content: 'start'}];
  for (let i = 0; i < 6; i++) {
    messages.push({role: 'assistant', content: 'x' + big(20000), tool_calls: [{id: 'k' + i, type: 'function', function: {name: 'f', arguments: '{}'}}]});
    messages.push({role: 'tool', tool_call_id: 'k' + i, content: big(20000)});
  }
  messages.push({role: 'user', content: 'go on'});
  await c.compactContext(messages, {window: 12000, maxOutput: 500, summarize: async () => 'notes'});
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === 'tool') assert.strictEqual(messages[i - 1].role, 'assistant', 'a result follows its call');
    if (messages[i].role === 'user' && i > 1) assert.notStrictEqual(messages[i - 1].role, 'user', 'no two user messages in a row');
  }
});

test('if the notes cannot be written, the older steps are removed and the answer is told so', async () => {
  const messages = [{role: 'system', content: 's'}, {role: 'user', content: 'start'}];
  for (let i = 0; i < 10; i++) messages.push({role: i % 2 ? 'assistant' : 'user', content: 'm' + i + ' ' + big(4000)});
  messages.push({role: 'user', content: 'end'});
  const r = await c.compactContext(messages, {window: 10000, maxOutput: 500,
    summarize: async () => { throw new Error('service answered 500'); }});
  assert.strictEqual(r.how, 'removed');
  assert.match(JSON.stringify(messages), /were removed to make room/);
  assert.strictEqual(messages[messages.length - 1].content, 'end');
});

test('a room of 1M tokens does not compact a conversation that would fill 256K', async () => {
  const messages = [{role: 'system', content: 's'}, {role: 'user', content: big(600000)},
    {role: 'assistant', content: 'ok'}, {role: 'user', content: 'next'}];
  const small = await c.compactContext(JSON.parse(JSON.stringify(messages)), {window: 256000, maxOutput: 8000, summarize: async () => 'n'});
  const large = await c.compactContext(messages, {window: 1000000, maxOutput: 8000, summarize: async () => 'n'});
  assert.ok(small, 'the 256K room needs it');
  assert.strictEqual(large, null, 'the 1M room does not');
});

test('the room for the prompt is what is left after the answer and the tool definitions', () => {
  const b = c.budgets(256000, 8000, 20000);
  assert.strictEqual(b.limit, 228000);
  assert.strictEqual(b.trigger, Math.floor(228000 * 0.75));
  assert.ok(b.goal < b.trigger && b.recent < b.goal);
});

test('reasoning pieces sent back with a tool call take room in the window too', () => {
  const plain = {role: 'assistant', content: null, tool_calls: [{id: 't', type: 'function', function: {name: 'x', arguments: '{}'}}]};
  const thinking = Object.assign({}, plain, {reasoning_details: [{type: 'reasoning.text', text: big(3000), index: 0}]});
  assert.ok(c.tokensOf(thinking) - c.tokensOf(plain) >= 1000);
});

test('the Ling 3.1 and 3.0 Flash models have a window of 262144 tokens, whether OpenRouter lists 1M or nothing', () => {
  for (const model of ['inclusionai/ling-3.1-flash', 'inclusionai/ling-3.0-flash']) {
    assert.strictEqual(c.contextTokens(model, 1000000, undefined), 262144, model + ' when 1M is listed');
    assert.strictEqual(c.contextTokens(model, 0, undefined), 262144, model + ' when nothing is listed');
  }
});

test('AI_CONTEXT_TOKENS=1000000 cannot raise a Ling Flash model above 262144 tokens', () => {
  assert.strictEqual(c.contextTokens('inclusionai/ling-3.1-flash', 0, '1000000'), 262144);
  assert.strictEqual(c.contextTokens('inclusionai/ling-3.0-flash', 1000000, '1000000'), 262144);
});

test('AI_CONTEXT_TOKENS=100000 lowers a Ling Flash model to 100000 tokens, and OpenRouter\'s listed size can only lower it further', () => {
  assert.strictEqual(c.contextTokens('inclusionai/ling-3.1-flash', 0, '100000'), 100000);
  assert.strictEqual(c.contextTokens('inclusionai/ling-3.1-flash', 128000, '100000'), 100000);
  assert.strictEqual(c.contextTokens('inclusionai/ling-3.1-flash', 128000, undefined), 128000);
  assert.strictEqual(c.contextTokens('inclusionai/ling-3.1-flash', 128000, '200000'), 128000, 'a bigger setting does not beat the listed size');
});

test('the Claude 5 Haiku model has its 1M-token window, and AI_CONTEXT_TOKENS cannot raise it above that', () => {
  assert.strictEqual(c.contextTokens('anthropic/claude-haiku-5.5', 0, undefined), 1000000);
  assert.strictEqual(c.contextTokens('anthropic/claude-haiku-5.5', 0, '2000000'), 1000000);
});

test('a model whose window is not known has 256000 tokens, and so do Ling models that are not Flash models', () => {
  assert.strictEqual(c.contextTokens('some/model', 0, undefined), 256000);
  assert.strictEqual(c.contextTokens('inclusionai/ling-2.0-flash', 0, undefined), 256000);
  assert.strictEqual(c.contextTokens('inclusionai/ling-3.1-pro', 0, undefined), 256000);
});

test('a Ling conversation that passes 75% of 262144 less the answer and the tools is compacted; in a 1M room the same one is not', async () => {
  const room = c.contextTokens('inclusionai/ling-3.1-flash', 0, undefined);
  const maxOutput = 32000;
  const toolsTokens = 20000;
  const trigger = Math.floor((room - maxOutput - toolsTokens) * 0.75);
  // The conversation is the system message and 'start' (3 tokens), then messages of 1000 tokens each. This many of them
  // stay under the trigger; one more goes over it.
  const under = Math.floor((trigger - 3) / 1000);
  const conversation = n => [{role: 'system', content: 's'}, {role: 'user', content: 'start'}].concat(
    Array.from({length: n}, (_, i) => ({role: i % 2 ? 'user' : 'assistant', content: big(3000)})));
  const refuse = async () => { throw new Error('the notes are not needed here'); };
  assert.strictEqual(await c.compactContext(conversation(under), {window: room, maxOutput, toolsTokens, summarize: refuse}), null,
    'under the trigger, nothing is done');
  const r = await c.compactContext(conversation(under + 1), {window: room, maxOutput, toolsTokens, summarize: async () => 'notes'});
  assert.ok(r && r.steps > 0, 'over the trigger, the conversation is made shorter');
  assert.strictEqual(await c.compactContext(conversation(under + 1), {window: 1000000, maxOutput, toolsTokens, summarize: refuse}), null,
    'the same conversation in a 1M room is not');
});
