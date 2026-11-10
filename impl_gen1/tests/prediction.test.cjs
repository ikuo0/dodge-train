const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
function load(name, extra = {}) {
  const context = vm.createContext({performance, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {}, postMessage() {}, ...extra});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8'), context);
  return context;
}
function game() {
  const elements = new Map();
  const messages = [];
  const canvas = new Proxy({}, {get: () => () => {}});
  const document = {getElementById(id) {
    if (!elements.has(id)) elements.set(id, {textContent: '', getContext: () => canvas, setAttribute() {}});
    return elements.get(id);
  }};
  return {context: load('game.js', {document, Worker: class {postMessage(m) {messages.push(m);} terminate() {}}, requestAnimationFrame: () => 1, cancelAnimationFrame() {}}), elements, messages};
}
test('records an earlier observation and action followed by exactly one outcome', () => {
  const {context} = game();
  const result = vm.runInContext(`
    left.act(2); left.beginSample(); left.x = 300; left.pendingHits = 2;
    left.finishSample(); const hitRecord = left.sample();
    left.beginSample(); left.finishSample(); const safeRecord = left.sample();
    JSON.stringify({hitRecord, safeRecord, pending: left.pendingHits});
  `, context);
  const {hitRecord, safeRecord, pending} = JSON.parse(result);
  assert.deepEqual(hitRecord, [11, 35, 2, 33]);
  assert.deepEqual(safeRecord, [13, 35, 2, 34]);
  assert.equal(pending, 0);
});
test('current bullets are observed repeatedly without mutating observation state', () => {
  const {context} = game();
  assert.equal(vm.runInContext(`
    left.bullets = [{x:180,y:300,vx:0,vy:150,speed:150,spent:false}];
    JSON.stringify(left.observation()) === JSON.stringify(left.observation()) && left.observation().length === 2;
  `, context), true);
});
test('ranks outcome tokens, includes current observation and candidate action', () => {
  const context = load('learn.js');
  const result = JSON.parse(vm.runInContext(`
    forward = x => {
      if (Math.abs(x[24] - (1-0.9/31)) > 1e-6) throw Error('missing observation before action');
      const p = new Float32Array(VOCAB); p[7] = 0.9;
      p[HIT] = x[0] ? 0.08 : 0.01; p[SAFE] = x[0] ? 0.02 : 0.09;
      return p;
    };
    JSON.stringify(choose([], [24], [0, 2]));
  `, context));
  assert.equal(result.action, 2);
  assert.equal(result.outcome, 34);
  assert.ok(Math.abs(result.risk - 0.01 / (0.01 + 5 * 0.09)) < 1e-6);
});
test('when all candidates predict hit, selects the least risky one', () => {
  const context = load('learn.js');
  const result = JSON.parse(vm.runInContext(`
    forward = x => {
      const p = new Float32Array(VOCAB);
      p[HIT] = x[0] ? 0.999 : 0.99; p[SAFE] = x[0] ? 0.001 : 0.01;
      return p;
    };
    JSON.stringify(choose([], [35], [0, 2]));
  `, context));
  assert.equal(result.action, 2);
  assert.equal(result.outcome, 33);
});
test('holds each choice for 1500ms and emits no earlier outcome', () => {
  const {context, messages} = game();
  vm.runInContext(`
    start();
    worker.onmessage({data: {type:'choice', id:pending, action:2, risk:0.1, outcome:SAFE}});
    advance(1.499);
  `, context);
  const inference = messages.find(m => m.type === 'infer');
  assert.ok(inference.observation.length >= 2);
  assert.equal('horizon' in inference, false);
  assert.equal(vm.runInContext('right.action', context), 2);
  assert.equal(messages.filter(m => m.type === 'infer').length, 1);
  assert.ok(messages.filter(m => m.type === 'tokens').every(m => !m.tokens.includes(33) && !m.tokens.includes(34)));
  vm.runInContext('advance(0.001)', context);
  assert.equal(messages.filter(m => m.type === 'infer').length, 2);
  const outcomes = messages.filter(m => m.type === 'tokens').flatMap(m => m.tokens.filter(token => token===33 || token===34));
  assert.equal(outcomes.length, 2);
  assert.ok(Math.abs(vm.runInContext('elapsed', context) - 1.5) < 1e-9);
});
test('new outcome vocabulary trains with finite weights after ring buffer wrap', () => {
  const context = load('learn.js');
  assert.equal(vm.runInContext(`
    onmessage({data:{type:'tokens',tokens:Array.from({length:10000},(_,i)=>[11,35,2,34,11,24,0,33][i%8])}});
    nextTrain = total - 100;
    for (let i=nextTrain;i<total;i++) train(i);
    memory.length === 8192 && total === 10000 && Number.isFinite(loss) && [...w1,...w2,...w3,...b1,...b2,...b3].every(Number.isFinite);
  `, context), true);
});

test('bullet density reduces firing at four levels and persists through reset', () => {
  const {context, elements} = game();
  vm.runInContext('Math.random = () => 0.5', context);
  const counts = [];
  for (const scale of [1, 2, 4, 8]) {
    elements.get('bullet-density').value = String(scale);
    elements.get('bullet-density').onchange();
    const result = JSON.parse(vm.runInContext(`
      { left.reset(); right.reset();
      let fired = 0;
      for (let i=0; i<120*120; i++) {
        left.bullets = []; left.step(1/120); fired += left.bullets.length;
      }
      JSON.stringify({fired, rightDelay:right.shots[0], scale:shotIntervalScale}); }
    `, context));
    assert.equal(result.scale, scale);
    assert.ok(Math.abs(result.rightDelay - 0.3 * scale) < 1e-9);
    counts.push(result.fired);
  }
  for (let i=1; i<counts.length; i++) {
    assert.ok(counts[i] < counts[i-1]);
    assert.ok(Math.abs(counts[i] - counts[0] / (2 ** i)) <= 3);
  }
});

test('keeps complete context, all hit targets, and exactly one in 5 safe targets', () => {
  const context = load('learn.js');
  const result = JSON.parse(vm.runInContext(`
    const tokens = Array.from({length:100},(_,i)=>[11,35,2,SAFE,...(i%5===0?[HIT]:[])]).flat();
    onmessage({data:{type:'tokens',tokens}});
    JSON.stringify({
      intact: tokens.every((token,i)=>memory[i]===token),
      safeTargets: tokens.filter((token,i)=>token===SAFE && learnable[i]).length,
      hitTargets: tokens.filter((token,i)=>token===HIT && learnable[i]).length,
      safeSeen
    });
  `, context));
  assert.deepEqual(result, {intact:true, safeTargets:20, hitTargets:20, safeSeen:100});
});

test('skipped safe updates are replaced by older examples without replaying excluded targets', () => {
  const context = load('learn.js', {performance:{now:()=>0}});
  const result = JSON.parse(vm.runInContext(`
    const tokens = Array.from({length:100},(_,i)=>[11,35,2,i%10===0?HIT:SAFE]).flat();
    onmessage({data:{type:'tokens',tokens}});
    const trained = []; train = index => {trained.push(index); updates++;};
    active = true;
    let slices = 0;
    while ((nextTrain<total || replayRemaining>0) && slices++<100) work();
    JSON.stringify({
      drained: nextTrain===total && replayRemaining===0,
      allHits: tokens.every((token,i)=>token!==HIT || trained.includes(i)),
      noExcludedTargets: trained.every(i=>learnable[i%CAPACITY]===1),
      replayedOld: trained.some((index,i)=>i>0 && index<trained[i-1]),
      updates, outcomeCount: tokens.filter(token=>token===HIT || token===SAFE).length
    });
  `, context));
  assert.equal(result.drained, true);
  assert.equal(result.allHits, true);
  assert.equal(result.noExcludedTargets, true);
  assert.equal(result.replayedOld, true);
  assert.equal(result.updates, result.outcomeCount + 4);
});

test('sampling mask follows overwritten ring slots and always includes new hits', () => {
  const context = load('learn.js');
  assert.equal(vm.runInContext(`
    onmessage({data:{type:'tokens',tokens:Array(CAPACITY).fill(SAFE)}});
    onmessage({data:{type:'tokens',tokens:Array(CAPACITY).fill(HIT)}});
    total===CAPACITY*2 && memory.every(token=>token===HIT) && learnable.every(flag=>flag===1);
  `, context), true);
});

test('only outcome boundaries are targets and their inputs retain earlier outcomes', () => {
  const context = load('learn.js', {performance:{now:()=>0}});
  const result = JSON.parse(vm.runInContext(`
    const tokens = [11,35,2,HIT,12,24,0,SAFE,13,35,4,SAFE];
    onmessage({data:{type:'tokens',tokens}});
    const trained = [];
    const originalTrain = train;
    train = index => {
      originalTrain(index);
      trained.push({index, target:memory[index%CAPACITY], x:[...features]});
    };
    active = true;
    while(nextTrain<total || replayRemaining>0) work();
    JSON.stringify({
      trained,
      contextMask: tokens.every((token,i)=>token===HIT || token===SAFE || learnable[i]===0)
    });
  `, context));
  assert.equal(result.contextMask, true);
  assert.ok(result.trained.every(example => [33,34].includes(example.target)));
  const hit = result.trained.find(example => example.index === 3);
  assert.equal(hit.x[2], 1);
  assert.equal(hit.x[33], 0);
  const safe = result.trained.find(example => example.index === 7);
  assert.equal(safe.x[0], 1);
  assert.ok(Math.abs(safe.x[33] - (1-0.9*3/31)) < 1e-6);
  assert.equal(safe.x[34], 0);
  assert.ok(result.trained.every(example => example.index !== 11));
});

test('a hit late in the 1500ms interval is retained and completed movement waits', () => {
  const {context} = game();
  const result = JSON.parse(vm.runInContext(`
    start();
    worker.onmessage({data:{type:'choice',id:pending,action:2,risk:0.1,outcome:SAFE}});
    left.shots = right.shots = [10,10,10];
    advance(0.6); const completedX = right.x;
    advance(0.8); const waitingX = right.x;
    left.pendingHits = 1;
    advance(0.1);
    JSON.stringify({completedX,waitingX,leftHistory:left.history});
  `, context));
  assert.equal(result.completedX, 270);
  assert.equal(result.waitingX, 270);
  assert.ok(result.leftHistory.includes(33));
});

test('pause resumes the unfinished interval and reset starts a new 1500ms interval', () => {
  const {context, elements} = game();
  vm.runInContext(`
    start(); worker.onmessage({data:{type:'choice',id:pending,action:4,risk:0.1,outcome:SAFE}});
    advance(0.4); stop(); start(); advance(0.5);
  `, context);
  assert.ok(Math.abs(vm.runInContext('right.decisionRemaining', context) - 0.6) < 1e-9);
  elements.get('reset').onclick();
  assert.equal(vm.runInContext('elapsed', context), 0);
  assert.equal(vm.runInContext('left.decisionRemaining', context), 1.5);
  assert.equal(vm.runInContext('right.decisionHistory', context), null);
});

test('delayed outcome uses decision-time input without future observations or outcome leakage', () => {
  const context = load('learn.js');
  const result = JSON.parse(vm.runInContext(`
    onmessage({data:{type:'tokens',tokens:[11,35,2,12,24,2,HIT],examples:[{offset:6,history:[SAFE,11,35,2]}]}});
    train(6);
    const x = [...features];
    onmessage({data:{type:'tokens',tokens:Array(CAPACITY).fill(11)}});
    JSON.stringify({x,cleared:decisionContexts.every(value=>value===undefined)});
  `, context));
  assert.equal(result.x[2], 1);
  assert.ok(Math.abs(result.x[35] - (1-0.9/31)) < 1e-6);
  assert.ok(Math.abs(result.x[34] - (1-0.9*3/31)) < 1e-6);
  assert.equal(result.x[24], 0);
  assert.equal(result.x[33], 0);
  assert.equal(result.cleared, true);
});

test('records seven 200ms ticks in the first 1500ms without periodic observation copies', () => {
  const {context} = game();
  const result = JSON.parse(vm.runInContext(`
    start();
    worker.onmessage({data:{type:'choice',id:pending,action:4,risk:0.1,outcome:SAFE}});
    left.shots = right.shots = [10,10,10];
    advance(1.5);
    JSON.stringify(right.history);
  `, context));
  assert.equal(result.filter(token=>token===36).length, 7);
  assert.equal(result.filter(token=>token===35).length, 1);
  assert.equal(result.filter(token=>token===11).length, 1);
  assert.equal(result.filter(token=>token===4).length, 1);
  assert.equal(result.filter(token=>token===40).length, 1);
  assert.equal(result.at(-1), 34);
});

test('bullet entry and category changes are emitted once, followed by exit', () => {
  const {context} = game();
  const result = JSON.parse(vm.runInContext(`
    left.shots = [10,10,10];
    left.bullets = [{x:150,y:OBSERVATION_Y-1,vx:0,vy:120,speed:150,spent:false}];
    left.step(0.02); const entry = left.sample();
    left.step(0.02); const unchanged = left.sample();
    left.bullets[0].x = 220; left.step(0.02); const changed = left.sample();
    left.bullets[0].y = H+24; left.step(0.02); const exit = left.sample();
    JSON.stringify({entry,unchanged,changed,exit});
  `, context));
  assert.equal(result.entry.length, 1);
  assert.deepEqual(result.unchanged, []);
  assert.equal(result.changed.length, 1);
  assert.notEqual(result.entry[0], result.changed[0]);
  assert.deepEqual(result.exit, [38,35]);
});

test('movement completion emits one event and never restarts the action mid-interval', () => {
  const {context} = game();
  const result = JSON.parse(vm.runInContext(`
    left.shots = [10,10,10]; left.beginSample(false,2);
    for(let i=0;i<120;i++) left.step(1/120);
    JSON.stringify({x:left.x,tokens:left.sample()});
  `, context));
  assert.equal(result.x, 270);
  assert.equal(result.tokens.filter(token=>token===2).length, 1);
  assert.equal(result.tokens.filter(token=>token===37).length, 1);
});

test('immediate collision is a context event, with a separate delayed outcome', () => {
  const {context} = game();
  const result = JSON.parse(vm.runInContext(`
    left.shots=[10,10,10]; left.beginSample(false,4);
    left.bullets=[{x:180,y:512,vx:0,vy:150,speed:150,spent:false}];
    left.step(0.02); const events=left.sample();
    left.finishSample(); const result=left.sample();
    JSON.stringify({events,result});
  `, context));
  assert.equal(result.events.filter(token=>token===39).length, 1);
  assert.ok(!result.events.includes(33));
  assert.deepEqual(result.result, [33]);
});

test('new event tokens use history weighting and are never targets', () => {
  const context = load('learn.js');
  const result = JSON.parse(vm.runInContext(`
    onmessage({data:{type:'tokens',tokens:[36,37,38,39,40,HIT,SAFE]}});
    JSON.stringify({weight:encode([36,SAFE,36])[36],mask:[...learnable.slice(0,7)]});
  `, context));
  assert.ok(Math.abs(result.weight - (2-0.9*2/31)) < 1e-6);
  assert.deepEqual(result.mask, [0,0,0,0,0,1,1]);
});

test('two 64-wide hidden layers receive gradients and learn an outcome', () => {
  let seed = 42;
  const seededMath = Object.create(Math);
  seededMath.random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const context = load('learn.js', {Math: seededMath});
  const result = JSON.parse(vm.runInContext(`
    onmessage({data:{type:'tokens',tokens:[11,35,2,HIT]}});
    const before = [w1.slice(),w2.slice(),w3.slice()];
    const initial = forward(encode([11,35,2]))[HIT];
    train(3);
    const changed = [w1,w2,w3].map((weights,layer)=>weights.some((value,i)=>value!==before[layer][i]));
    for(let i=0;i<100;i++) train(3);
    const p = forward(encode([11,35,2]));
    JSON.stringify({changed,initial,final:p[HIT],sum:[...p].reduce((a,b)=>a+b,0),sizes:[w1.length,w2.length,w3.length,hidden.length,hidden2.length]});
  `, context));
  assert.deepEqual(result.sizes, [41*64,64*64,64*41,64,64]);
  assert.deepEqual(result.changed, [true,true,true]);
  assert.ok(result.final > result.initial);
  assert.ok(result.final > 0.9);
  assert.ok(Math.abs(result.sum-1)<1e-6);
});

test('choice diagnostics return scores for exactly the eligible actions', () => {
  const context = load('learn.js');
  const result = JSON.parse(vm.runInContext('JSON.stringify(choose([], [11,35], [2,3,4,5,6]))', context));
  assert.deepEqual(result.scores.map(score=>score.action), [2,3,4,5,6]);
  assert.ok(result.scores.every(score=>score.risk>=0 && score.risk<=1));
  assert.equal(result.risk, result.scores.find(score=>score.action===result.action).risk);
});

test('danger panel updates on a dangerous alternative and retains it through safe choices', () => {
  const {context, elements} = game();
  vm.runInContext(`
    updateDecision({action:4,outcome:SAFE,scores:[{action:2,risk:0.8,outcome:HIT},{action:4,risk:0.2,outcome:SAFE}]});
  `, context);
  const summary = elements.get('decision-summary').textContent;
  assert.ok(summary.includes('待機 300ms'));
  assert.equal(elements.get('decision-score-2').textContent, '80.0%');
  assert.equal(elements.get('decision-result-2').textContent, '被弾');
  assert.equal(elements.get('decision-row-2').className, 'dangerous');
  assert.equal(elements.get('decision-row-4').className, 'chosen');
  assert.equal(elements.get('decision-result-0').textContent, '端のため候補外');
  vm.runInContext('updateDecision({action:2,outcome:SAFE,scores:[{action:2,risk:0.1,outcome:SAFE}]})', context);
  assert.equal(elements.get('decision-summary').textContent, summary);
  assert.equal(elements.get('decision-score-2').textContent, '80.0%');
  elements.get('reset').onclick();
  assert.equal(elements.get('decision-score-2').textContent, '—');
  assert.equal(elements.get('decision-result-2').textContent, '未評価');
});

test('corrects sampled outcome odds and randomizes near-equal safe actions', () => {
  const context = load('learn.js');
  const result = JSON.parse(vm.runInContext(`
    forward = () => {
      const p=new Float32Array(VOCAB); p[HIT]=0.6; p[SAFE]=0.4; return p;
    };
    const corrected=choose([], [35], [4]);
    Math.random=()=>0;
    const first=choose([], [35], [0,4]);
    Math.random=()=>0.999;
    const last=choose([], [35], [0,4]);
    JSON.stringify({corrected,first:first.action,last:last.action});
  `, context));
  assert.equal(result.corrected.outcome, 34);
  assert.ok(Math.abs(result.corrected.risk-0.6/2.6)<1e-6);
  assert.equal(result.first, 0);
  assert.equal(result.last, 4);
});

test('128-token weights meet linear and exponential boundaries and exclude older tokens', () => {
  const context = load('learn.js');
  const result = JSON.parse(vm.runInContext(`
    const input = Array(129).fill(0);
    input[128]=1; input[97]=2; input[96]=3; input[1]=4; input[0]=5;
    const x = [...encode(input)];
    onmessage({data:{type:'tokens',tokens:[...input,HIT]}});
    train(129);
    JSON.stringify({x,training:[...features],weights:[...historyWeights]});
  `, context));
  assert.equal(result.weights.length, 128);
  assert.equal(result.x[1], 1);
  assert.ok(Math.abs(result.x[2] - 0.1) < 1e-6);
  assert.ok(Math.abs(result.x[3] - 0.097) < 1e-6);
  assert.ok(Math.abs(result.x[4] - 0.1*Math.pow(0.97,96)) < 1e-6);
  assert.equal(result.x[5], 0);
  assert.deepEqual(result.training, result.x);
  assert.ok(result.weights.every((weight,i,all)=>i===0 || weight<all[i-1]));
});

test('game stores and exports 128-token decision contexts for delayed outcomes', () => {
  const {context} = game();
  const result = JSON.parse(vm.runInContext(`
    left.record(Array(200).fill(36)); left.beginSample(false,2);
    const historyLength=left.history.length;
    left.finishSample(); left.sample();
    JSON.stringify({historyLength,context:left.sampleExamples[0].history});
  `, context));
  assert.equal(result.historyLength, 128);
  assert.equal(result.context.length, 128);
  assert.deepEqual(result.context.slice(-3), [11,35,2]);
});

test('game submits both arenas with independent decision-time contexts', () => {
  const {context, messages} = game();
  vm.runInContext(`
    left.x=45; right.x=315;
    start(); worker.onmessage({data:{type:'choice',id:pending,action:4,risk:0.1,outcome:SAFE}});
    left.shots=right.shots=[10,10,10];
    advance(1.5);
  `, context);
  for (const [source, position] of [['left',8],['right',14]]) {
    const records = messages.filter(message=>message.source===source);
    assert.ok(records.length>0);
    const completed = records.flatMap(message=>message.examples.map(example=>({target:message.tokens[example.offset],history:example.history})));
    assert.equal(completed.length,1);
    assert.equal(completed[0].target,34);
    assert.equal(completed[0].history[0],position);
    assert.ok(completed[0].history.length<=128);
  }
});

test('shared NN uses each arena snapshot for fresh and replay training', () => {
  const context = load('learn.js',{performance:{now:()=>0}});
  const result = JSON.parse(vm.runInContext(`
    onmessage({data:{type:'tokens',source:'left',tokens:[8,35,2,HIT],examples:[{offset:3,history:[8,35,2]}]}});
    onmessage({data:{type:'tokens',source:'right',tokens:[14,35,0,HIT],examples:[{offset:3,history:[14,35,0]}]}});
    const originalTrain=train, inputs=[];
    train=index=>{originalTrain(index);inputs.push({index,x:[...features]});};
    active=true; while(nextTrain<total || replayRemaining>0) work();
    JSON.stringify(inputs);
  `, context));
  assert.ok(result.some(example=>example.index===3));
  assert.ok(result.some(example=>example.index===7));
  assert.ok(result.length>2);
  for (const example of result) {
    assert.ok([3,7].includes(example.index));
    assert.ok(example.x[example.index===3?8:14]>0);
    assert.equal(example.x[example.index===3?14:8],0);
  }
});

test('safe sampling is one in five per arena and source targets require snapshots', () => {
  const context = load('learn.js');
  const result = JSON.parse(vm.runInContext(`
    for(let i=0;i<5;i++) for(const source of ['left','right']) {
      onmessage({data:{type:'tokens',source,tokens:[11,35,4,SAFE],examples:[{offset:3,history:[11,35,4]}]}});
    }
    const selected=[...learnable.slice(0,total)].reduce((a,b)=>a+b,0);
    onmessage({data:{type:'tokens',source:'right',tokens:[HIT]}});
    JSON.stringify({selected,counts:safeSeenBySource,missingContextEligible:learnable[(total-1)%CAPACITY]});
  `, context));
  assert.equal(result.selected,2);
  assert.deepEqual(result.counts,{left:5,right:5});
  assert.equal(result.missingContextEligible,0);
});

test('front spans three player widths, including both 30px boundaries', () => {
  const {context} = game();
  const result = JSON.parse(vm.runInContext(`
    JSON.stringify([-31,-30,-20,0,20,30,31].map(offset=>{
      const token=left.bulletToken({x:left.x+offset,y:300,vx:0,vy:150,speed:150});
      return Math.floor(((token-BULLET)%9)/3);
    }));
  `, context));
  assert.deepEqual(result,[0,1,1,1,1,1,2]);
});

test('observation begins at one third of the screen, shared with entry events', () => {
  const {context} = game();
  const result = JSON.parse(vm.runInContext(`
    left.shots=[10,10,10];
    left.bullets=[{x:150,y:OBSERVATION_Y-1,vx:0,vy:120,speed:150,spent:false}];
    const before=left.observation(); left.step(1/120);
    JSON.stringify({line:OBSERVATION_Y,before,after:left.observation(),events:left.sample()});
  `, context));
  assert.equal(result.line,560/3);
  assert.deepEqual(result.before,[11,35]);
  assert.ok(result.after[1]>=15 && result.after[1]<=32);
  assert.deepEqual(result.events,[result.after[1]]);
});

test('hit-rate rings retain the latest six and sixty completed ten-second frames', () => {
  const {context} = game();
  const result = JSON.parse(vm.runInContext(`
    const rates=new HitRateHistory();
    rates.advance(10,1000);
    for(let hits=1;hits<=60;hits++) rates.advance(10,hits);
    const short=rates.rate(6), long=rates.rate(60);
    rates.advance(9,1000);
    JSON.stringify({short,long,unchanged:rates.rate(6)===short && rates.rate(60)===long,size:rates.size,length:rates.frames.length});
  `, context));
  assert.equal(result.short,345);
  assert.equal(result.long,183);
  assert.equal(result.unchanged,true);
  assert.equal(result.size,60);
  assert.equal(result.length,60);
});

test('hit-rate startup uses available time and changes only on ten-second boundaries afterward', () => {
  const {context} = game();
  const result = JSON.parse(vm.runInContext(`
    const rates=new HitRateHistory(); const empty=rates.rate(6);
    rates.advance(5,2); const partial=rates.rate(6);
    rates.advance(5,1); const first=rates.rate(6);
    rates.advance(9.999,9); const before=rates.rate(6);
    rates.advance(0.001,0);
    JSON.stringify({empty,partial,first,before,second:rates.rate(6)});
  `, context));
  assert.deepEqual(result,{empty:null,partial:24,first:18,before:18,second:36});
});

test('arena collision feeds both hit-rate displays and reset clears their history', () => {
  const {context, elements} = game();
  vm.runInContext(`
    left.shots=[10,10,10];
    left.bullets=[{x:180,y:512,vx:0,vy:150,speed:150,spent:false}];
    left.step(0.02); updateDisplay();
  `, context);
  assert.equal(elements.get('left-hits').textContent,1);
  assert.equal(elements.get('left-rate').textContent,'3000.0');
  assert.equal(elements.get('left-rate-long').textContent,'3000.0');
  elements.get('reset').onclick();
  assert.equal(elements.get('left-rate').textContent,'—');
  assert.equal(elements.get('left-rate-long').textContent,'—');
});
