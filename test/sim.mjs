// test/sim.mjs — simulated IPLIN module + the real plugin, driven through Homebridge's API.
// Run after `npm run build`, or via `npm run test:sim`.
//
// The host is pinned to 127.0.0.1:8099 on purpose, so the real module at
// 192.168.5.40 is never touched.
import http from 'node:http';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';
import { Nexus21Platform } from '../dist/platform.js';

const TRAVEL = 3000, MEM = { MEM1: 40 };
const lift = { pos: 0, cmd: null, target: null, rest: 'DOWN', ext: '', errors: [] };
const cmdLog = [];
const tick = setInterval(() => {
  if (!lift.cmd) return;
  const step = (100 * 50) / TRAVEL;
  lift.pos = lift.pos < lift.target ? Math.min(lift.target, lift.pos + step) : Math.max(lift.target, lift.pos - step);
  if (lift.pos === lift.target) { lift.rest = lift.cmd; lift.cmd = null; }
}, 50);
function apply(cmd, external = false) {
  cmdLog.push(`${external ? 'RF ' : ''}${cmd}@${lift.pos.toFixed(0)}${lift.cmd ? `(moving ${lift.cmd})` : ''}`);
  if (lift.cmd && lift.cmd !== cmd) { lift.cmd = null; lift.rest = 'STOPPED'; return; } // "stop all others"
  if (lift.cmd === cmd) return;                                                         // ASSUMPTION: same cmd continues
  lift.cmd = cmd; if (external) lift.ext = cmd;
  lift.target = cmd === 'UP' ? 100 : cmd === 'DOWN' ? 0 : MEM[cmd];
}
// ASSUMPTION: after a mid-travel stop the sim reports VERTICAL "STOPPED" (real firmware unknown, see CLAUDE.md §9)
const status = () => ({ STATUS: lift.errors.length ? 'ERROR' : 'OK', VERTICAL: lift.cmd ? 'MOVING' : lift.rest, EXTCMD: lift.ext, DESCRIPTION: lift.errors });
// When true the sim drops every connection, reproducing the mid-travel HTTP
// dropout observed on the real module on 2026-09-15 (see CLAUDE.md §8).
let blackout = false;
const srv = http.createServer((req, res) => {
  if (blackout) { req.socket.destroy(); return; }
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/status') return res.end(JSON.stringify(status()));
    if (req.url === '/api/command') { apply(JSON.parse(body).COMMAND); return res.end('{"STATUS":"OK","DESCRIPTION":[]}'); }
    res.statusCode = 404; res.end('{}');
  });
}).listen(8099);

const api = new HomebridgeAPI();
const mk = (lvl) => (...a) => lvl !== 'debug' && console.log(`  [hb ${lvl}]`, ...a);
const log = Object.assign(mk('info'), { info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug'), success: mk('info') });
let acc;
api.on('registerPlatformAccessories', (a) => (acc = a[0]));
const platform = new Nexus21Platform(log, { platform: 'Nexus21', discover: false, lifts: [{
  name: 'TV', host: '127.0.0.1', port: 8099, travelTimeSeconds: 3, partialPositioning: true,
  pollIntervalSeconds: 2, movingPollIntervalMs: 250, memoryPresets: [{ slot: 1, name: 'Home', position: 40 }],
}] }, api);
api.emit('didFinishLaunching');

const { Service: S, Characteristic: C } = api.hap;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cover = () => acc.getService(S.WindowCovering);
const val = (ch) => cover().getCharacteristic(ch).value;
const show = (label) => console.log(`${label.padEnd(34)} HK cur=${val(C.CurrentPosition)} tgt=${val(C.TargetPosition)} state=${val(C.PositionState)} | lift pos=${lift.pos.toFixed(0)} ${lift.cmd ?? lift.rest}`);
const set = (ch, v) => cover().getCharacteristic(ch).handleSetRequest(v);

await sleep(600); show('start');
await set(C.TargetPosition, 100); await sleep(1500); show('extending (1.5s)');
await sleep(2500); show('extended');
await set(C.TargetPosition, 0); await sleep(1000); show('retracting (1s)');
await set(C.HoldPosition, true); await sleep(800); show('after HoldPosition');
await set(C.TargetPosition, 20); await sleep(3000); show('partial → 20');
await set(C.TargetPosition, 100); await sleep(700); show('extending from 20');
await set(C.TargetPosition, 0); await sleep(1500); show('reversed → retracting');
await sleep(2500); show('retracted');
apply('UP', true); await sleep(1500); show('RF remote UP (1.5s)');
await sleep(2500); show('RF remote done');
const sw = acc.getServiceById(S.Switch, 'mem-1');
await sw.getCharacteristic(C.On).handleSetRequest(true); await sleep(3500);
show(`MEM1 (switch on=${sw.getCharacteristic(C.On).value})`);
lift.errors = [502]; await sleep(2500);
lift.errors = []; await sleep(2500);
// ── Mid-travel HTTP dropout ─────────────────────────────────────────
// The plugin must keep tracking the move instead of settling at a frozen
// position and reporting "No Response" on the first failed poll.
await set(C.TargetPosition, 0); await sleep(3500);
console.log('\n--- mid-travel HTTP dropout ---');
await set(C.TargetPosition, 100); await sleep(800);
const beforeBlackout = val(C.CurrentPosition);
blackout = true;
await sleep(1200);
const duringState = val(C.PositionState), duringPos = val(C.CurrentPosition);
show(`during blackout (1.2s)`);
blackout = false;
await sleep(2600); show('after recovery');
const recoveredPos = val(C.CurrentPosition), recoveredState = val(C.PositionState);

console.log('\nlift command log:', cmdLog.join(' | '));

// Assertions on the command log — these are the invariants the stop/reverse
// semantics depend on (CLAUDE.md §3.3).
const joined = cmdLog.join(' | ');
const checks = [
  ['stop while moving DOWN sends UP', /UP@\d+\(moving DOWN\)/.test(joined)],
  ['reversal sends the same command twice', /DOWN@(\d+)\(moving UP\) \| DOWN@\1/.test(joined)],
  ['no command is sent while idle at rest', !/UP@100(?!\()/.test(joined)],
  ['keeps tracking through an HTTP dropout', duringState === 1],
  ['position still advances while dark', duringPos > beforeBlackout],
  ['settles correctly once HTTP returns', recoveredPos === 100 && recoveredState === 2],
];
let failed = 0;
for (const [label, pass] of checks) {
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${label}`);
  if (!pass) failed++;
}

platform['lifts'].forEach((l) => l.shutdown()); clearInterval(tick); srv.close();
process.exit(failed === 0 ? 0 : 1);
