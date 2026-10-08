'use strict';

// Reads and edits App Inventor project files for the AI helper: designer files (.scm, JSON inside a
// "#|" wrapper), blocks files (.bky, Blockly XML), the component reference that App Inventor builds
// (simple_components.json), and a checker for a whole project. Everything here works on text in memory;
// nothing is written to a project from this file. The helper's changes are proposals that a person
// applies (see ai.js).

const crypto = require('crypto');
const fs = require('fs');

const COMPONENTS_FILE = process.env.AI_COMPONENTS_JSON ||
  '/opt/appinventor/war/WEB-INF/classes/com/google/appinventor/simple_components.json';
const CONTAINER_TYPES = /Arrangement|Form$|^Screen/;
const NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,40}$/;

// ---- the component reference ----

let componentCache = null;

// Components App Inventor knows, keyed by name: version, category, properties, block properties,
// methods and events. Read once from the file App Inventor builds with itself.
function components(file = COMPONENTS_FILE) {
  if (componentCache) return componentCache;
  const map = new Map();
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    list = [];
  }
  for (const c of list) {
    if (!c || !c.name) continue;
    map.set(c.name, {
      name: c.name,
      version: String(c.version || '1'),
      category: c.categoryString || '',
      help: String(c.helpString || '').replace(/<[^>]*>/g, '').slice(0, 240),
      properties: (c.properties || []).map(p => ({name: p.name, type: p.editorType || '', default: p.defaultValue || ''})),
      blockProperties: (c.blockProperties || []).map(p => ({name: p.name, rw: p.rw, type: p.type, description: String(p.description || '').slice(0, 140)})),
      methods: (c.methods || []).map(m => ({name: m.name, description: String(m.description || '').slice(0, 140)})),
      events: (c.events || []).map(e => ({name: e.name, description: String(e.description || '').slice(0, 140)})),
    });
  }
  componentCache = map;
  return map;
}

// Test hook: use a different reference file.
function setComponentsFile(file) {
  componentCache = null;
  return components(file);
}

// ---- random ids ----

// App Inventor component ids are numbers; Blockly block ids are short random strings.
const newUuid = () => String(crypto.randomInt(1, 2147483647));
const blockId = () => crypto.randomBytes(10).toString('hex');

// ---- designer files (.scm) ----

const SCM_RE = /#\|\s*\r?\n\$JSON\s*\r?\n([\s\S]*?)\r?\n\|#/;

function parseScm(text) {
  const m = SCM_RE.exec(String(text || ''));
  if (!m) throw new Error('this is not a designer (.scm) file');
  const obj = JSON.parse(m[1]);
  if (!obj || !obj.Properties || !obj.Properties.$Name) throw new Error('the designer file has no screen');
  return obj;
}

function writeScm(obj) {
  return '#|\n$JSON\n' + JSON.stringify(obj) + '\n|#\n';
}

// Every component node of a screen, with its parent node (the screen node for top-level ones).
function walk(node, fn, parent = null) {
  for (const child of node.$Components || []) {
    fn(child, node);
    walk(child, fn, node);
  }
}

function findNode(obj, name) {
  if (obj.Properties.$Name === name) return {node: obj.Properties, parent: null};
  let found = null;
  walk(obj.Properties, (node, parent) => {
    if (!found && node.$Name === name) found = {node, parent};
  });
  return found;
}

function componentNames(obj) {
  const names = [obj.Properties.$Name];
  walk(obj.Properties, node => names.push(node.$Name));
  return names;
}

// The helper edits a screen's designer file as data. Each function returns {ok: true, ...} or {error}.
function addComponent(obj, {type, name, parent, properties}) {
  const info = components().get(type);
  if (!info || type === 'Form') return {error: 'unknown component type "' + type + '". Look it up with component_info.'};
  if (!NAME_RE.test(name || '')) return {error: 'component names are letters, digits and underscores, starting with a letter'};
  if (componentNames(obj).includes(name)) return {error: 'a component named ' + name + ' already exists on this screen'};
  const holder = parent ? findNode(obj, parent) : {node: obj.Properties};
  if (!holder) return {error: 'there is no component named ' + parent + ' on this screen'};
  const holderType = holder.node.$Type || 'Form';
  if (parent && !CONTAINER_TYPES.test(holderType)) return {error: parent + ' is a ' + holderType + ', which cannot hold other components'};
  const node = {$Name: name, $Type: type, $Version: info.version, Uuid: newUuid()};
  const set = [];
  for (const [prop, value] of Object.entries(properties || {})) {
    const r = setValue(info, node, prop, value);
    if (r.error) return r;
    set.push(prop);
  }
  if (!holder.node.$Components) holder.node.$Components = [];
  holder.node.$Components.push(node);
  return {ok: true, node, set};
}

// Checks a property against the component reference and stores its text value.
function setValue(info, node, prop, value) {
  const known = info.properties.map(p => p.name);
  if (!known.includes(prop) && !(info.name === 'Form' && /^[A-Z]/.test(prop))) {
    return {error: info.name + ' has no designer property "' + prop + '". Its properties are: ' + known.slice(0, 40).join(', ')};
  }
  node[prop] = typeof value === 'string' ? value : String(value);
  return {ok: true};
}

function setProperty(obj, component, prop, value) {
  const found = findNode(obj, component);
  if (!found) return {error: 'there is no component named ' + component + ' on this screen'};
  const type = found.node.$Type || 'Form';
  const info = components().get(type);
  if (!info) return {error: 'unknown component type ' + type};
  return setValue(info, found.node, prop, value);
}

function removeComponent(obj, component) {
  if (component === obj.Properties.$Name) return {error: 'the screen itself cannot be removed this way'};
  const found = findNode(obj, component);
  if (!found || !found.parent) return {error: 'there is no component named ' + component + ' on this screen'};
  const list = found.parent.$Components || [];
  const index = list.indexOf(found.node);
  const removedNames = [];
  walk(found.node, node => removedNames.push(node.$Name));
  list.splice(index, 1);
  return {ok: true, removed: [component, ...removedNames]};
}

function renameComponent(obj, oldName, newName) {
  if (!NAME_RE.test(newName || '')) return {error: 'component names are letters, digits and underscores, starting with a letter'};
  if (componentNames(obj).includes(newName)) return {error: 'a component named ' + newName + ' already exists'};
  const found = findNode(obj, oldName);
  if (!found) return {error: 'there is no component named ' + oldName + ' on this screen'};
  found.node.$Name = newName;
  return {ok: true};
}

// A short outline of a screen: each component with its type and the properties people care about.
const SHOWN = ['Text', 'Title', 'BackgroundColor', 'Width', 'Height', 'Visible', 'Image', 'AppName'];
function outline(obj) {
  const lines = [];
  const show = node => {
    const bits = SHOWN.filter(k => node[k] !== undefined && node[k] !== '').map(k => k + '=' + JSON.stringify(String(node[k]).slice(0, 40)));
    return bits.length ? ' ' + bits.join(' ') : '';
  };
  lines.push(obj.Properties.$Name + ' (' + (obj.Properties.$Type || 'Form') + ')' + show(obj.Properties));
  const visit = (node, depth) => {
    for (const child of node.$Components || []) {
      lines.push('  '.repeat(depth) + '- ' + child.$Name + ' (' + child.$Type + ')' + show(child));
      visit(child, depth + 1);
    }
  };
  visit(obj.Properties, 1);
  return lines.join('\n');
}

// A new screen: the designer file and the blocks file App Inventor expects.
function newScreen(name, appName) {
  const form = components().get('Form');
  const obj = {authURL: [], YaVersion: '237', Source: 'Form', Properties: {
    $Name: name, $Type: 'Form', $Version: form ? form.version : '32', AppName: appName || name,
    Title: name, Uuid: '0',
  }};
  return {scm: writeScm(obj), bky: emptyBky()};
}

// ---- blocks files (.bky): a small XML reader that knows where each element starts and ends ----

const ATTR_RE = /([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

function unescapeXml(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

// Reads an XML document into a tree. Each element has its tag, attributes, children, and the offsets of
// its text in the source (start to end). Throws if the document is not well formed.
function parseXml(text) {
  const src = String(text || '');
  const root = {tag: '#document', attrs: {}, children: [], start: 0, end: src.length};
  const stack = [root];
  // The attributes of a tag cannot hold < or > (XML does not allow them there), so each match stops at the
  // next tag. The earlier pattern could take cubic time on a long run of spaces inside a tag, which froze
  // the whole hub while it checked a project.
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)(?=[\s/>])([^<>]*?)(\/?)>/g;
  let m;
  let last = 0;
  while ((m = re.exec(src))) {
    const between = src.slice(last, m.index);
    if (between.trim() && stack.length === 1) throw new Error('text outside the root element');
    last = re.lastIndex;
    if (m[1]) {                                    // closing tag
      const open = stack.pop();
      if (!open || open.tag !== m[1]) throw new Error('</' + m[1] + '> does not match <' + (open ? open.tag : '') + '>');
      open.end = re.lastIndex;
      open.text = open.children.length ? '' : unescapeXml(src.slice(open.innerStart, m.index));
    } else if (m[2]) {                             // opening or self-closing tag
      const attrs = {};
      let a;
      ATTR_RE.lastIndex = 0;
      while ((a = ATTR_RE.exec(m[3] || ''))) attrs[a[1]] = unescapeXml(a[3] !== undefined ? a[3] : a[4]);
      const el = {tag: m[2], attrs, children: [], start: m.index, end: re.lastIndex, text: '', innerStart: re.lastIndex};
      stack[stack.length - 1].children.push(el);
      if (!m[4]) stack.push(el);
      else el.end = re.lastIndex;
    }
  }
  if (stack.length !== 1) throw new Error('<' + stack[stack.length - 1].tag + '> is never closed');
  if (src.slice(last).trim() && !/^\s*$/.test(src.slice(last))) throw new Error('text after the root element');
  if (!root.children.length) throw new Error('the blocks file has no root element');
  return root;
}

function emptyBky() {
  return '<xml xmlns="https://developers.google.com/blockly/xml"><yacodeblocks xmlns="https://appinventor.mit.edu/ns/project/" ya-version="237" language-version="39"></yacodeblocks></xml>\n';
}

function blocksRoot(text) {
  const doc = parseXml(text);
  return doc.children[0];
}

// The top-level blocks of a blocks file, as text the helper can read.
function bkyOutline(text) {
  const root = blocksRoot(text);
  const lines = [];
  for (const b of root.children) {
    if (b.tag !== 'block') continue;
    const mut = (b.children.find(c => c.tag === 'mutation') || {attrs: {}}).attrs;
    const fields = b.children.filter(c => c.tag === 'field').map(f => f.attrs.name + '=' + JSON.stringify(f.text || '')).join(' ');
    let label = b.attrs.type;
    if (b.attrs.type === 'component_event') label = 'when ' + mut.instance_name + '.' + mut.event_name;
    lines.push('- ' + label + (fields ? ' ' + fields : '') + (b.attrs.disabled === 'true' ? ' (disabled)' : ''));
  }
  return lines.length ? lines.join('\n') : '(no blocks)';
}

// Events handled on a screen: component name, event name, and where the handler sits in the text.
function eventHandlers(text) {
  const root = blocksRoot(text);
  const out = [];
  for (const b of root.children) {
    if (b.tag !== 'block' || b.attrs.type !== 'component_event') continue;
    const mut = (b.children.find(c => c.tag === 'mutation') || {attrs: {}}).attrs;
    out.push({component: mut.instance_name, event: mut.event_name, start: b.start, end: b.end});
  }
  return out;
}

// Gives every id inside a block a new value, so that a copied block cannot clash with one in the file.
function freshIds(xml) {
  return xml.replace(/\sid="([^"]*)"/g, () => ' id="' + blockId() + '"');
}

// Chains statement blocks with <next>, so that they run one after another.
function chain(blocks) {
  let inner = '';
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i].trim();
    inner = inner ? b.replace(/<\/block>\s*$/, '<next>' + inner + '</next></block>') : b;
  }
  return inner;
}

// Checks that a block (or a few blocks) is well formed, and returns them as one string.
function checkBlockXml(xml) {
  const src = '<wrap>' + String(xml || '').trim() + '</wrap>';
  const blocks = parseXml(src).children[0].children;
  if (!blocks.length || blocks.some(b => b.tag !== 'block')) throw new Error('the blocks must be <block> elements');
  return blocks.map(b => src.slice(b.start, b.end));
}

// Inserts a top-level block (or blocks) into a blocks file, before the project's own settings element.
function addTopBlocks(text, blockXmls) {
  const src = String(text || emptyBky());
  parseXml(src);                                    // refuse to write into a broken file
  const blocks = blockXmls.map(freshIds);
  const insert = blocks.join('\n');
  const at = src.indexOf('<yacodeblocks');
  if (at >= 0) return src.slice(0, at) + insert + '\n' + src.slice(at);
  const close = src.lastIndexOf('</xml>');
  if (close < 0) throw new Error('the blocks file has no closing </xml>');
  return src.slice(0, close) + insert + '\n' + src.slice(close);
}

// The handler block for "when <component>.<event>", whose body is the statement blocks given.
function eventHandlerXml(componentType, component, event, bodyBlocks) {
  const body = bodyBlocks && bodyBlocks.length ? '<statement name="DO">' + chain(bodyBlocks) + '</statement>' : '';
  const x = 20 + crypto.randomInt(0, 400);
  const y = 20 + crypto.randomInt(0, 400);
  return '<block type="component_event" id="' + blockId() + '" x="' + x + '" y="' + y + '">' +
    '<mutation component_type="' + escAttr(componentType) + '" is_generic="false" instance_name="' + escAttr(component) +
    '" event_name="' + escAttr(event) + '"></mutation>' +
    '<field name="COMPONENT_SELECTOR">' + escText(component) + '</field>' + body + '</block>';
}

function escAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}
function escText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Removes one top-level event handler from a blocks file.
function removeEventHandler(text, component, event) {
  const src = String(text);
  const hit = eventHandlers(src).find(h => h.component === component && h.event === event);
  if (!hit) return {error: 'there is no handler for ' + component + '.' + event};
  return {ok: true, text: src.slice(0, hit.start) + src.slice(hit.end).replace(/^\n/, '')};
}

// Renames a component in a blocks file (the handler's own name and the field that shows it).
function renameInBlocks(text, oldName, newName) {
  let out = String(text).split('instance_name="' + oldName + '"').join('instance_name="' + newName + '"');
  out = out.split('<field name="COMPONENT_SELECTOR">' + oldName + '</field>').join('<field name="COMPONENT_SELECTOR">' + newName + '</field>');
  return out;
}

// ---- checking a whole project ----

// Problems in a project: files that do not parse, names used in blocks that do not exist, duplicate
// names, unknown component types, and screens with one file but not the other. files: {path: text}.
function checkProject(files) {
  const problems = [];
  const add = (level, file, message) => problems.push({level, file, message});
  const screens = new Map();
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('.scm')) continue;
    const screen = path.replace(/\.scm$/, '');
    try {
      const obj = parseScm(text);
      screens.set(screen, obj);
      const seen = new Set();
      walk(obj.Properties, node => {
        if (!components().has(node.$Type)) add('error', path, node.$Name + ' has an unknown type ' + node.$Type);
        if (seen.has(node.$Name)) add('error', path, 'two components are named ' + node.$Name);
        seen.add(node.$Name);
      });
    } catch (e) {
      add('error', path, 'the designer file does not read: ' + e.message);
    }
  }
  for (const [path, text] of Object.entries(files)) {
    if (!path.endsWith('.bky')) continue;
    const screen = path.replace(/\.bky$/, '');
    const obj = screens.get(screen);
    let names = [];
    if (obj) names = componentNames(obj);
    try {
      const handlers = eventHandlers(text);
      for (const h of handlers) {
        if (!names.includes(h.component)) add('error', path, 'a handler is for ' + h.component + ', which is not on this screen');
      }
      const seenHandlers = new Set();
      for (const h of handlers) {
        const key = h.component + '.' + h.event;
        if (seenHandlers.has(key)) add('error', path, 'two handlers for ' + key);
        seenHandlers.add(key);
      }
      for (const m of String(text).matchAll(/<field name="COMPONENT_SELECTOR">([^<]*)<\/field>/g)) {
        if (obj && !names.includes(m[1])) add('error', path, 'a block uses ' + m[1] + ', which is not on this screen');
      }
    } catch (e) {
      add('error', path, 'the blocks file does not read: ' + e.message);
    }
  }
  for (const screen of screens.keys()) {
    if (!files[screen + '.bky']) add('warning', screen + '.scm', 'this screen has no blocks file');
  }
  const props = files['youngandroidproject/project.properties'];
  if (props === undefined) add('warning', 'youngandroidproject/project.properties', 'the project settings file is missing');
  else if (!/^main\s*=/m.test(props)) add('warning', 'youngandroidproject/project.properties', 'no main screen is set');
  return problems;
}

module.exports = {
  components, setComponentsFile, newUuid, blockId, parseScm, writeScm, findNode, componentNames,
  addComponent, setProperty, removeComponent, renameComponent, outline, newScreen,
  parseXml, bkyOutline, eventHandlers, checkBlockXml, addTopBlocks, eventHandlerXml, removeEventHandler,
  renameInBlocks, checkProject, NAME_RE, emptyBky, freshIds,
};
