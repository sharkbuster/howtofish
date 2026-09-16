// Headless test harness for howtofish/index.html
// Injects a probe into the game IIFE (in memory only; the shipped file is untouched).
const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync(process.argv[2], 'utf8');
let js = /<script>([\s\S]*?)<\/script>/.exec(html)[1];

const cut = js.lastIndexOf('})();');
if (cut < 0) { console.error('FAIL: no IIFE end'); process.exit(1); }
js = js.slice(0, cut) + `
  globalThis.__T = {
    get G() { return G; },
    get player() { return player; },
    get fish() { return fish; },
    FISH: FISH, WEAPONS: WEAPONS, SHOP: SHOP, ISLANDS: ISLANDS,
    attack: attack, tryBuy: tryBuy, spawnBoss: spawnBoss,
    landFish: landFish, hurtPlayer: hurtPlayer, resetFishing: resetFishing
  };
` + js.slice(cut);

/* ------------------------------------------------------------ dom stub */

let drawCalls = 0;
const ctx = new Proxy({
  createRadialGradient: () => ({ addColorStop() {} }),
  createLinearGradient: () => ({ addColorStop() {} }),
  measureText: () => ({ width: 10 }),
}, {
  get(t, k) { return (k in t) ? t[k] : function () { drawCalls++; }; },
  set(t, k, v) { t[k] = v; return true; },
});

const handlers = new Map();
const win = {
  innerWidth: 1024, innerHeight: 576, devicePixelRatio: 1,
  addEventListener: (type, fn) => {
    if (!handlers.has(type)) handlers.set(type, []);
    handlers.get(type).push(fn);
  },
};
const store = new Map();
const sandbox = {
  window: win,
  document: { getElementById: () => ({ style: {}, width: 0, height: 0, getContext: () => ctx }) },
  localStorage: {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  },
  Math, JSON, Date, console, setTimeout, clearTimeout,
};
const queue = [];
sandbox.requestAnimationFrame = (cb) => { queue.push(cb); return 1; };

vm.createContext(sandbox);
try {
  vm.runInContext(js, sandbox, { filename: 'howtofish.js' });
} catch (e) {
  console.error('FAIL: threw during init\n' + (e && e.stack || e));
  process.exit(1);
}

const T = sandbox.__T;
if (!T) { console.error('FAIL: probe injection failed'); process.exit(1); }
const P = T.player;

let t = 0;
const step = 1000 / 60;
function run(n) {
  for (let i = 0; i < n; i++) {
    t += step;
    const cbs = queue.splice(0, queue.length);
    if (cbs.length === 0) throw new Error('rAF loop stalled');
    for (const cb of cbs) cb(t);
  }
}
function fire(type, ev) { (handlers.get(type) || []).forEach((fn) => fn.call(win, ev)); }
function key(k, down) { fire(down ? 'keydown' : 'keyup', { key: k, preventDefault() {} }); }
function click(x, y) { fire('pointerdown', { clientX: x, clientY: y }); }
function move(x, y) { fire('pointermove', { clientX: x, clientY: y }); }

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok    ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra !== undefined ? '   -> got: ' + extra : '')); }
}
function section(s) { console.log('\n' + s); }

/* ================================================================ tests */

section('boot + menu');
run(30);
ok('menu renders', drawCalls > 0);
ok('starts on island 1', T.G.island.idx === 0, T.G.island.idx);
ok('player starts with 3 hp', P.hp === 3 && P.maxHp === 3);
ok('player starts broke', P.money === 0, P.money);
ok('starts with fists', P.weapon === 0);

click(400, 100);
run(5);
ok('click starts the game', T.G.mode === 'playing', T.G.mode);

/* -------------------------------------------------------------- fishing */
section('full fishing loop: cast -> bite -> reel -> land');
{
  T.resetFishing();
  move(700, 380);

  // hold space to charge, then release
  key(' ', true);
  run(70);
  ok('charge builds while holding', T.fish.power > 0.9, T.fish.power.toFixed(2));
  ok('state is charging', T.fish.state === 'charging', T.fish.state);

  key(' ', false);
  run(1);
  ok('release launches the bobber', T.fish.state === 'flying', T.fish.state);
  ok('bobber flies right', T.fish.bobber.vx > 500, T.fish.bobber.vx.toFixed(0));

  let guard = 0;
  while (T.fish.state === 'flying' && guard++ < 300) run(1);
  ok('bobber lands in the water', T.fish.state === 'waiting', T.fish.state);
  ok('bobber landed past the shoreline', T.fish.bobber.x > 468, T.fish.bobber.x.toFixed(0));

  guard = 0;
  while (T.fish.state === 'waiting' && guard++ < 400) run(1);
  ok('a fish bites', T.fish.state === 'bite', T.fish.state);
  ok('bite picked a fish type', !!T.fish.target, T.fish.target && T.fish.target.id);

  // reel: hold, release before the line snaps
  guard = 0;
  while ((T.fish.state === 'reeling' || T.fish.state === 'bite') && guard++ < 4000) {
    key(' ', T.fish.tension < 0.72);
    run(1);
  }
  ok('reeling finished (landed or snapped)', T.fish.state === 'idle', T.fish.state);
  ok('a fish is now on the beach', T.G.island.fish.length === 1, T.G.island.fish.length);

  const o = T.G.island.fish[0];
  ok('landed fish is alive, not KO', o && !o.ko);
  ok('landed fish flies toward the beach', o && o.vx < 0, o && o.vx.toFixed(0));
}

section('line snaps when tension is maxed');
{
  // force a reeling state with a big fish and never release
  T.resetFishing();
  T.fish.state = 'reeling';
  T.fish.target = T.FISH[5];
  T.fish.tension = 0;
  T.fish.progress = 0;
  key(' ', true);
  let g = 0;
  while (T.fish.state === 'reeling' && g++ < 600) run(1);
  ok('line snaps at max tension', T.fish.state === 'idle', T.fish.state);
  ok('snapping clears the target', T.fish.target === null);
  key(' ', false);
  run(2);
}

section('fish escapes back into the sea');
{
  T.G.island.fish.length = 0;
  const f = T.FISH[0];
  T.G.island.fish.push({
    def: f, x: 460, y: 380, vx: 200, vy: 0, hp: 1, maxHp: 1, size: f.size,
    onGround: true, ko: false, flash: 0, spin: 0, rot: 0, koT: 0, hopCd: 0, dir: 1, dazed: 0,
  });
  let g = 0;
  while (T.G.island.fish.length > 0 && g++ < 400) run(1);
  ok('fish that reaches the sea is gone', T.G.island.fish.length === 0);
}

/* ------------------------------------------------------------- combat */
section('combat: beat a fish unconscious and sell it');
{
  T.G.island.fish.length = 0;
  const f = T.FISH[2];                       // 石斑, 3 hp
  P.x = 200; P.money = 0;
  T.G.island.fish.push({
    def: f, x: 260, y: 380, vx: 0, vy: 0, hp: f.hp, maxHp: f.hp, size: f.size,
    onGround: true, ko: false, flash: 0, spin: 0, rot: 0, koT: 0, hopCd: 99, dir: 1, dazed: 0,
  });
  const o = T.G.island.fish[0];
  move(o.x, o.y);

  let hits = 0;
  while (!o.ko && hits++ < 60) { T.attack(); run(20); }
  ok('melee KOs the fish', o.ko === true, 'hits=' + hits + ' hp=' + o.hp);
  ok('KO needs several punches', hits >= f.hp, hits);

  const before = P.money;
  P.x = o.x;                                 // walk onto the KO fish
  run(20);
  ok('walking over a KO fish sells it', P.money === before + f.value, P.money - before);
  ok('sold fish is removed', T.G.island.fish.indexOf(o) === -1);
  ok('island catch counter went up', T.G.island.caught >= 1, T.G.island.caught);
}

section('drops do not sell until knocked out');
{
  T.G.island.fish.length = 0;
  const f = T.FISH[0];
  P.money = 0;
  T.G.island.fish.push({
    def: f, x: P.x, y: 380, vx: 0, vy: 0, hp: f.hp, maxHp: f.hp, size: f.size,
    onGround: true, ko: false, flash: 0, spin: 0, rot: 0, koT: 0, hopCd: 99, dir: 1, dazed: 0,
  });
  run(30);
  ok('a live fish on you earns nothing', P.money === 0, P.money);
  T.G.island.fish.length = 0;
}

/* -------------------------------------------------------------- ranged */
section('guns: bullets damage, pierce, and jam');
{
  T.G.island.fish.length = 0;
  P.weapon = 3;                              // 手枪
  const f = T.FISH[3];                       // 疯鲈 5hp
  T.G.island.fish.push({
    def: f, x: 320, y: 392 - f.size * 0.5, vx: 0, vy: 0, hp: f.hp, maxHp: f.hp, size: f.size,
    onGround: true, ko: false, flash: 0, spin: 0, rot: 0, koT: 0, hopCd: 99, dir: 1, dazed: 0,
  });
  const o = T.G.island.fish[0];
  P.x = 200;
  move(o.x, o.y);

  T.attack();
  ok('gun spawns a bullet', T.G.island.bullets.length === 1, T.G.island.bullets.length);
  let g = 0;
  while (!o.ko && g++ < 600) { move(o.x, o.y); T.attack(); run(1); }
  ok('bullets can KO a fish at range', o.ko === true, 'hp=' + o.hp);

  // pierce
  T.G.island.fish.length = 0;
  P.weapon = 5;                              // 狙击枪, pierce
  for (let i = 0; i < 3; i++) {
    const ff = T.FISH[0];
    T.G.island.fish.push({
      def: ff, x: 300 + i * 40, y: 392 - ff.size * 0.5, vx: 0, vy: 0, hp: 1, maxHp: 1, size: ff.size,
      onGround: true, ko: false, flash: 0, spin: 0, rot: 0, koT: 0, hopCd: 99, dir: 1, dazed: 0,
    });
  }
  P.x = 200;
  move(400, 392 - T.FISH[0].size * 0.5);
  P.weapon = 3; P.attackCd = 0;             // 手枪（不穿透）
  T.attack();
  run(60);
  const oneHit = T.G.island.fish.filter((x) => x.ko).length;
  ok('non-piercing shot hits only one fish', oneHit === 1, oneHit);

  for (const x of T.G.island.fish) { x.ko = false; x.hp = 1; }
  P.weapon = 5; P.attackCd = 0;             // 狙击枪（穿透）
  T.attack();
  run(60);
  const kos = T.G.island.fish.filter((x) => x.ko).length;
  ok('piercing shot hits multiple fish', kos >= 2, kos);

  // jam
  T.G.jammed = 0;
  P.attackCd = 0;
  P.weapon = 4;                              // 霰弹枪 jam 7%
  let jammed = false;
  for (let i = 0; i < 400 && !jammed; i++) { P.attackCd = 0; T.attack(); if (T.G.jammed > 0) jammed = true; }
  ok('guns can jam', jammed);
  key('r', true); run(2); key('r', false);
  ok('R clears the jam', T.G.jammed === 0, T.G.jammed);

  P.weapon = 0;
  T.G.island.fish.length = 0;
  T.G.island.bullets.length = 0;
}

/* --------------------------------------------------------------- shop */
section('shop purchases');
{
  const cases = [
    { idx: 1, cost: T.SHOP[0].cost },
    { idx: 2, cost: T.SHOP[1].cost },
    { idx: 3, cost: T.SHOP[2].cost },
    { idx: 4, cost: T.SHOP[3].cost },
    { idx: 5, cost: T.SHOP[4].cost },
  ];
  for (const c of cases) {
    P.weapon = 0; P.money = c.cost - 1;
    T.tryBuy(T.SHOP[c.idx - 1]);
    ok('cannot afford ' + T.WEAPONS[c.idx].name, P.weapon === 0, P.weapon);
    P.money = c.cost;
    T.tryBuy(T.SHOP[c.idx - 1]);
    ok('buys ' + T.WEAPONS[c.idx].name, P.weapon === c.idx, P.weapon);
    ok('money deducted for ' + T.WEAPONS[c.idx].name, P.money === 0, P.money);
  }

  P.rodLevel = 0; P.money = 99999;
  for (let i = 0; i < 4; i++) T.tryBuy(T.SHOP[5]);
  ok('rod caps at level 3', P.rodLevel === 3, P.rodLevel);

  P.maxHp = 3; P.money = 99999;
  for (let i = 0; i < 6; i++) T.tryBuy(T.SHOP[6]);
  ok('max hp caps at 6', P.maxHp === 6, P.maxHp);
  ok('buying max hp heals to full', P.hp === P.maxHp, P.hp);

  P.weapon = 0; P.rodLevel = 0; P.maxHp = 3; P.hp = 3; P.money = 0;
}

/* -------------------------------------------------------------- seagull */
section('seagull steals a knocked-out fish');
{
  T.G.island.fish.length = 0;
  T.G.island.gulls.length = 0;
  T.G.island.gullCd = 0;
  const f = T.FISH[3];
  T.G.island.fish.push({
    def: f, x: 300, y: 380, vx: 0, vy: 0, hp: 0, maxHp: f.hp, size: f.size,
    onGround: true, ko: true, flash: 0, spin: 0, rot: 0, koT: 0, hopCd: 99, dir: 1, dazed: 0,
  });
  run(2);
  ok('gull spawns', T.G.island.gulls.length > 0, T.G.island.gulls.length);

  let g = 0, stolen = false;
  while (g++ < 900 && !stolen) {
    run(1);
    stolen = T.G.island.gulls.some((gu) => gu.carry) && T.G.island.fish.length === 0;
  }
  ok('gull grabs the KO fish', stolen, 'fish=' + T.G.island.fish.length);

  // shoot it down -> fish drops back
  const gu = T.G.island.gulls.find((x) => x.carry);
  if (gu) {
    P.weapon = 5; P.attackCd = 0;
    move(gu.x, gu.y);
    let down = 0;
    while (T.G.island.gulls.indexOf(gu) !== -1 && down++ < 200) {
      P.attackCd = 0; T.attack(); run(3);
    }
    ok('shooting the gull takes it down', T.G.island.gulls.indexOf(gu) === -1);
    ok('dropped fish returns to the beach', T.G.island.fish.length > 0, T.G.island.fish.length);
  } else {
    ok('shooting the gull takes it down', false, 'no carrying gull');
  }
  T.G.island.gulls.length = 0;
  T.G.island.fish.length = 0;
  P.weapon = 0;
}

/* ---------------------------------------------------------------- boss */
section('boss fight + island clear');
{
  T.G.island.caught = 0;
  T.G.island.fish.length = 0;
  T.G.island.boss = null;
  T.spawnBoss();
  run(2);
  const b = T.G.island.boss;
  ok('boss exists', !!b);
  ok('boss has a name', b.name === '蜘蛛蟹', b.name);
  ok('boss hp from island config', b.maxHp === T.ISLANDS[0].bossHp, b.maxHp);
  ok('boss intro banner shows', T.G.island.bossIntro > 0);

  run(140);                                   // let it rise
  ok('boss finishes rising', b.spawnT <= 0, b.spawnT.toFixed(2));

  // it should attack at some point
  let attacked = false;
  for (let i = 0; i < 900 && !attacked; i++) {
    run(1);
    attacked = b.phase !== 'idle' || T.G.island.eballs.length > 0;
  }
  ok('boss runs attack patterns', attacked);

  // kill it
  P.weapon = 5;
  let n = 0;
  while (!b.dead && n++ < 400) { P.attackCd = 0; move(b.x, b.y - b.h * 0.5); T.attack(); run(3); }
  ok('boss can be killed', b.dead === true, 'hp=' + b.hp);
  ok('boss pays out', P.money > 0, P.money);
  ok('boss leaves loot fish', T.G.island.fish.length > 0, T.G.island.fish.length);
  ok('boss loot lands on the beach, not the sea',
    T.G.island.fish.every((x) => x.x < 468), T.G.island.fish.map((x) => Math.round(x.x)).join());

  run(120);
  ok('island clears after the boss dies', T.G.mode === 'islandClear', T.G.mode);
  ok('progress is saved', store.get('howtofish.save') !== undefined, store.get('howtofish.save'));
}

section('island progression');
{
  click(400, 300);
  run(3);
  ok('advances to island 2', T.G.island.idx === 1 && T.G.mode === 'playing', T.G.island.idx + '/' + T.G.mode);
  ok('island 2 has its own boss', T.ISLANDS[T.G.island.idx].boss === '大河豚');
  ok('catch counter reset', T.G.island.caught === 0, T.G.island.caught);
  ok('money carries over', P.money > 0, P.money);

  // rush island 2
  T.spawnBoss();
  run(150);
  let b = T.G.island.boss;
  P.weapon = 5;
  let n = 0;
  while (b && !b.dead && n++ < 600) { P.attackCd = 0; move(b.x, b.y - b.h * 0.5); T.attack(); run(3); }
  run(120);
  ok('island 2 clears', T.G.mode === 'islandClear', T.G.mode);

  click(400, 300);
  run(3);
  ok('advances to island 3', T.G.island.idx === 2, T.G.island.idx);

  T.spawnBoss();
  run(150);
  b = T.G.island.boss;
  n = 0;
  while (b && !b.dead && n++ < 900) { P.attackCd = 0; move(b.x, b.y - b.h * 0.5); T.attack(); run(3); }
  run(120);
  ok('island 3 clears', T.G.mode === 'islandClear', T.G.mode);
  ok('save unlock is capped', JSON.parse(store.get('howtofish.save')).unlocked <= 3);

  click(400, 300);
  run(3);
  ok('no island 4 - stays on clear screen', T.G.island.idx === 2, T.G.island.idx);
}

/* ------------------------------------------------------- damage + death */
section('big fish damage + death/respawn');
{
  T.G.mode = 'playing';
  T.G.island.boss = null;
  T.G.island.fish.length = 0;
  T.G.island.eballs.length = 0;
  P.hp = 3; P.maxHp = 3; P.invuln = 0; P.alive = true;

  const f = T.FISH[5];                       // 翻车鱼 touch:1
  T.G.island.fish.push({
    def: f, x: P.x, y: 380, vx: 0, vy: 0, hp: f.hp, maxHp: f.hp, size: f.size,
    onGround: true, ko: false, flash: 0, spin: 0, rot: 0, koT: 0, hopCd: 99, dir: 1, dazed: 0,
  });
  run(2);
  ok('big fish damages on contact', P.hp === 2, P.hp);
  ok('contact grants i-frames', P.invuln > 0);

  P.hp = 1; P.invuln = 0;
  T.hurtPlayer(1, 0);
  ok('0 hp downs the player', P.alive === false, P.alive);
  ok('death counted', T.G.deaths > 0, T.G.deaths);

  let g = 0;
  while (!P.alive && g++ < 300) run(1);
  ok('player respawns', P.alive === true);
  ok('respawn restores hp', P.hp === P.maxHp, P.hp);
  ok('respawn grants i-frames', P.invuln > 0);

  T.G.island.fish.length = 0;
}

/* ------------------------------------------------------------- soak */
section('soak: 3 minutes of random play');
{
  click(400, 300);          // back to playing if needed
  run(2);
  const errs = [];
  let g = 0;
  for (let i = 0; i < 60 * 180; i++) {
    move(300 + Math.sin(i / 37) * 380, 200 + Math.cos(i / 23) * 180);
    if (i % 40 === 0) key(' ', true);
    if (i % 40 === 25) key(' ', false);
    if (i % 17 === 0) { P.attackCd = 0; T.attack(); }
    if (i % 900 === 0) key('b', true), key('b', false);
    if (i % 1500 === 0) click(500, 400);
    try { run(1); } catch (e) { errs.push(e && e.stack || String(e)); break; }
  }
  ok('no exceptions during soak', errs.length === 0, errs[0]);
  ok('still drawing', drawCalls > 0);
  ok('world state stayed sane', Number.isFinite(P.x) && Number.isFinite(P.money), P.x + '/' + P.money);
}

/* -------------------------------------------------------------- report */
console.log('\n' + '='.repeat(54));
console.log(`passed: ${pass}   failed: ${fail}`);
console.log(`draw ops: ${drawCalls.toLocaleString()}`);
process.exit(fail ? 1 : 0);
