'use strict';
// Shared vocabulary: intentions, positions, bullet classes, outcomes and events.
const {ACTIONS,POSITION,BULLET,HISTORY,TOKEN_WORDS,AGE,NONE,bin}=Words;
const HIT=1, SAFE=0;
function tokenToWord(id) { if(!TOKEN_WORDS[id]) throw new RangeError('Invalid token'); return TOKEN_WORDS[id]; }
const W = 360, H = 560, PLAYER_Y = 513, RADIUS = 9;
const DECISION_INTERVAL = 0.25, OBSERVATION_DELAY = 0.3;
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
    this.x = W / 2; this.target = this.x; this.action = 2; this.remaining = 0;
    this.bullets = []; this.hits = 0; this.history = [];
    this.hitRates = new HitRateHistory();
    this.sampleActive = false;
    this.shots = [0.3, 0.65, 1].map(time => time * shotIntervalScale); this.flash = 0;
    this.time=0; this.observationClock=0; this.snapshots=[];
    this.perceived={time:0,tokens:[POSITION+4,NONE]};
    this.commands=[{time:0,velocity:0}]; this.capture();
  }
  act(action) {
    this.action=action;
    const velocity=action===0?-180:action===1?180:0;
    this.target=Math.max(RADIUS,Math.min(W-RADIUS,this.x+velocity*DECISION_INTERVAL));
    this.remaining=DECISION_INTERVAL;
    this.commands.push({time:this.time,velocity});
  }
  capture() {
    const threats=this.bullets.filter(b=>!b.spent).map(b=>({token:Words.bulletToken(b),eta:(PLAYER_Y-b.y)/b.vy}))
      .filter(b=>b.token!==null).sort((a,b)=>b.eta-a.eta).slice(-12).map(b=>b.token);
    this.snapshots.push({time:this.time,tokens:[POSITION+bin(this.x),...(threats.length?threats:[NONE])]});
  }
  perceive() {
    while(this.snapshots.length && this.snapshots[0].time<=this.time-OBSERVATION_DELAY+1e-9)this.perceived=this.snapshots.shift();
    // Only own issued commands are integrated after the old visual observation.
    // Never consult current x, live bullets, or recent hits here.
    let x=(this.perceived.tokens[0]-POSITION+0.5)*45;
    const commands=this.commands;
    for(let i=0;i<commands.length;i++) {
      const from=Math.max(this.perceived.time,commands[i].time);
      const to=Math.min(this.time,i+1<commands.length?commands[i+1].time:this.time);
      if(to>from)x=Math.max(RADIUS,Math.min(W-RADIUS,x+commands[i].velocity*(to-from)));
    }
    const relative=this.perceived.tokens.slice(1).map(token=>{
      const b=Words.decode(token);if(!b)return token;
      const offset=Math.max(-4,Math.min(4,b.lane-bin(x)));
      const eta=Math.floor((token-BULLET)/3)%6;
      return Words.RELATIVE+(offset+4)*6+eta;
    });
    this.history=[...relative,POSITION+bin(x),AGE];
    while(this.commands.length>1 && this.commands[1].time<=this.perceived.time)this.commands.shift();
    return this.history.slice();
  }
  step(dt) {
    const previousHits = this.hits;
    const delta = this.target - this.x;
    this.x += Math.sign(delta) * Math.min(Math.abs(delta), 180 * dt);
    this.remaining = Math.max(0, this.remaining - dt); this.flash = Math.max(0, this.flash - dt);
    for (let i = 0; i < 3; i++) {
      this.shots[i] -= dt;
      if (this.shots[i] <= 0) {
        this.shots[i] += (0.85 + Math.random() * 0.8) * shotIntervalScale;
        const x = (i + 1) * W / 4, y = 34;
        const aim = Math.random() < 0.5 ? this.x : Math.random() * W;
        const speed = 105 + Math.random() * 90;
        const length = Math.hypot(aim - x, PLAYER_Y - y);
        const bullet = {x, y, spawnX: x, vx: (aim - x) / length * speed, vy: (PLAYER_Y - y) / length * speed, speed, spent: false};
        this.bullets.push(bullet);
      }
    }
    for (const b of this.bullets) {
      const ox = b.x, oy = b.y;
      if (b.spent) b.vy += 540 * dt;
      b.x += b.vx * dt; b.y += b.vy * dt;
      // Segment collision avoids missing a hit during a long frame.
      if (!b.spent) {
        const dx = b.x - ox, dy = b.y - oy, len = dx * dx + dy * dy;
        const t = len ? Math.max(0, Math.min(1, ((this.x - ox) * dx + (PLAYER_Y - oy) * dy) / len)) : 0;
        if (Math.hypot(ox + t * dx - this.x, oy + t * dy - PLAYER_Y) < RADIUS + 4) {
          b.spent = true; b.vx = (Math.random() - 0.5) * 250; b.vy = -180 - Math.random() * 150;
          this.hits++; this.flash = 0.16;

        }
      }
    }
    this.bullets = this.bullets.filter(b => b.y < H + 25 && b.x > -100 && b.x < W + 100);
    this.hitRates.advance(dt, this.hits - previousHits);
    this.time+=dt; this.observationClock+=dt;
    if(this.observationClock>=0.05-1e-9) {this.observationClock=0;this.capture();}
    // Completion ends the command at the human decision clock.
    if (this.sampleActive && this.remaining <= 1e-9) this.finishSample();
  }
  positionToken() { return POSITION + Math.min(7, Math.floor(this.x / W * 8)); }
  bulletToken(b) { return Words.bulletToken(b); }

  beginSample(random = false, action = this.action) {
    const next = random ? Math.floor(Math.random() * ACTIONS.length) : action;
    // Repeated predictions of the current action let its distance/time complete.
    if (this.sampleActive && next === this.action) return;
    // Each new action records current position immediately before its action token.
    if (this.sampleActive) this.finishSample();
    this.act(next);

    this.sampleActive = true;
  }
  finishSample() {
    if (!this.sampleActive) return;
    this.sampleActive = false;
  }
  draw() {
    const c = this.ctx; c.clearRect(0, 0, W, H);
    c.strokeStyle = '#1b2a3b'; c.lineWidth = 1;
    c.beginPath(); for (let x = 30; x < W; x += 30) { c.moveTo(x, 0); c.lineTo(x, H); }
    for (let y = 20; y < H; y += 30) { c.moveTo(0, y); c.lineTo(W, y); } c.stroke();

    for (let i = 1; i <= 3; i++) {
      const x = i * W / 4; c.fillStyle = '#485b75'; c.fillRect(x - 13, 12, 26, 17); c.fillStyle = '#a6b7cd'; c.fillRect(x - 4, 26, 8, 12);
    }
    for (const b of this.bullets) {
      c.globalAlpha = b.spent ? 0.23 : 1; c.fillStyle = b.spent ? '#d8e1ee' : '#f2b879';
      c.beginPath(); c.arc(b.x, b.y, 4, 0, Math.PI * 2); c.fill();
    }
    c.globalAlpha = 1; c.fillStyle = this.flash ? '#ffffff' : this.color;
    c.beginPath(); c.moveTo(this.x, PLAYER_Y - 12); c.lineTo(this.x + 10, PLAYER_Y + 9); c.lineTo(this.x, PLAYER_Y + 5); c.lineTo(this.x - 10, PLAYER_Y + 9); c.closePath(); c.fill();
  }
}
const left = new Arena('random', '#edb76b'), right = new Arena('learned', '#67d9c4');
const SPEEDS = [1, 3, 10, 20, 40];
let speedIndex = 0;
let worker, running = false, elapsed = 0, frameId = 0, tickClock = 0, requestId = 0, pending = null, generation = 0;
let advanceRemainder = 0;
const actionSentences = [];
function recordActionSentence(history) {
  actionSentences.unshift(history.slice(-64).map(tokenToWord).join(', '));
  if (actionSentences.length > 10) actionSentences.pop();
}
function updateSentenceViewer() {
  for (let i = 0; i < 10; i++) {
    const row = byId('sentence-' + i);
    row.textContent = actionSentences[i] || '—';
    row.disabled = !actionSentences[i];
    row.title = actionSentences[i] || '';
  }
}
async function copySentence(index) {
  const sentence = byId('sentence-' + index).textContent;
  const status = byId('sentence-status');
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard API unavailable');
    await navigator.clipboard.writeText(sentence);
    status.textContent = '文章をコピーしました。';
  } catch (error) {
    console.error('文章のコピーに失敗しました。', error);
    status.textContent = 'コピーに失敗しました。HTTPSまたはlocalhostで開き、クリップボードの権限を確認してください。';
  }
}
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

  worker.onmessage = ({data}) => {
    if (current !== generation) return;
    if (data.type === 'tick') {
      const dt = running ? advance(data.dt * SPEEDS[speedIndex]) : 0;
      worker.postMessage({type: 'ticked', dt});
    } else if (data.type === 'stats') {
      byId('tokens').textContent = data.tokens.toLocaleString(); byId('updates').textContent = data.updates.toLocaleString();
      byId('loss').textContent = data.loss.toFixed(3);
      byId('queued').textContent = data.queued;
    } else if (data.type === 'choice' && data.id === pending) {
      pending = null;
      if (running) {
        right.beginSample(false, data.action);
        recordActionSentence([...right.history,data.action]);
        byId('risk').textContent = (data.risk * 100).toFixed(1) + '%';
        byId('outcome').textContent = data.unresolved > 0 ? '先読み未到達' : data.outcome === HIT ? '被弾リスク高' : '被弾リスク低';
        updateDecision(data);
        // Continue the accelerated tick after each asynchronous inference boundary.
        if (advanceRemainder > 1e-9) {
          const dt = advance(0);
          worker.postMessage({type: 'progress', dt});
        }
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
  if (!data.scores?.some(score => score.outcome === HIT || score.unresolved > 0)) return;
  byId('decision-summary').textContent =
    'ゲーム内 ' + elapsed.toFixed(1) + '秒・位置 ' + Math.round(right.x) +
    ' / ' + W + ' — 選択：' + ACTIONS[data.action] +
    '（' + (data.unresolved > 0 ? '先読み未到達' : data.outcome === HIT ? '被弾リスク高' : '被弾リスク低') + '）';
  for (let action = 0; action < ACTIONS.length; action++) {
    const score = data.scores.find(score => score.action === action);
    byId('decision-score-' + action).textContent = score ? (score.risk * 100).toFixed(1) + '%' : '—';
    byId('decision-result-' + action).textContent = score ? (score.unresolved > 0 ? '先読み未到達' : score.outcome === HIT ? '被弾リスク高' : '被弾リスク低') : '端のため候補外';
    byId('decision-picked-' + action).textContent = action === data.action ? '選択' : '';
    byId('decision-row-' + action).className = action === data.action ? 'chosen' : score && (score.outcome === HIT || score.unresolved > 0) ? 'dangerous' : '';
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
  if (pending !== null) return 0;
  dt += advanceRemainder; advanceRemainder = 0;
  let advanced = 0;
  while (dt > 1e-9) {

    const step = Math.min(dt, 1 / 120, DECISION_INTERVAL - tickClock,
      left.remaining || Infinity, right.sampleActive ? right.remaining || Infinity : Infinity);
    left.step(step); right.step(step); dt -= step; elapsed += step; advanced += step;
    tickClock += step;
    if (tickClock >= DECISION_INTERVAL - 1e-9) {
      tickClock = 0;
      left.beginSample(true);
      const history=left.perceive();
      worker.postMessage({type:'observation',source:'left',history});
      infer();
      updateDisplay();
      advanceRemainder = dt;
      break;
    }
  }
  return advanced;
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
  if (!left.sampleActive) left.beginSample(true);
  if (!right.sampleActive) infer();
  byId('start').textContent = 'PAUSE'; byId('status').textContent = '学習中';
  frameId = requestAnimationFrame(frame);
}
function infer() {
  if(pending!==null)return;
  const history=right.perceive();
  const actions=[0,1,2];
  worker.postMessage({type:'observation',source:'right',history});
  pending=++requestId;
  worker.postMessage({type:'infer',id:pending,history,actions});
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
};
byId('reset').onclick = () => {
  stop(); left.reset(); right.reset(); elapsed = 0; tickClock = 0; advanceRemainder = 0; initWorker();
  actionSentences.length = 0; updateSentenceViewer(); byId('sentence-status').textContent = '';
  for (const id of ['tokens', 'updates']) byId(id).textContent = '0';
  for (const id of ['loss', 'risk', 'outcome']) byId(id).textContent = '—';
  clearDecision();
  if (worker) { byId('error').textContent = ''; byId('status').textContent = '待機中'; }
  updateDisplay(); left.draw(); right.draw(); start();
};
for (let i = 0; i < 10; i++) byId('sentence-' + i).onclick = () => copySentence(i);
updateSentenceViewer();
setInterval(updateSentenceViewer, 10000);
initWorker(); left.draw(); right.draw();
