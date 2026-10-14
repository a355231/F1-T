'use strict';

// Live sync between App Inventor pages, run in Chromium. Three pages (browser/participant.html) run the real collab.js,
// collab-extra.js and Blockly; the hub's real rooms.js sits behind a router that mirrors hub.js (browser/sim.html). The
// pages edit at random; bob loses his connection while he keeps editing; two of cy's operations are lost in transit; the
// hub's 30 s syncer runs. Two scenarios: in "normal", bob's offline edits must reach the hub after he rejoins; in "stale",
// an AI change goes in while he is offline, so those edits must be dropped rather than put back. In both, the pages must
// agree on block ids and content once the trouble is over, which is what stops them drifting apart.
// It needs Chromium: set CHROMIUM to its path. Without it the test is skipped, or fails when CI is set.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');

const SIM = path.join(__dirname, 'browser', 'sim.html');
const CHROME = [process.env.CHROMIUM, '/opt/pw-browsers/chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome'].find(p => p && fs.existsSync(p));

// The simulation's report: the text of its <pre id="out"> element.
function simulate(scenario) {
  const params = new URLSearchParams({
    page: pathToFileURL(path.resolve(__dirname, '../../../appinventor/appengine/war/static/js')).href,
    hub: pathToFileURL(path.resolve(__dirname, '..')).href,
    blockly: pathToFileURL(path.resolve(__dirname, '../../../appinventor/lib/blockly/blockly_compressed.js')).href,
    scenario,
  });
  const html = execFileSync(CHROME, ['--headless', '--no-sandbox', '--disable-gpu', '--allow-file-access-from-files',
    '--virtual-time-budget=440000', '--dump-dom', pathToFileURL(SIM).href + '?' + params], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const m = /<pre id="out">([\s\S]*?)<\/pre>/.exec(html);
  assert.ok(m, 'the simulation printed no report');
  return m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// Each checkpoint: the main client, and for each page how many blocks it has, whether its block ids, its content and its
// content with ids match the main client's, and its counters.
function parse(report) {
  const checkpoints = {};
  let current = null;
  for (const line of report.split('\n')) {
    const head = /^(at \d+s|final): main client (\S+)/.exec(line);
    if (head) {
      current = head[1];
      checkpoints[current] = {main: head[2], people: {}};
      continue;
    }
    const row = /^\s+(\w+): (\d+) blocks; same block ids as main: (true|false); same content: (true|false); same content with ids: (true|false); connected: (yes|no); (\{.*\})$/.exec(line);
    if (row && current) {
      checkpoints[current].people[row[1]] = {blocks: Number(row[2]), sameIds: row[3] === 'true',
        sameContent: row[4] === 'true', sameWithIds: row[5] === 'true', stats: JSON.parse(row[7])};
    }
  }
  return checkpoints;
}

// The checks every scenario shares: nothing threw, the lost operations happened, and the pages agree after the trouble.
function assertInStep(report) {
  assert.match(report, /lost 2/, 'the two lost operations were injected');
  assert.match(report, /page errors: none/, 'no page throws');
  const checkpoints = parse(report);
  for (const when of ['at 300s', 'final']) {
    assert.ok(checkpoints[when], 'the checkpoint ' + when + ' was reported');
    for (const who of ['ann', 'bob', 'cy']) {
      const page = checkpoints[when].people[who];
      assert.ok(page, who + ' is in the report at ' + when);
      assert.ok(page.sameIds && page.sameContent && page.sameWithIds,
        who + ' differs from the main client (' + when + '): ' + JSON.stringify(page));
    }
  }
  return checkpoints;
}

const SKIP = CHROME ? false : 'Chromium is not installed here (set CHROMIUM to its path)';
const NEEDED = CHROME ? false : (process.env.CI ? 'Chromium is needed in CI: set CHROMIUM' : false);

test('kept edits reach the hub after a reconnect, and the pages stay in step', {skip: SKIP, timeout: 180000}, () => {
  assert.ok(!NEEDED, NEEDED);
  const report = simulate('normal');
  const checkpoints = assertInStep(report);
  assert.ok(checkpoints.final.people.bob.stats.outboxSent > 0, 'bob sent the edits he made while he was offline');
  const outage = /bob outage creations: (\d+); reached the hub: (\d+)/.exec(report);
  assert.ok(outage, 'the outage creations were counted');
  assert.ok(Number(outage[1]) > 0, 'bob made a block while he was offline');
  assert.strictEqual(outage[2], outage[1], 'every block bob made offline reached the hub');
});

test('changes made while the project was changed meanwhile are dropped, not put back, and the pages stay in step', {skip: SKIP, timeout: 180000}, () => {
  assert.ok(!NEEDED, NEEDED);
  const report = simulate('stale');
  assertInStep(report);
  const outage = /bob outage creations: (\d+); reached the hub: (\d+)/.exec(report);
  assert.ok(outage && Number(outage[1]) > 0, 'bob made a block while he was offline');
  // bob's page reloads when it rejoins a project whose write count moved on (collab-extra.js joinedWrites), so the counters
  // in the report are the reloaded page's. The hub's log is what shows that the kept edits were dropped.
  assert.strictEqual(outage[2], '0', 'bob\'s offline blocks did not reach the hub: the project changed meanwhile');
});
