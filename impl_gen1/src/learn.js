'use strict';
// Dedicated Worker: a 41 → 64 → 64 → 41 MLP, SGD and bounded replay memory.
const VOCAB = 41, HIDDEN = 64, HIT = 33, SAFE = 34, HISTORY = 128, CAPACITY = 8192;
const SAFE_SAMPLE_EVERY = 5, RISK_TOLERANCE = 0.01;
// Index 0 is newest; index 31 reaches 0.1, then each older token decays by 3%.
const historyWeights = Float64Array.from({length: HISTORY}, (_, i) =>
  i < 32 ? 1 - 0.9 * i / 31 : 0.1 * Math.pow(0.97, i - 31));
const w1 = new Float32Array(VOCAB * HIDDEN), b1 = new Float32Array(HIDDEN);
const w2 = new Float32Array(HIDDEN * HIDDEN), b2 = new Float32Array(HIDDEN);
const w3 = new Float32Array(HIDDEN * VOCAB), b3 = new Float32Array(VOCAB);
const hidden = new Float32Array(HIDDEN), hidden2 = new Float32Array(HIDDEN), probabilities = new Float32Array(VOCAB);
const gradient = new Float32Array(HIDDEN), gradient2 = new Float32Array(HIDDEN), features = new Float32Array(VOCAB);
for (let i = 0; i < w1.length; i++) w1[i] = (Math.random() * 2 - 1) * Math.sqrt(6 / (VOCAB + HIDDEN));
for (let i = 0; i < w2.length; i++) w2[i] = (Math.random() * 2 - 1) * Math.sqrt(6 / (HIDDEN + HIDDEN));
for (let i = 0; i < w3.length; i++) w3[i] = (Math.random() * 2 - 1) * Math.sqrt(6 / (VOCAB + HIDDEN));
const memory = new Uint8Array(CAPACITY);
// Keep complete context; this mask controls training targets, including replay.
const learnable = new Uint8Array(CAPACITY);
// Decision-time inputs for delayed outcomes, overwritten with their ring slots.
const decisionContexts = new Array(CAPACITY);
let safeSeen = 0, replayRemaining = 0, replayCursor = -1;
const safeSeenBySource = {left: 0, right: 0};
let total = 0, nextTrain = 1, updates = 0, loss = 0, active = false, timer = null, lastStats = 0;
let clockTimer = null, lastTick = 0, tickPending = false;
let speed = 1;
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
function train(index) {
  features.fill(0);
  const oldest = Math.max(0, total - CAPACITY);
  const context = decisionContexts[index % CAPACITY];
  if (context) encode(context);
  else for (let distance = 1; distance <= HISTORY && index - distance >= oldest; distance++) {
    features[memory[(index - distance) % CAPACITY]] += historyWeights[distance - 1];
  }
  const target = memory[index % CAPACITY];
  forward(features);
  const error = -Math.log(Math.max(1e-9, probabilities[target]));
  loss = updates ? loss * 0.98 + error * 0.02 : error;
  gradient.fill(0); gradient2.fill(0);
  const rate = 0.012;
  for (let k = 0; k < VOCAB; k++) {
    const d = probabilities[k] - (k === target ? 1 : 0);
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
  if (active && timer === null && total > 1) timer = setTimeout(work, 12);
}
function work() {
  timer = null; if (!active) return;
  const start = performance.now(); let count = 0, attempts = 0;
  nextTrain = Math.max(nextTrain, total - CAPACITY + HISTORY);
  // Prioritize fresh tokens and scale replay and CPU budget with simulation speed.
  while (count < 48 * speed && attempts++ < 384 * speed && performance.now() - start < Math.min(16, 4 * speed)) {
    if (nextTrain < total) {
      const index = nextTrain++;
      if (!learnable[index % CAPACITY]) {
        // Spend the skipped safe target's update on older eligible data instead.
        if (memory[index % CAPACITY] === SAFE) replayRemaining = Math.min(CAPACITY, replayRemaining + 1);
        continue;
      }
      train(index);
    } else if (replayRemaining > 0) {
      const index = previousExample();
      if (index === null) { replayRemaining = 0; break; }
      train(index); replayRemaining--;
    } else break;
    count++;
  }
  if (performance.now() - lastStats > 500) {
    postMessage({type: 'stats', tokens: total, updates, loss}); lastStats = performance.now();
  }
  // Carry unfinished replay across slices without blocking inference.
  if (nextTrain < total || replayRemaining > 0) schedule();
}
function previousExample() {
  const first = Math.max(1, total - CAPACITY + HISTORY);
  for (let checked = 0; checked < total - first; checked++) {
    if (replayCursor < first || replayCursor >= total) replayCursor = total - 1;
    const index = replayCursor--;
    if (learnable[index % CAPACITY]) return index;
  }
  return null;
}
function choose(history, observation = [], actions = [0, 1, 2, 3, 4, 5, 6]) {
  const scores = actions.map(action => {
    const p = forward(encode([...history, ...observation, action]));
    // Undo safe-target undersampling before comparing outcome probabilities.
    const mass = p[HIT] + SAFE_SAMPLE_EVERY * p[SAFE];
    const risk = mass > 0 ? p[HIT] / mass : 0.5;
    return {action, risk, outcome: risk > 0.5 ? HIT : SAFE};
  });
  // Prefer a predicted safe outcome, then the lowest conditional hit risk.
  const safe = scores.filter(score => score.outcome === SAFE);
  const candidates = safe.length ? safe : scores;
  const minimum = Math.min(...candidates.map(score => score.risk));
  // Do not lock onto tiny, uncalibrated score differences between intentions.
  const best = candidates.filter(score => score.risk <= minimum + RISK_TOLERANCE);
  return {...best[Math.floor(Math.random() * best.length)], scores};
}
onmessage = ({data}) => {
  if (data.type === 'speed') {
    if ([1, 3, 10].includes(data.value)) speed = data.value;
  } else if (data.type === 'ticked') {
    tickPending = false;
  } else if (data.type === 'tokens') {
    const source = data.source === 'left' || data.source === 'right' ? data.source : null;
    const examples = new Map((data.examples || []).map(example => [example.offset, example.history]));
    for (let offset = 0; offset < data.tokens.length; offset++) {
      const token = data.tokens[offset];
      const slot = total++ % CAPACITY;
      memory[slot] = token;
      decisionContexts[slot] = examples.has(offset) ? Uint8Array.from(examples.get(offset).slice(-HISTORY)) : undefined;
      // Sample each arena independently; never build a sourced example from
      // neighbouring ring slots, since they may belong to the other arena.
      let eligible = token === HIT;
      if (token === SAFE) {
        const seen = source ? safeSeenBySource[source]++ : safeSeen;
        safeSeen++;
        eligible = seen % SAFE_SAMPLE_EVERY === 0;
      }
      learnable[slot] = eligible && (!source || decisionContexts[slot] !== undefined) ? 1 : 0;
    }
    if (data.tokens.length) replayRemaining = Math.min(CAPACITY, replayRemaining + 4 * speed);
    schedule();
  } else if (data.type === 'infer') {
    postMessage({type: 'choice', id: data.id, ...choose(data.history, data.observation, data.actions)});
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
