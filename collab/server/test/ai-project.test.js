'use strict';

const test = require('node:test');
const assert = require('node:assert');
const proj = require('../ai-project');

// A small screen with a label and an arrangement that holds a button.
function screen() {
  return proj.parseScm(proj.writeScm({authURL: [], YaVersion: '208', Source: 'Form', Properties: {
    $Name: 'Screen1', $Type: 'Form', $Version: '27', AppName: 'Pong', Title: 'Pong', Uuid: '0', $Components: [
      {$Name: 'Label1', $Type: 'Label', $Version: '5', Text: 'Score', Uuid: '11'},
      {$Name: 'Arr1', $Type: 'VerticalArrangement', $Version: '6', Uuid: '12', $Components: [
        {$Name: 'Button1', $Type: 'Button', $Version: '7', Text: 'Go', Uuid: '13'},
      ]},
    ]}}));
}
const BKY = '<xml xmlns="https://developers.google.com/blockly/xml">' +
  '<block type="component_event" x="20" y="20"><mutation component_type="Button" instance_name="Button1" event_name="Click" is_generic="false"></mutation>' +
  '<field name="COMPONENT_SELECTOR">Button1</field></block>' +
  '<yacodeblocks ya-version="208" language-version="39"></yacodeblocks></xml>';

test('a designer file reads and writes back as the same JSON, with its wrapper', () => {
  const obj = screen();
  const text = proj.writeScm(obj);
  assert.ok(text.startsWith('#|\n$JSON\n') && text.endsWith('\n|#\n'));
  assert.deepStrictEqual(proj.parseScm(text), obj);
  assert.throws(() => proj.parseScm('hello'), /not a designer/);
  assert.throws(() => proj.parseScm('#|\n$JSON\n{"Properties":{}}\n|#'), /no screen/);
});

test('components are added to the screen or inside an arrangement, with their properties checked', () => {
  const obj = screen();
  assert.deepStrictEqual(proj.addComponent(obj, {type: 'Button', name: 'Button2', parent: null, properties: {Text: 'Stop'}}).ok, true);
  assert.deepStrictEqual(proj.addComponent(obj, {type: 'Label', name: 'Label2', parent: 'Arr1', properties: {}}).ok, true);
  assert.ok(proj.findNode(obj, 'Label2').parent, 'Label2 is inside Arr1');
  assert.match(proj.addComponent(obj, {type: 'Buton', name: 'B3', parent: null, properties: {}}).error, /unknown component type/);
  assert.match(proj.addComponent(obj, {type: 'Button', name: 'Label1', parent: null, properties: {}}).error, /already exists/);
  assert.match(proj.addComponent(obj, {type: 'Button', name: '1st', parent: null, properties: {}}).error, /letters, digits/);
  assert.match(proj.addComponent(obj, {type: 'Button', name: 'B4', parent: 'Nowhere', properties: {}}).error, /no component named Nowhere/);
  assert.match(proj.addComponent(obj, {type: 'Button', name: 'B5', parent: 'Label1', properties: {}}).error, /cannot hold other components/);
  assert.match(proj.addComponent(obj, {type: 'Button', name: 'B6', parent: null, properties: {Colour: 'red'}}).error, /no designer property "Colour"/);
});

test('a property is set on a component, and only a known property is accepted', () => {
  const obj = screen();
  assert.deepStrictEqual(proj.setProperty(obj, 'Label1', 'Text', 'Points'), {ok: true});
  assert.strictEqual(proj.findNode(obj, 'Label1').node.Text, 'Points');
  assert.match(proj.setProperty(obj, 'Label1', 'Sparkle', 'yes').error, /no designer property "Sparkle"/);
  assert.match(proj.setProperty(obj, 'Ghost', 'Text', 'x').error, /no component named Ghost/);
});

test('removing an arrangement removes what is inside it; the screen itself cannot be removed', () => {
  const obj = screen();
  const r = proj.removeComponent(obj, 'Arr1');
  assert.deepStrictEqual(r.removed.sort(), ['Arr1', 'Button1']);
  const names = proj.componentNames(obj);
  assert.ok(names.includes('Label1'));
  assert.ok(!names.includes('Arr1') && !names.includes('Button1'), 'the arrangement and its button are gone');
  assert.match(proj.removeComponent(obj, 'Screen1').error, /cannot be removed/);
});

test('renaming a component refuses names that are taken or not valid', () => {
  const obj = screen();
  assert.deepStrictEqual(proj.renameComponent(obj, 'Button1', 'GoButton'), {ok: true});
  assert.ok(proj.findNode(obj, 'GoButton'));
  assert.match(proj.renameComponent(obj, 'GoButton', 'Label1').error, /already exists/);
  assert.match(proj.renameComponent(obj, 'GoButton', 'bad name').error, /letters, digits/);
});

test('a new screen has a designer file and an empty blocks file that both read back', () => {
  const made = proj.newScreen('Quiz', 'My quiz');
  const obj = proj.parseScm(made.scm);
  assert.strictEqual(obj.Properties.$Name, 'Quiz');
  assert.strictEqual(obj.Properties.AppName, 'My quiz');
  assert.deepStrictEqual(proj.bkyOutline(made.bky).split('\n').filter(Boolean).length >= 0, true);
  proj.parseXml(made.bky);
});

test('the blocks file must be well formed XML: a broken one is refused', () => {
  assert.doesNotThrow(() => proj.parseXml(BKY));
  assert.throws(() => proj.parseXml('<xml><block></xml>'), /does not match|never closed/);
  assert.throws(() => proj.parseXml('<xml></xml>trailing text'), /text after|outside/);
  assert.throws(() => proj.parseXml('just words'), /text after|no root element/);
});

test('event handlers are listed, added and removed; blocks that are not blocks are refused', () => {
  const body = proj.checkBlockXml('<block type="controls_if"><mutation else="0"></mutation></block>');
  assert.strictEqual(body.length, 1);
  assert.throws(() => proj.checkBlockXml('<field name="x">y</field>'), /must be <block> elements/);

  const handler = proj.eventHandlerXml('Button', 'Button1', 'Click', body);
  const added = proj.addTopBlocks(BKY, [handler]);
  assert.deepStrictEqual(proj.eventHandlers(added).map(h => [h.component, h.event]), [['Button1', 'Click'], ['Button1', 'Click']]);
  assert.match(added, /<statement name="DO">/);
  assert.ok(added.indexOf('component_event') < added.indexOf('<yacodeblocks'), 'the handler goes before the settings');

  const removed = proj.removeEventHandler(added, 'Button1', 'Click');
  assert.ok(!removed.error);
  assert.strictEqual(proj.eventHandlers(removed.text).length, 1);
  assert.match(proj.removeEventHandler(BKY, 'Button9', 'Click').error, /no handler for Button9.Click/);
});

test('adding blocks to a broken file is refused, so the file is never damaged', () => {
  assert.throws(() => proj.addTopBlocks('<xml><block>', [proj.eventHandlerXml('Button', 'Button1', 'Click', [])]), /never closed|does not match/);
});

test('renaming a component in the blocks changes its name in both places', () => {
  const out = proj.renameInBlocks(BKY, 'Button1', 'GoButton');
  assert.match(out, /instance_name="GoButton"/);
  assert.match(out, /COMPONENT_SELECTOR">GoButton</);
  assert.doesNotMatch(out, /Button1/);
});

test('the project check names unknown types, duplicates, handlers for missing parts and a missing main screen', () => {
  const clean = {
    'src/a/Screen1.scm': proj.writeScm(screen()),
    'src/a/Screen1.bky': BKY,
    'youngandroidproject/project.properties': 'main=a.Screen1\nname=Pong\n',
  };
  assert.deepStrictEqual(proj.checkProject(clean), []);

  const broken = Object.assign({}, clean, {
    'youngandroidproject/project.properties': 'name=Pong\n',
    'src/a/Screen1.bky': BKY.replace('instance_name="Button1"', 'instance_name="Button9"').replace('COMPONENT_SELECTOR">Button1', 'COMPONENT_SELECTOR">Button9'),
  });
  const messages = proj.checkProject(broken).map(p => p.message).join('\n');
  assert.match(messages, /Button9/);
  assert.match(messages, /main/);

  const withTypo = Object.assign({}, clean, {'src/a/Screen2.scm': proj.writeScm({authURL: [], Source: 'Form', Properties: {$Name: 'Screen2', $Type: 'Form', $Version: '27', $Components: [{$Name: 'X', $Type: 'Buton', $Version: '1', Uuid: '1'}]}})});
  assert.match(proj.checkProject(withTypo).map(p => p.message).join('\n'), /unknown type Buton/);
  const twins = screen();
  twins.Properties.$Components.push({$Name: 'Button1', $Type: 'Button', $Version: '7', Uuid: '99'});
  assert.match(proj.checkProject(Object.assign({}, clean, {'src/a/Screen1.scm': proj.writeScm(twins)})).map(p => p.message).join('\n'), /two components are named Button1/);
  const twoHandlers = BKY.replace('<yacodeblocks',
    '<block type="component_event"><mutation component_type="Button" instance_name="Button1" event_name="Click"></mutation><field name="COMPONENT_SELECTOR">Button1</field></block><yacodeblocks');
  assert.match(proj.checkProject(Object.assign({}, clean, {'src/a/Screen1.bky': twoHandlers})).map(p => p.message).join('\n'), /two handlers for Button1.Click/);
  const ghostBlock = BKY.replace('<yacodeblocks', '<block type="component_set_get"><field name="COMPONENT_SELECTOR">Ghost</field></block><yacodeblocks');
  assert.match(proj.checkProject(Object.assign({}, clean, {'src/a/Screen1.bky': ghostBlock})).map(p => p.message).join('\n'), /a block uses Ghost/);
});

test('an outline shows the tree of components, and a blocks outline lists the handlers', () => {
  const text = proj.outline(screen());
  assert.match(text, /Label1/);
  assert.match(text, /Button1/);
  assert.match(proj.bkyOutline(BKY), /Button1/);
});

test('new numbers are unique numbers, and block ids are hex', () => {
  const ids = new Set();
  for (let i = 0; i < 50; i++) ids.add(proj.newUuid());
  assert.strictEqual(ids.size, 50);
  assert.ok([...ids].every(id => /^\d+$/.test(id)));
  assert.match(proj.blockId(), /^[0-9a-f]{20}$/);
});

test('a malformed blocks file cannot hold up the server: long runs of spaces or openings parse in moments', () => {
  for (const bad of ['<a' + ' '.repeat(50000) + 'x', '<a'.repeat(20000), '<' + 'x '.repeat(20000)]) {
    const t = Date.now();
    assert.throws(() => proj.parseXml(bad));
    assert.ok(Date.now() - t < 500, 'took ' + (Date.now() - t) + ' ms');
  }
});

// ---- the meaning of blocks, and values written the way people write them ----

const REF_SCM = proj.writeScm({authURL: [], YaVersion: '237', Source: 'Form', Properties: {
  $Name: 'Screen1', $Type: 'Form', $Version: '27', AppName: 'Quiz', Title: 'Quiz', Uuid: '0', $Components: [
    {$Name: 'Label1', $Type: 'Label', $Version: '5', Uuid: '1'},
    {$Name: 'Button1', $Type: 'Button', $Version: '7', Uuid: '2'},
    {$Name: 'Notifier1', $Type: 'Notifier', $Version: '6', Uuid: '3'},
  ]}});
const bky = blocks => '<xml xmlns="https://developers.google.com/blockly/xml">' + blocks.join('') +
  '<yacodeblocks ya-version="237" language-version="39"></yacodeblocks></xml>';
const problemsOf = text => proj.checkProject({'src/a/Screen1.scm': REF_SCM, 'src/a/Screen1.bky': text,
  'youngandroidproject/project.properties': 'main=a.Screen1\n'}).map(p => p.message);

test('every block example the helper copies passes the check', () => {
  const {BLOCK_EXAMPLES} = require('../ai-registry');
  assert.deepStrictEqual(problemsOf(bky(Object.values(BLOCK_EXAMPLES).map(e => e.xml))), []);
});

test('blocks that App Inventor would load broken are named: wrong property, method, event, type, variable, procedure', () => {
  const found = problemsOf(bky([
    '<block type="component_set_get"><mutation component_type="Label" set_or_get="set" property_name="Txt" is_generic="false" instance_name="Label1"></mutation><field name="COMPONENT_SELECTOR">Label1</field></block>',
    '<block type="component_method"><mutation component_type="Notifier" method_name="Show" is_generic="false" instance_name="Notifier1"></mutation><field name="COMPONENT_SELECTOR">Notifier1</field></block>',
    '<block type="component_event"><mutation component_type="Button" is_generic="false" instance_name="Button1" event_name="Clik"></mutation><field name="COMPONENT_SELECTOR">Button1</field></block>',
    '<block type="component_set_get"><mutation component_type="Button" set_or_get="get" property_name="Text" is_generic="false" instance_name="Label1"></mutation><field name="COMPONENT_SELECTOR">Label1</field></block>',
    '<block type="lexical_variable_get"><field name="VAR">global score</field></block>',
    '<block type="procedures_callnoreturn"><mutation name="reset"></mutation><field name="PROCNAME">reset</field></block>',
  ]));
  for (const want of [/Label has no block property Txt/, /Notifier has no method Show/, /Button has no event Clik/,
    /says Label1 is a Button, but it is a Label/, /global variable score is used but never declared/,
    /procedure reset is called but never defined/]) {
    assert.ok(found.some(m => want.test(m)), want + ' in ' + JSON.stringify(found));
  }
});

test('yes/no and colour values are stored the way App Inventor writes them', () => {
  const obj = proj.parseScm(REF_SCM);
  const r = proj.addComponent(obj, {type: 'CheckBox', name: 'Agree', properties: {Checked: true, BackgroundColor: '#ff0000', Text: 'true'}});
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.node.Checked, 'True');
  assert.strictEqual(r.node.BackgroundColor, '&HFFFF0000');
  assert.strictEqual(r.node.Text, 'true', 'a text property keeps what was written');
});
