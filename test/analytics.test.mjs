/**
 * The anonymous statistics (#35), in plain Node: who sends, what a seed is
 * reported as, and what a batch looks like. Nothing here touches the network:
 * the sender is a function that keeps what it is given.
 */
import { ANALYTICS } from '../dist/config.js';
import { Analytics, analyticsEnv, analyticsStatus, seedProps, seedWord, uuidv7 } from '../dist/analytics.js';
import { seedOf, trackName } from '../dist/sim/track/generate.js';
import { VERSION } from '../dist/version.js';

let pass = 0;
let fail = 0;
function check(label, ok, note = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${note ? ` — ${note}` : ''}`);
  ok ? pass++ : fail++;
}

console.log('\n  who sends');
check('the live game sends as prod, the dev site as dev', analyticsEnv('nitro-carnage.helloshep.com', '') === 'prod' && analyticsEnv('dev.nitro-carnage.helloshep.com', '') === 'dev');
check('localhost, the test rig and any other host send nothing', [ 'localhost', '127.0.0.1', 'sheppio.github.io', 'example.com' ].every((h) => analyticsEnv(h, '') === null));
check('?noanalytics and Do Not Track turn the live game off', analyticsEnv('nitro-carnage.helloshep.com', '?noanalytics') === null && analyticsEnv('nitro-carnage.helloshep.com', '', { doNotTrack: true }) === null);
check('a browser driven by a test tool, or a device opted out, sends nothing even from the live game',
  analyticsEnv('nitro-carnage.helloshep.com', '', { automated: true }) === null && analyticsEnv('dev.nitro-carnage.helloshep.com', '', { device: true }) === null);
check('?analytics=force sends as test, but only on localhost', analyticsEnv('127.0.0.1', '?analytics=force') === 'test' && analyticsEnv('example.com', '?analytics=force') === null);

const live = 'nitro-carnage.helloshep.com';
const why = [analyticsStatus(live, '?noanalytics').off, analyticsStatus(live, '', { doNotTrack: true }).off, analyticsStatus(live, '', { automated: true }).off,
  analyticsStatus(live, '', { device: true }).off, analyticsStatus('example.com', '').off, analyticsStatus(live, '').off];
check('a device opted in with ?analytics=on sends despite Do Not Track, but not from another site',
  analyticsEnv(live, '', { doNotTrack: true, optedIn: true }) === 'prod' && analyticsEnv('example.com', '', { doNotTrack: true, optedIn: true }) === null);
check('switched off, it says why', why.join() === 'noanalytics,do not track,automated,device opted out,not our site,', why.join());

console.log('\n  seeds');
check('a seed is reported trimmed, in lower case, with its spaces collapsed', seedWord('  Oak   FIN ') === 'oak fin');
check('an empty box is NITRO, as the game reads it', seedWord('   ') === 'nitro' && seedProps('').seed_num === seedOf('NITRO'));
check('at most 20 characters', seedWord('x'.repeat(40)).length === 20);
check('anything with an @ is never sent', seedWord('me@example.com') === '[redacted]');
const a = seedProps('Oak  Fin'), b = seedProps(' oak fin');
check('spellings of one seed share its number and its track name', a.seed_num === b.seed_num && a.seed_num === seedOf('oak fin') && a.seed_name === trackName(seedOf('oak fin')), `${a.seed_num} · ${a.seed_name}`);

console.log('\n  batches');
const sent = [];
let clock = Date.UTC(2026, 9, 2, 12);
const stats = new Analytics('dev', 'anon-1', (url, body, beacon) => sent.push({ url, body: JSON.parse(body), beacon }), 'https://dev.nitro-carnage.helloshep.com/', () => clock);
stats.track('mode_start', { mode: 'race', track_id: 'docks', race_no: stats.raceStarted() });
check('events wait in the queue until a flush', sent.length === 0 && stats.pending.length === 1);
stats.flush();
const [first] = sent;
const ev = first?.body.batch[0];
check('a batch goes to the EU capture API with the project token', first?.url === `${ANALYTICS.host}/batch/` && first.body.api_key === ANALYTICS.token && ANALYTICS.host.includes('eu.'));
check('each event is anonymous: no person profile, an anonymous id, this visit\'s session', ev?.distinct_id === 'anon-1' && ev.properties.$process_person_profile === false && ev.properties.$session_id === stats.sessionId);
check('each event carries the version and the env', ev?.properties.version === VERSION && ev.properties.env === 'dev' && ev.properties.race_no === 1);
check('the session id is a UUIDv7', /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuidv7(clock)));
for (let i = 0; i < ANALYTICS.batch; i++) stats.track('tick');
check(`${ANALYTICS.batch} waiting events go out without waiting for the timer`, sent.length === 2 && stats.pending.length === 0);

for (let i = 0; i < ANALYTICS.maxErrors + 3; i++) stats.error(`boom ${i} ${'x'.repeat(300)}`, 'https://x/dist/main.js?v=1', 12);
stats.flush();
const errs = sent.flatMap((s) => s.body.batch).filter((e) => e.event === 'error');
check(`at most ${ANALYTICS.maxErrors} errors a visit, cut short, with only the file's name`, errs.length === ANALYTICS.maxErrors && errs[0].properties.message.length === 200 && errs[0].properties.source === 'main.js');

let left = 0;
stats.onEnd = () => left++;
stats.racesFinished = 1;
clock += 95000;
stats.end();
const last = sent[sent.length - 1];
const end = last?.body.batch.find((e) => e.event === 'session_end');
check('the visit ends by beacon, after a race still running is reported', left === 1 && last.beacon === true && end?.properties.races_started === 1 && end.properties.races_finished === 1 && end.properties.duration_s === 95);

const outcomes = [];
const told = new Analytics('dev', 'anon-2', (url, body) => (body.includes('"fail"') ? Promise.reject(new Error('blocked')) : Promise.resolve('200')));
told.onLog = (line) => outcomes.push(line);
told.track('ok');
told.flush();
await Promise.resolve();
await Promise.resolve();
const good = told.summary;
told.track('fail');
told.flush();
await Promise.resolve();
await Promise.resolve();
check('each batch reports how it went: sent, or failed (a blocker, or offline)', good === 'stats: dev · 200 · 1 sent' && told.summary === 'stats: dev · failed · 1 sent'
  && outcomes.join(' | ') === 'statistics: sent 1 events → 200 | statistics: sent 1 events → failed', `${good} / ${told.summary}`);

const off = [];
const quiet = new Analytics(null, '', () => off.push(1));
quiet.track('session_start');
quiet.end();
quiet.off = 'do not track';
check('switched off, nothing is queued and nothing is sent, and the readout says why', !quiet.enabled && quiet.pending.length === 0 && off.length === 0 && quiet.summary === 'stats: off (do not track)');

console.log(`\n  ${pass} passed, ${fail} failed\n`);
if (fail) process.exitCode = 1;
