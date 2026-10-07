'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {Assistant} = require('../ai');
const registry = require('../ai-registry');
const proj = require('../ai-project');
const {Hub} = require('../rooms');

const SCM = proj.writeScm({authURL: [], YaVersion: '208', Source: 'Form', Properties: {
  $Name: 'Screen1', $Type: 'Form', $Version: '27', AppName: 'Pong', Title: 'Pong', Uuid: '0', $Components: [
    {$Name: 'Label1', $Type: 'Label', $Version: '5', Text: 'Score', Uuid: '11'},
    {$Name: 'Button1', $Type: 'Button', $Version: '7', Text: 'Go', Uuid: '12'},
  ]}});
const BKY = '<xml xmlns="https://developers.google.com/blockly/xml">' +
  '<block type="component_event" x="20" y="20"><mutation component_type="Button" instance_name="Button1" event_name="Click" is_generic="false"></mutation>' +
  '<field name="COMPONENT_SELECTOR">Button1</field></block>' +
  '<yacodeblocks ya-version="208" language-version="39"></yacodeblocks></xml>';
const FILES = {'src/a/Screen1.scm': SCM, 'src/a/Screen1.bky': BKY, 'youngandroidproject/project.properties': 'main=a.Screen1\nname=Pong\n'};

// A context the tools run in: a real assistant, a draft of the project, and the events they emit.
function ctx(opts = {}) {
  const events = [];
  const ai = new Assistant({ask: async () => null, hub: new Hub(() => {}), fetchImpl: null, now: () => 1000});
  const ask = async (path) => {
    if (path.startsWith('/ode/collab/bundle')) return {ok: true, files: FILES};
    if (path.startsWith('/ode/collab/files')) return {files: Object.keys(FILES).map(p => ({path: p, bytes: FILES[p].length}))};
    if (path.startsWith('/ode/collab/rawfile')) return {ok: true, mime: 'image/png', data: Buffer.from('iVBORw0KGgo', 'base64').toString('base64')};
    return null;
  };
  const draft = new registry.Draft({projectId: '5', cookie: 'c', ask, full: !!opts.full});
  return Object.assign({me: {userId: 'u-ann', email: 'ann@team.local'}, projectId: '5', cookie: 'c', callId: 'c1', ask,
    emit: ev => events.push(ev), draft, full: !!opts.full, vision: !!opts.vision, assistant: ai}, {events});
}
const run = (name, args, c) => registry.run(name, JSON.stringify(args || {}), c);

test('every tool has a name, a label and a way to run; the model sees only the ones this person may use', () => {
  const names = registry.TOOLS.map(t => t.name);
  assert.strictEqual(new Set(names).size, names.length, 'names are unique');
  for (const t of registry.TOOLS) {
    assert.strictEqual(typeof t.run, 'function', t.name);
    assert.strictEqual(typeof t.label, 'function', t.name);
  }
  const small = registry.definitions(ctx()).map(d => d.function.name);
  assert.ok(small.includes('scm_add_component') && small.includes('check_project'));
  assert.ok(!small.includes('scm_new_screen'), 'new screens are full-app only');
  assert.ok(!small.includes('view_picture'), 'pictures are for models that can see them');
  assert.ok(!small.includes('propose_draft'), 'nothing to propose before a change');
  const full = registry.definitions(Object.assign(ctx({full: true, vision: true}), {draft: {changed: new Map([['x.scm', '1']])}})).map(d => d.function.name);
  assert.ok(full.includes('scm_new_screen') && full.includes('view_picture') && full.includes('propose_draft'));
});

test('an unknown or unavailable tool, and arguments that are not JSON, are answered as errors the model can read', async () => {
  assert.match((await run('no_such_tool', {}, ctx())).text, /not available/);
  assert.match((await run('scm_new_screen', {name: 'Quiz'}, ctx())).text, /not available/);
  const bad = await registry.run('list_files', '{not json', ctx());
  assert.match(bad.text, /not valid JSON/);
});

test('reading tools return the project as the model needs it', async () => {
  const c = ctx();
  assert.match((await run('list_files', {}, c)).text, /src\/a\/Screen1\.scm \(\d+ bytes\)/);
  const read = await run('read_file', {path: 'src/a/Screen1.scm', from: 1, to: 2}, c);
  assert.match(read.text, /^1\| #\|/);
  assert.match(read.text, /\(lines 1-2 of \d+\)/);
  assert.match((await run('search_project', {query: 'label1'}, c)).text, /Screen1\.scm:\d+/);
  assert.strictEqual((await run('search_project', {query: 'nothing-here'}, c)).text, 'No matches.');
  assert.match((await run('screen_outline', {screen: 'Screen1'}, c)).text, /Label1/);
  assert.match((await run('blocks_outline', {screen: 'Screen1'}, c)).text, /Button1/);
  assert.strictEqual((await run('check_project', {}, c)).text, 'No problems found.');
  assert.match((await run('project_settings', {}, c)).text, /main=a\.Screen1/);
  assert.strictEqual((await run('list_pictures', {}, c)).text, 'No pictures yet.');
  assert.match((await run('screen_outline', {screen: 'Nope'}, c)).text, /^Error: there is no screen named Nope/);
});

test('component and block lookups answer from App Inventor\'s own reference', async () => {
  const c = ctx();
  const info = await run('component_info', {type: 'Button'}, c);
  assert.match(info.text, /Designer properties: .*Text/);
  assert.match(info.text, /Events: Click/);
  assert.match((await run('component_info', {type: 'Buton'}, c)).text, /^Error: there is no component type Buton/);
  assert.match((await run('component_types', {category: 'sensors'}, c)).text, /SENSORS: /);
  assert.match((await run('blocks_examples', {}, c)).text, /set_property: /);
  assert.match((await run('blocks_examples', {name: 'set_property'}, c)).text, /component_set_get/);
  assert.match((await run('blocks_examples', {name: 'made_up'}, c)).text, /no example called/);
  assert.match((await run('new_uuid', {}, c)).text, /^\d+$/);
  assert.strictEqual((await run('calculate', {expression: '2 * (3 + 4)'}, c)).text, '14');
  assert.match((await run('calculate', {expression: 'alert(1)'}, c)).text, /Error/);
  assert.match((await run('current_time', {}, c)).text, /UTC/);
});

test('draft tools change the draft only, check their own work, and keep the rules', async () => {
  const c = ctx();
  assert.match((await run('draft_status', {}, c)).text, /Nothing has been changed/);
  assert.match((await run('scm_add_component', {screen: 'Screen1', type: 'Label', name: 'Label2', parent: null, properties: {Text: 'Hi'}}, c)).text, /Added Label2/);
  assert.match((await run('draft_status', {}, c)).text, /src\/a\/Screen1\.scm/);
  assert.match((await run('scm_set_property', {screen: 'Screen1', component: 'Label2', property: 'FontSize', value: '20'}, c)).text, /Set Label2\.FontSize/);
  assert.match((await run('scm_rename_component', {screen: 'Screen1', component: 'Label1', new_name: 'Score'}, c)).text, /Renamed Label1 to Score/);
  assert.match((await run('scm_rename_component', {screen: 'Screen1', component: 'Score', new_name: 'Button1'}, c)).text, /already exists/);
  assert.match((await run('bky_add_event_handler', {screen: 'Screen1', component: 'Button1', event: 'Click'}, c)).text, /already a handler/);
  assert.match((await run('bky_add_event_handler', {screen: 'Screen1', component: 'Score', event: 'Click'}, c)).text, /has no event Click/);
  assert.match((await run('bky_add_blocks', {screen: 'Screen1', blocks: [BOX()]}, c)).text, /Added 1 block/);
  assert.match((await run('bky_add_blocks', {screen: 'Screen1', blocks: []}, c)).text, /give at least one block/);
  assert.match((await run('bky_remove_event_handler', {screen: 'Screen1', component: 'Button1', event: 'Click'}, c)).text, /Removed the handler/);
  assert.match((await run('bky_remove_event_handler', {screen: 'Screen1', component: 'Button1', event: 'Click'}, c)).text, /^Error/);
  assert.match((await run('draft_replace', {path: 'src/a/Screen1.scm', old: 'Score', new: 'Points'}, c)).text, /appears 2 times/);
  assert.match((await run('draft_replace', {path: 'src/a/Screen1.scm', old: 'Score', new: 'Points', all: true}, c)).text, /Replaced 2 place/);
  assert.match((await run('draft_replace', {path: 'src/a/Screen1.scm', old: 'zzz', new: 'x'}, c)).text, /not in the file/);
  assert.match((await run('draft_replace', {path: 'src/a/Screen1.scm', old: 'Label', new: 'Lbl'}, c)).text, /^Error: that text appears/);
  assert.match((await run('scm_remove_component', {screen: 'Screen1', component: 'Button1'}, c)).text, /Removed Button1/);
  assert.match((await run('draft_discard', {path: 'src/a/Screen1.scm'}, c)).text, /Discarded/);
  assert.match((await run('draft_status', {}, c)).text, /src\/a\/Screen1\.bky/);
  await run('draft_discard', {}, c);
  assert.strictEqual((await run('draft_status', {}, c)).text, 'Nothing has been changed yet.');
  assert.match((await run('draft_write', {path: 'youngandroidproject/project.properties', content: 'x'}, c)).text, /Error/);
});

// A block that is a valid App Inventor block, for the tests above.
function BOX() {
  return '<block type="math_number"><field name="NUM">7</field></block>';
}

test('scratch notes are kept for the person, up to 40, and read back exactly', async () => {
  const c = ctx();
  assert.match((await run('scratch_write', {key: 'todo', text: 'two buttons'}, c)).text, /Noted/);
  assert.strictEqual((await run('scratch_read', {key: 'todo'}, c)).text, 'two buttons');
  assert.match((await run('scratch_read', {key: 'nope'}, c)).text, /^Error: there is no note/);
  assert.strictEqual((await run('scratch_list', {}, c)).text, 'todo');
  for (let i = 0; i < 39; i++) await run('scratch_write', {key: 'n' + i, text: 'x'}, c);
  assert.match((await run('scratch_write', {key: 'one-more', text: 'x'}, c)).text, /40 notes already/);
});

test('a picture from the project is shown to a model that can see, and only then', async () => {
  const off = await run('view_picture', {path: 'assets/logo.png'}, ctx());
  assert.match(off.text, /not available/);
  const on = await run('view_picture', {path: 'assets/logo.png'}, ctx({vision: true}));
  assert.strictEqual(on.images[0].mime, 'image/png');
  assert.strictEqual(on.images[0].name, 'logo.png');
});

test('ask_user shows the question and stops; update_plan shows the plan', async () => {
  const c = ctx();
  const asked = await run('ask_user', {question: 'Which colour?'}, c);
  assert.strictEqual(asked.stop, true);
  assert.deepStrictEqual(c.events.find(e => e.type === 'question'), {type: 'question', text: 'Which colour?'});
  const c2 = ctx();
  await run('update_plan', {steps: [{text: 'Read', status: 'done'}, {text: 'Write', status: 'weird'}]}, c2);
  assert.deepStrictEqual(c2.events.find(e => e.type === 'plan').steps, [{text: 'Read', status: 'done'}, {text: 'Write', status: 'todo'}]);
});

test('proposing needs a change first; a finished change is proposed and waits for Apply', async () => {
  assert.match((await run('propose_draft', {summary: 'nothing'}, ctx())).text, /not available here/, 'not offered until there is a change');
  const c = ctx();
  await run('scm_add_component', {screen: 'Screen1', type: 'Label', name: 'Label2'}, c);
  const out = await run('propose_draft', {summary: 'Adds a label'}, c);
  assert.match(out.text, /Proposal ready/);
  const proposal = c.events.find(e => e.type === 'proposal');
  assert.deepStrictEqual(proposal.files, [{path: 'src/a/Screen1.scm', isNew: false}]);
});

test('a new screen in full-app mode is two files in the same folder, proposed together', async () => {
  const c = ctx({full: true});
  assert.match((await run('scm_new_screen', {name: 'Quiz'}, c)).text, /Created Quiz/);
  assert.match((await run('scm_new_screen', {name: 'Quiz'}, c)).text, /already a screen named Quiz/);
  assert.match((await run('scm_new_screen', {name: '1bad'}, c)).text, /starting with a letter/);
  await run('propose_draft', {summary: 'A quiz screen'}, c);
  const proposal = c.events.find(e => e.type === 'proposal');
  assert.deepStrictEqual(proposal.files, [{path: 'src/a/Quiz.scm', isNew: true}, {path: 'src/a/Quiz.bky', isNew: true}]);
});

test('a picture made here can be turned into a PNG, and the media list only takes PNG names', async () => {
  const c = ctx({vision: true});
  const made = await run('create_svg', {name: 'Dot', svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'}, c);
  assert.match(made.text, /Picture created with id svg_/);
  assert.match((await run('create_svg', {name: 'Bad', svg: '<svg onload="x"></svg>'}, c)).text, /^Error/);
  assert.match((await run('svg_to_png', {picture_id: 'svg_nope'}, c)).text, /no picture with that id/);
});
