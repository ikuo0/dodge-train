'use strict';
// Shared vocabulary: intentions, positions, bullet classes, outcomes and events.
const ACTIONS = ['左 ¼', '左 ½', '右 ¼', '右 ½', '待機 300ms', '待機 600ms', '待機 900ms'];
const POSITION = 7, BULLET = 15, HIT = 33, SAFE = 34, NO_BULLETS = 35;
const TIME_200MS = 36, MOVE_END = 37, BULLET_EXIT = 38, CONTACT = 39, WAIT_END = 40;
const W = 360, H = 560, PLAYER_Y = 513, RADIUS = 9;
const OBSERVATION_Y = H / 3;
const PLAYER_WIDTH = 20, FRONT_HALF_WIDTH = PLAYER_WIDTH * 1.5;
const OUTCOME_SECONDS = 1.5;
const HISTORY = 128;
const byId = id => document.getElementById(id);
let shotIntervalScale = 4;
class HitRateHistory {
  constructor() {
    this.frames = new Float64Array(60);
    this.cursor = 0; this.size = 0; this.clock = 0; this.pendingHits = 0;
  }
  advance(dt, hits) {
    this.clock += dt; this.pendingHits += hits;
    while (this.clock >= 10 - 1e-9) {
      this.frames[this.cursor] = this.pendingHits;
      this.cursor = (this.cursor + 1) % this.frames.length;
      this.size = Math.min(this.size + 1, this.frames.length);
      this.clock = Math.max(0, this.clock - 10); this.pendingHits = 0;
    }
  }
  rate(frameCount) {
    const count = Math.min(frameCount, this.size);
    if (!count) return this.clock > 0 ? this.pendingHits * 60 / this.clock : null;
    let hits = 0;
    for (let i = 1; i <= count; i++) hits += this.frames[(this.cursor - i + this.frames.length) % this.frames.length];
    return hits * 60 / (count * 10);
  }
}
class Arena {
  constructor(id, color) {
    this.canvas = byId(id); this.ctx = this.canvas.getContext('2d'); this.color = color;
    this.reset();
  }
  reset() {
    this.x = W / 2; this.target = this.x; this.action = 4; this.remaining = 0;
    this.bullets = []; this.hits = 0; this.pendingHits = 0; this.history = [];
    this.hitRates = new HitRateHistory();
    this.decisionRemaining = 0; this.decisionHistory = null;
    this.outbox = []; this.outboxExamples = []; this.sampleExamples = [];
    this.shots = [0.3, 0.65, 1].map(time => time * shotIntervalScale); this.flash = 0;
  }
  act(action) {
    this.action = action;
    if (action < 4) {
      const distance = W * (action % 2 ? 0.5 : 0.25);
      this.target = Math.max(RADIUS, Math.min(W - RADIUS, this.x + (action < 2 ? -distance : distance)));
      this.remaining = Math.abs(this.target - this.x) / 180;
    } else { this.target = this.x; this.remaining = (action - 3) * 0.3; }
  }
  step(dt) {
    const previousHits = this.hits;
    const oldPosition = this.positionToken(), wasMoving = this.remaining > 1e-9;
    const delta = this.target - this.x;
    this.x += Math.sign(delta) * Math.min(Math.abs(delta), 180 * dt);
    this.remaining = Math.max(0, this.remaining - dt); this.flash = Math.max(0, this.flash - dt);
    if (this.positionToken() !== oldPosition) this.record([this.positionToken()]);
    if (wasMoving && this.remaining <= 1e-9) this.record([this.action < 4 ? MOVE_END : WAIT_END]);
    for (let i = 0; i < 3; i++) {
      this.shots[i] -= dt;
      if (this.shots[i] <= 0) {
        this.shots[i] += (0.85 + Math.random() * 0.8) * shotIntervalScale;
        const x = (i + 1) * W / 4, y = 34;
        const aim = Math.random() < 0.5 ? this.x : Math.random() * W;
        const speed = 105 + Math.random() * 90;
        const length = Math.hypot(aim - x, PLAYER_Y - y);
        this.bullets.push({x, y, vx: (aim - x) / length * speed, vy: (PLAYER_Y - y) / length * speed, speed, spent: false});
      }
    }
    for (const b of this.bullets) {
      const ox = b.x, oy = b.y;
      if (b.spent) b.vy += 540 * dt;
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (!b.spent && b.y >= OBSERVATION_Y) {
        const token = this.bulletToken(b);
        // Entry and changes of threat/direction emit events, never periodic copies.
        if (!b.observed || b.lastToken !== token) this.record([token]);
        b.observed = true; b.lastToken = token;
      }
      // Segment collision avoids missing a hit during a long frame.
      if (!b.spent) {
        const dx = b.x - ox, dy = b.y - oy, len = dx * dx + dy * dy;
        const t = len ? Math.max(0, Math.min(1, ((this.x - ox) * dx + (PLAYER_Y - oy) * dy) / len)) : 0;
        if (Math.hypot(ox + t * dx - this.x, oy + t * dy - PLAYER_Y) < RADIUS + 4) {
          b.spent = true; b.vx = (Math.random() - 0.5) * 250; b.vy = -180 - Math.random() * 150;
          this.hits++; this.pendingHits++; this.flash = 0.16;
          this.record([CONTACT]);
        }
      }
    }
    const hadVisible = this.bullets.some(b => b.observed);
    this.bullets = this.bullets.filter(b => {
      const keep = b.y < H + 25 && b.x > -100 && b.x < W + 100;
      if (!keep && b.observed && !b.spent) this.record([BULLET_EXIT]);
      if (b.spent) b.observed = false;
      return keep;
    });
    if (hadVisible && !this.bullets.some(b => b.observed)) this.record([NO_BULLETS]);
    this.hitRates.advance(dt, this.hits - previousHits);
  }
  positionToken() { return POSITION + Math.min(7, Math.floor(this.x / W * 8)); }
  bulletToken(b) {
    const futureX = b.x + b.vx * Math.max(0, (PLAYER_Y - b.y) / b.vy);
    const threat = Math.abs(futureX - this.x) < RADIUS * 2 + 4 ? 1 : 0;
    const direction = b.x < this.x - FRONT_HALF_WIDTH ? 0 : b.x > this.x + FRONT_HALF_WIDTH ? 2 : 1;
    const speed = Math.min(2, Math.floor((b.speed - 105) / 30));
    return BULLET + threat * 9 + direction * 3 + speed;
  }
  observation() {
    const tokens = [this.positionToken()];
    for (const b of this.bullets) {
      if (b.spent || b.y < OBSERVATION_Y) continue;
      tokens.push(this.bulletToken(b));
    }
    if (tokens.length === 1) tokens.push(NO_BULLETS);
    return tokens;
  }
  record(tokens) {
    this.outbox.push(...tokens);
    this.history.push(...tokens);
    if (this.history.length > HISTORY) this.history.splice(0, this.history.length - HISTORY);
  }
  beginSample(random = false, action = this.action) {
    this.act(random ? Math.floor(Math.random() * 7) : action);
    const prefix = [...this.observation(), this.action];
    // Preserve the decision-time input; later observations must not leak into X.
    this.decisionHistory = [...this.history, ...prefix].slice(-HISTORY);
    this.record(prefix);
    this.pendingHits = 0;
    this.decisionRemaining = OUTCOME_SECONDS;
  }
  finishSample() {
    if (!this.decisionHistory) return;
    this.outboxExamples.push({offset: this.outbox.length, history: this.decisionHistory});
    const isHit = this.pendingHits > 0;
    this.record([isHit ? HIT : SAFE]);
    // 特徴収集周期・トリガー: 被弾 or 無被弾が派生したら学習配列追加処理をworkerに通知
    if (worker) {
      worker.postMessage({type: 'outcome', isHit, history: this.decisionHistory});
    }
    this.decisionHistory = null; this.decisionRemaining = 0;
    this.pendingHits = 0;
  }
  sample() {
    const tokens = this.outbox;
    this.sampleExamples = this.outboxExamples;
    this.outbox = []; this.outboxExamples = [];
    return tokens;
  }
  draw() {
    const c = this.ctx; c.clearRect(0, 0, W, H);
    c.strokeStyle = '#1b2a3b'; c.lineWidth = 1;
    c.beginPath(); for (let x = 30; x < W; x += 30) { c.moveTo(x, 0); c.lineTo(x, H); }
    for (let y = 20; y < H; y += 30) { c.moveTo(0, y); c.lineTo(W, y); } c.stroke();
    c.setLineDash([4, 7]); c.strokeStyle = '#32465a'; c.beginPath(); c.moveTo(0, OBSERVATION_Y); c.lineTo(W, OBSERVATION_Y); c.stroke(); c.setLineDash([]);
    for (let i = 1; i <= 3; i++) {
      const x = i * W / 4; c.fillStyle = '#485b75'; c.fillRect(x - 13, 12, 26, 17); c.fillStyle = '#a6b7cd'; c.fillRect(x - 4, 26, 8, 12);
    }
    for (const b of this.bullets) {
      c.globalAlpha = b.spent ? 0.23 : 1; c.fillStyle = b.spent ? '#d8e1ee' : '#f2b879';
      c.beginPath(); c.arc(b.x, b.y, 4, 0, Math.PI * 2); c.fill();
    }
    c.globalAlpha = 1; c.fillStyle = this.flash ? '#ffffff' : this.color;
    c.beginPath(); c.moveTo(this.x, PLAYER_Y - 12); c.lineTo(this.x + 10, PLAYER_Y + 9); c.lineTo(this.x, PLAYER_Y + 5); c.lineTo(this.x - 10, PLAYER_Y + 9); c.closePath(); c.fill();
    c.fillStyle = '#4d637e'; c.font = '10px system-ui'; c.fillText('OBSERVATION LINE', 12, OBSERVATION_Y - 8);
  }
}
const left = new Arena('random', '#edb76b'), right = new Arena('learned', '#67d9c4');
const SPEEDS = [1, 3, 10];
let speedIndex = 0;
let worker, running = false, elapsed = 0, frameId = 0, tickClock = 0, requestId = 0, pending = null, generation = 0;
let inferClock = 0;
function initWorker() {
  if (worker) worker.terminate();
  pending = null; const current = ++generation;
  const fail = () => {
    stop(); worker?.terminate(); worker = null; byId('start').disabled = true;
    byId('status').textContent = '起動エラー';
    byId('error').textContent = '学習Workerを起動できません。HTTPサーバー経由でindex.htmlを開いてください。';
  };
  byId('start').disabled = false;
  try { worker = new Worker('learn.js'); } catch { fail(); return; }
  worker.postMessage({type: 'speed', value: SPEEDS[speedIndex]});
  worker.onmessage = ({data}) => {
    if (current !== generation) return;
    if (data.type === 'tick') {
      if (running) advance(data.dt * SPEEDS[speedIndex]);
      worker.postMessage({type: 'ticked', dt: data.dt});
    } else if (data.type === 'stats') {
      byId('tokens').textContent = data.tokens.toLocaleString(); byId('updates').textContent = data.updates.toLocaleString();
      byId('loss').textContent = data.loss.toFixed(3);
    } else if (data.type === 'choice' && data.id === pending) {
      pending = null;
      if (running) {
        right.beginSample(false, data.action);
        byId('risk').textContent = (data.risk * 100).toFixed(1) + '%';
        byId('outcome').textContent = data.outcome === HIT ? '被弾' : '無被弾';
        updateDecision(data);
      }
    }
  };
  worker.onerror = fail;
}
function updateDisplay() {
  for (const [arena, prefix] of [[left, 'left'], [right, 'right']]) {
    byId(prefix + '-hits').textContent = arena.hits;
    for (const [frames, suffix] of [[6, '-rate'], [60, '-rate-long']]) {
      const rate = arena.hitRates.rate(frames);
      byId(prefix + suffix).textContent = rate === null ? '—' : rate.toFixed(1);
    }
    byId(prefix + '-action').textContent = ACTIONS[arena.action];
  }
  byId('elapsed').textContent = String(Math.floor(elapsed / 60)).padStart(2, '0') + ':' + String(Math.floor(elapsed % 60)).padStart(2, '0');
}
function updateDecision(data) {
  // Preserve the last dangerous decision, including successful avoidance choices.
  if (!data.scores?.some(score => score.outcome === HIT)) return;
  byId('decision-summary').textContent =
    'ゲーム内 ' + elapsed.toFixed(1) + '秒・位置 ' + Math.round(right.x) +
    ' / ' + W + ' — 選択：' + ACTIONS[data.action] +
    '（' + (data.outcome === HIT ? '被弾予測' : '無被弾予測') + '）';
  for (let action = 0; action < ACTIONS.length; action++) {
    const score = data.scores.find(score => score.action === action);
    byId('decision-score-' + action).textContent = score ? (score.risk * 100).toFixed(1) + '%' : '—';
    byId('decision-result-' + action).textContent = score ? (score.outcome === HIT ? '被弾' : '無被弾') : '端のため候補外';
    byId('decision-picked-' + action).textContent = action === data.action ? '選択' : '';
    byId('decision-row-' + action).className = action === data.action ? 'chosen' : score?.outcome === HIT ? 'dangerous' : '';
  }
}
function clearDecision() {
  byId('decision-summary').textContent = '危険な候補を検出すると更新します。';
  for (let action = 0; action < ACTIONS.length; action++) {
    byId('decision-score-' + action).textContent = '—';
    byId('decision-result-' + action).textContent = '未評価';
    byId('decision-picked-' + action).textContent = '';
    byId('decision-row-' + action).className = '';
  }
}
function advance(dt) {
  // Hold simulation while choosing, keeping inference and execution states equal.
  if (pending !== null || !right.decisionHistory) return;
  while (dt > 0) {
    const step = Math.min(dt, 1 / 120, right.decisionRemaining, 0.2 - tickClock);
    left.step(step); right.step(step); dt -= step; elapsed += step;
    left.decisionRemaining -= step; right.decisionRemaining -= step;
    tickClock += step;
    inferClock += step;
    if (tickClock >= 0.2 - 1e-9) {
      tickClock = 0;
      left.record([TIME_200MS]); right.record([TIME_200MS]);
    }
    // 決定フェーズ終了時
    if (right.decisionRemaining <= 1e-9) {
      left.finishSample(); right.finishSample();
      flushSamples();
      left.beginSample(true);
      // 推定周期・トリガー（200ms毎）
      if (inferClock >= 0.2 - 1e-9) {
        inferClock = 0;
        infer();
      }
      break;
    }
    if (left.outbox.length || right.outbox.length) flushSamples();
  }
}
function flushSamples() {
  for (const [arena, source] of [[left, 'left'], [right, 'right']]) {
    const tokens = arena.sample();
    if (tokens.length) worker.postMessage({type: 'tokens', source, tokens, examples: arena.sampleExamples});
  }
  updateDisplay();
}
function frame() {
  if (!running) return;
  left.draw(); right.draw(); frameId = requestAnimationFrame(frame);
}
function stop() {
  running = false; cancelAnimationFrame(frameId);
  pending = null; worker?.postMessage({type: 'pause'});
  byId('start').textContent = 'START'; byId('status').textContent = '一時停止'; updateDisplay();
}
function start() {
  if (running || !worker) return;
  running = true; worker.postMessage({type: 'resume'});
  if (!left.decisionHistory) left.beginSample(true);
  if (!right.decisionHistory) infer();
  byId('start').textContent = 'PAUSE'; byId('status').textContent = '学習中';
  frameId = requestAnimationFrame(frame);
}
function infer() {
    if (pending !== null) return;
    // Exclude outward moves that cannot move the player at the wall.
    const actions = [0, 1, 2, 3, 4, 5, 6].filter(action =>
      action >= 4 || (action < 2 ? right.x > RADIUS : right.x < W - RADIUS));
    pending = ++requestId;
    worker.postMessage({type: 'infer', id: pending, history: right.history, observation: right.observation(), actions});
}
byId('start').onclick = () => running ? stop() : start();
byId('bullet-density').onchange = () => {
  const scale = Number(byId('bullet-density').value);
  if (![2, 4, 8].includes(scale)) return;
  for (const arena of [left, right]) {
    arena.shots = arena.shots.map(time => time * scale / shotIntervalScale);
  }
  shotIntervalScale = scale;
};
byId('speed').onclick = () => {
  speedIndex = (speedIndex + 1) % SPEEDS.length;
  const speed = SPEEDS[speedIndex];
  byId('speed').textContent = '速度 ×' + speed;
  byId('speed').setAttribute('aria-label', '学習速度を切り替え：現在' + speed + '倍');
  worker?.postMessage({type: 'speed', value: speed});
};
byId('reset').onclick = () => {
  stop(); left.reset(); right.reset(); elapsed = 0; tickClock = 0; inferClock = 0; initWorker();
  for (const id of ['tokens', 'updates']) byId(id).textContent = '0';
  for (const id of ['loss', 'risk', 'outcome']) byId(id).textContent = '—';
  clearDecision();
  if (worker) { byId('error').textContent = ''; byId('status').textContent = '待機中'; }
  updateDisplay(); left.draw(); right.draw(); start();
};
initWorker(); left.draw(); right.draw();
