'use strict';
// Dedicated Worker: a 64 → 128 → 128 → 64 next-token MLP and short model rollouts.
const VOCAB = 64, HIDDEN = 128, HIT = 62, SAFE = -1, TIME_200MS = 63, HISTORY = 64, CAPACITY = 8192;
const MAX_ROLLOUT_TOKENS = 20, TARGET_TICKS = 2;
let hitLossWeight = 1;
// The nth token before the target has weight 1/n (n = 1..64).
const historyWeights = Float64Array.from({length: HISTORY}, (_, i) => 1 / (i + 1));
const w1 = new Float32Array(VOCAB * HIDDEN), b1 = new Float32Array(HIDDEN);
const w2 = new Float32Array(HIDDEN * HIDDEN), b2 = new Float32Array(HIDDEN);
const w3 = new Float32Array(HIDDEN * VOCAB), b3 = new Float32Array(VOCAB);
const hidden = new Float32Array(HIDDEN), hidden2 = new Float32Array(HIDDEN), probabilities = new Float32Array(VOCAB);
const gradient = new Float32Array(HIDDEN), gradient2 = new Float32Array(HIDDEN), features = new Float32Array(VOCAB);
for (let i = 0; i < w1.length; i++) w1[i] = (Math.random() * 2 - 1) * Math.sqrt(6 / (VOCAB + HIDDEN));
for (let i = 0; i < w2.length; i++) w2[i] = (Math.random() * 2 - 1) * Math.sqrt(6 / (HIDDEN + HIDDEN));
for (let i = 0; i < w3.length; i++) w3[i] = (Math.random() * 2 - 1) * Math.sqrt(6 / (VOCAB + HIDDEN));
class ExampleRing {
  constructor() { this.data = new Array(CAPACITY); this.length = 0; this.cursor = 0; }
  push(example) {
    this.data[this.cursor] = example;
    this.cursor = (this.cursor + 1) % CAPACITY;
    this.length = Math.min(CAPACITY, this.length + 1);
  }
  recent(distance) { return this.data[(this.cursor - 1 - distance + CAPACITY) % CAPACITY]; }
}
const examplesBySource = {left: new ExampleRing(), right: new ExampleRing()};
// Keep actual histories separate; both arenas train the shared model.
const histories = new Map();
let total = 0, updates = 0, loss = 0, active = false, timer = null, lastStats = 0;
let clockTimer = null, lastTick = 0, tickPending = false;
let learnClock = 0;
const LEARN_INTERVAL = 1;
let trainingQueue = [];
function tick() {
  const now = performance.now();
  // Bound elapsed time and allow only one outstanding tick after a stalled tab.
  if (!tickPending) {
    tickPending = true;
    postMessage({type: 'tick', dt: Math.min((now - lastTick) / 1000, 0.05)});
  }
  lastTick = now;
}
function encode(history, output = features) {
  output.fill(0);
  for (let i = 0, n = Math.min(HISTORY, history.length); i < n; i++) output[history[history.length - 1 - i]] += historyWeights[i];
  return output;
}
function forward(x) {
  for (let j = 0; j < HIDDEN; j++) {
    let sum = b1[j]; for (let i = 0; i < VOCAB; i++) sum += x[i] * w1[i * HIDDEN + j];
    hidden[j] = Math.tanh(sum);
  }
  for (let j = 0; j < HIDDEN; j++) {
    let sum = b2[j]; for (let i = 0; i < HIDDEN; i++) sum += hidden[i] * w2[i * HIDDEN + j];
    hidden2[j] = Math.tanh(sum);
  }
  let max = -Infinity;
  for (let k = 0; k < VOCAB; k++) {
    let sum = b3[k]; for (let j = 0; j < HIDDEN; j++) sum += hidden2[j] * w3[j * VOCAB + k];
    probabilities[k] = sum; max = Math.max(max, sum);
  }
  let denominator = 0;
  for (let k = 0; k < VOCAB; k++) { probabilities[k] = Math.exp(probabilities[k] - max); denominator += probabilities[k]; }
  for (let k = 0; k < VOCAB; k++) probabilities[k] /= denominator;
  return probabilities;
}
function train(example) {
  encode(example.history);
  const target = example.target;
  forward(features);
  const error = -Math.log(Math.max(1e-9, probabilities[target]));
  loss = updates ? loss * 0.98 + error * 0.02 : error;
  gradient.fill(0); gradient2.fill(0);
  const rate = 0.012;
  const weight = target === HIT ? hitLossWeight : 1;
  for (let k = 0; k < VOCAB; k++) {
    const d = weight * (probabilities[k] - (k === target ? 1 : 0));
    for (let j = 0; j < HIDDEN; j++) {
      const at = j * VOCAB + k;
      gradient2[j] += d * w3[at]; w3[at] -= rate * d * hidden2[j];
    }
    b3[k] -= rate * d;
  }
  for (let j = 0; j < HIDDEN; j++) {
    const d = Math.max(-2, Math.min(2, gradient2[j] * (1 - hidden2[j] * hidden2[j])));
    b2[j] -= rate * d;
    for (let i = 0; i < HIDDEN; i++) {
      const at = i * HIDDEN + j;
      gradient[i] += d * w2[at]; w2[at] -= rate * d * hidden[i];
    }
  }
  for (let j = 0; j < HIDDEN; j++) {
    const d = Math.max(-2, Math.min(2, gradient[j] * (1 - hidden[j] * hidden[j])));
    b1[j] -= rate * d;
    for (let i = 0; i < VOCAB; i++) w1[i * HIDDEN + j] -= rate * d * features[i];
  }
  updates++;
}
function schedule() {
  if (active && timer === null && trainingQueue.length) timer = setTimeout(work, 0);
}
function work() {
  timer = null;
  if (!active) return;
  const start = performance.now();
  let count = 0;
  while (count < trainingQueue.length && count < 16 && performance.now() - start < 8) {
    train(trainingQueue[count++]);
  }
  trainingQueue.splice(0, count);
  reportStats();
  schedule();
}
function reportStats() {
  if (performance.now() - lastStats >= 500) {
    postMessage({type: 'stats', tokens: total, updates, loss}); lastStats = performance.now();
  }
}
function collect(history, target, source = 'left') {
  examplesBySource[source].push({history: Uint16Array.from(history.slice(-HISTORY)), target, source});
}
function latestBatch() {
  const left = examplesBySource.left, right = examplesBySource.right;
  let leftCount = Math.min(750, left.length), rightCount = Math.min(250, right.length);
  // Fill missing quota from the other arena, without duplicating within a batch.
  let remaining = 1000 - leftCount - rightCount;
  const extraLeft = Math.min(remaining, left.length - leftCount);
  leftCount += extraLeft; remaining -= extraLeft;
  rightCount += Math.min(remaining, right.length - rightCount);
  const batch = [];
  let l = 0, r = 0;
  while (l < leftCount || r < rightCount) {
    for (let i = 0; i < 3 && l < leftCount; i++) batch.push(left.recent(l++));
    if (r < rightCount) batch.push(right.recent(r++));
  }
  // Fisher–Yates: mix both sources before consuming the batch from its head.
  for (let i = batch.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [batch[i], batch[j]] = [batch[j], batch[i]];
  }
  return batch;
}
function learningTick(dt) {
  if (!active) return;
  learnClock += dt;
  while (learnClock >= LEARN_INTERVAL - 1e-9) {
    learnClock = Math.max(0, learnClock - LEARN_INTERVAL);
    // Discard unfinished work from the previous game-time interval.
    trainingQueue = latestBatch();
  }
  schedule();
  reportStats();
}
// Greedy continuation until two generated time ticks or the token limit.
function rollout(history, action) {
  const future = [...history, action].slice(-HISTORY);
  let risk = 0, ticks = 0, tokens = 0;
  while (tokens < MAX_ROLLOUT_TOKENS && ticks < TARGET_TICKS) {
    const p = forward(encode(future));
    let next = 0;
    for (let token = 1; token < VOCAB; token++) if (p[token] > p[next]) next = token;
    risk = Math.max(risk, Math.max(0, Math.min(1, p[HIT])));
    future.push(next);
    if (future.length > HISTORY) future.shift();
    tokens++;
    if (next === TIME_200MS) ticks++;
  }
  return {action, risk, ticks, tokens, unresolved: 0, outcome: risk > 0.5 ? HIT : SAFE};
}
function choose(history, actions = [0, 1, 2, 3, 4, 5]) {
  const scores = actions.map(action => rollout(history, action));
  const minimum = Math.min(...scores.map(score => score.risk));
  const best = scores.filter(score => Math.abs(score.risk - minimum) <= 1e-12);
  return {...best[Math.floor(Math.random() * best.length)], scores};
}
onmessage = ({data}) => {
  if (data.type === 'hit-loss-weight') {
    if ([1, 5, 10, 15, 20].includes(data.weight)) hitLossWeight = data.weight;
  } else if (data.type === 'ticked') {
    tickPending = false;
    learningTick(data.dt || 0);
  } else if (data.type === 'progress') {
    learningTick(data.dt || 0);
  } else if (data.type === 'tokens') {
    if (data.source !== 'left' && data.source !== 'right') return;
    const source = data.source;
    const history = histories.get(source) || [];
    for (const token of data.tokens) {
      if (!Number.isInteger(token) || token < 0 || token >= VOCAB) continue;
      collect(history, token, source);
      history.push(token);
      if (history.length > HISTORY) history.shift();
      total++;
    }
    histories.set(source, history);
  } else if (data.type === 'infer') {
    postMessage({type: 'choice', id: data.id, ...choose(data.history, data.actions)});
  } else if (data.type === 'pause') {
    active = false; clearTimeout(timer); timer = null;
    clearInterval(clockTimer); clockTimer = null;
  } else if (data.type === 'resume') {
    active = true; schedule();
    if (clockTimer === null) {
      lastTick = performance.now(); tickPending = false;
      clockTimer = setInterval(tick, 1000 / 60);
    }
  }
};
