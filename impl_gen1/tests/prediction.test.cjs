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
function game(extra = {}) {
  const elements = new Map();
  const messages = [];
  const canvas = new Proxy({}, {get: () => () => {}});
  const document = {getElementById(id) {
    if (!elements.has(id)) elements.set(id, {textContent: '', getContext: () => canvas, setAttribute() {}});
    return elements.get(id);
  }};
  return {context: load('game.js', {document, Worker: class {postMessage(m) {messages.push(m);} terminate() {}}, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, ...extra}), elements, messages};
}
test('all token IDs and words round-trip without collisions', () => {
  const {context} = game();
  assert.equal(vm.runInContext(`
    TOKEN_WORDS.length === 64 && WORD_TOKENS.size === 64 &&
      TOKEN_WORDS.every((word, id) => tokenToWord(id) === word && wordToToken(word) === id)
  `, context), true);
  assert.throws(() => vm.runInContext('tokenToWord(64)', context), /Unknown token ID/);
  assert.throws(() => vm.runInContext("wordToToken('不明')", context), /Unknown token word/);
});
test('sentence viewer records ten latest 64-token decisions and refreshes every ten seconds', () => {
  const intervals = [];
  const {context, elements} = game({setInterval: (callback, ms) => intervals.push({callback, ms})});
  const viewer = intervals.find(interval => interval.ms === 10000);
  assert.ok(viewer);
  vm.runInContext(`
    for (let i = 0; i < 12; i++) recordActionSentence([...Array(70).fill(14), i % 6]);
  `, context);
  assert.equal(elements.get('sentence-0').textContent, '—');
  viewer.callback();
  assert.equal(vm.runInContext('actionSentences.length', context), 10);
  assert.equal(elements.get('sentence-0').textContent.split(', ').length, 64);
  assert.equal(elements.get('sentence-0').textContent.split(', ').at(-1), '待機600');
  assert.equal(elements.get('sentence-9').textContent.split(', ').at(-1), '右0.25');
  vm.runInContext("actionSentences.length = 0; updateSentenceViewer()", context);
  assert.equal(elements.get('sentence-0').textContent, '—');
  assert.equal(elements.get('sentence-0').disabled, true);
});
test('right-side choices populate the viewer and reset clears it', () => {
  const {context, elements} = game();
  vm.runInContext(`
    start();
    worker.onmessage({data: {type:'choice', id:pending, action:2, risk:0.1, outcome:SAFE}});
    updateSentenceViewer();
  `, context);
  assert.equal(elements.get('sentence-0').textContent, '自機位置5, 右0.25');
  elements.get('reset').onclick();
  assert.equal(elements.get('sentence-0').textContent, '—');
  assert.equal(elements.get('sentence-0').disabled, true);
});
test('sentence viewer copies the displayed full line and reports clipboard errors', async () => {
  const copied = [];
  const {context, elements} = game({navigator: {clipboard: {writeText: async text => copied.push(text)}}});
  vm.runInContext("recordActionSentence(Array(64).fill(14)); updateSentenceViewer()", context);
  const sentence = elements.get('sentence-0').textContent;
  await elements.get('sentence-0').onclick();
  assert.equal(copied[0], sentence);
  assert.equal(elements.get('sentence-status').textContent, '文章をコピーしました。');
  context.navigator.clipboard.writeText = async () => { throw new Error('denied'); };
  await elements.get('sentence-0').onclick();
  assert.match(elements.get('sentence-status').textContent, /コピーに失敗/);
});
test('bullet density defaults to the quarter-rate baseline and offers half/double', () => {
  const {context, elements} = game();
  vm.runInContext('Math.random = () => 0.5', context);
  assert.equal(vm.runInContext('shotIntervalScale', context), 4);
  const counts = [];
  for (const scale of [2, 4, 8]) {
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
  assert.ok(counts[0] > counts[1]);
  assert.ok(counts[2] < counts[1]);
  assert.ok(Math.abs(counts[0] - counts[1] * 2) <= 3);
  assert.ok(Math.abs(counts[2] - counts[1] / 2) <= 3);
});

test('choice diagnostics return scores for exactly the eligible actions', () => {
  const context = load('learn.js');
  const result = JSON.parse(vm.runInContext('JSON.stringify(choose([], [2,3,4,5]))', context));
  assert.deepEqual(result.scores.map(score=>score.action), [2,3,4,5]);
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
  assert.equal(elements.get('decision-result-2').textContent, '被弾リスク高');
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

test('bullet vocabulary contains all 48 firing position, speed and hit combinations',()=>{
 const {context}=game();
 const words=JSON.parse(vm.runInContext('JSON.stringify(TOKEN_WORDS.slice(BULLET,HIT))',context));
 const expected=[];
 for(let position=1;position<=8;position++) for(const speed of ['SLOW','NORMAL','FAST']) for(const hit of ['被弾','無被弾']) expected.push(position+'_'+speed+'_'+hit);
 assert.deepEqual(words,expected);assert.equal(new Set(words).size,48);
});

test('bullets emit once at the lower-third boundary, never at spawn or afterward', () => {
  const {context} = game();
  const result = JSON.parse(vm.runInContext(`
    left.shots=[0,100,100]; left.step(0.01);
    const spawn=left.sample(); left.shots=[100,100,100];
    const b=left.bullets[0];
    b.x=100; b.y=OBSERVATION_Y-1; b.vx=60; b.vy=120;
    left.step(1/240); const before=left.sample();
    left.step(1/120); const crossing=left.sample();
    const expected=left.bulletToken({...b,x:100.5,y:OBSERVATION_Y});
    left.x=20; left.target=20;
    for(let i=0;i<1000;i++) left.step(0.01);
    JSON.stringify({line:OBSERVATION_Y,spawn,before,crossing,expected,later:left.sample()});
  `, context));
  assert.equal(result.line,560*2/3);
  assert.deepEqual(result.spawn,[]); assert.deepEqual(result.before,[]);
  assert.deepEqual(result.crossing,[result.expected]);
  assert.deepEqual(result.later,[]);
});

test('movement and all wait durations finish at their own boundaries without emitting completion tokens', () => {
  const {context} = game();
  const result = JSON.parse(vm.runInContext(`
    const results=[];
    for(const action of [0,1,2,3,4,5]) {
      left.reset(); left.shots=[100,100,100]; left.beginSample(false,action);
      const duration=left.remaining;
      left.step(duration-0.001); const before=left.sample();
      left.step(0.001); const ended=left.sample();
      left.step(0.1); const after=left.sample();
      results.push({action,duration,before,ended,after,x:left.x});
    }
    JSON.stringify(results);
  `, context));
  for (const r of result) {
    assert.deepEqual(r.before, [10,r.action]);
    assert.deepEqual(r.ended, []);
    assert.deepEqual(r.after, []);
  }
  for (const [action,duration] of [[4,0.3],[5,0.6]]) {
    assert.ok(Math.abs(result[action].duration-duration)<1e-9);
  }
});

test('inference runs at completion while elapsed ticks remain exactly 200ms apart', () => {
  const {context,messages} = game();
  const result = JSON.parse(vm.runInContext(`
    start(); worker.onmessage({data:{type:'choice',id:pending,action:5,risk:0.1,outcome:SAFE}});
    left.shots=right.shots=[100,100,100];
    for(let i=0;i<5;i++) {
      advance(0.2);
      if (pending !== null) worker.onmessage({data:{type:'choice',id:pending,action:5,risk:0.1,outcome:SAFE}});
    }
    JSON.stringify({elapsed,history:right.history,remaining:right.remaining});
  `, context));
  assert.ok(Math.abs(result.elapsed-1)<1e-9);
  assert.equal(result.history.filter(t=>t===63).length,5);
  assert.equal(result.history.filter(t=>t===62).length,0);
  assert.equal(result.history.filter(t=>t===5).length,2);
  assert.ok(Math.abs(result.remaining-0.2)<1e-9);
  assert.equal(messages.filter(m=>m.type==='infer').length,2);
});

test('pause preserves an unfinished action and reset clears histories and clocks', () => {
  const {context,elements} = game();
  vm.runInContext(`
    start(); worker.onmessage({data:{type:'choice',id:pending,action:5,risk:0.1,outcome:SAFE}});
    advance(0.1); stop(); start();
    if (pending !== null) throw new Error('Unexpected inference on resume');
  `,context);
  assert.ok(Math.abs(vm.runInContext('right.remaining',context)-0.5)<1e-9);
  elements.get('reset').onclick();
  assert.equal(vm.runInContext('elapsed+tickClock+advanceRemainder',context),0);
  assert.equal(vm.runInContext('right.history.length',context),0);
});

test('all 64 token weights are reciprocal and older tokens are excluded from training', () => {
  const context=load('learn.js');
  const result=JSON.parse(vm.runInContext(`
    const input=Array.from({length:65},(_,i)=>i%VOCAB);
    const x=[...encode(input)]; train({history:input,target:HIT});
    JSON.stringify({x,training:[...features],weights:[...historyWeights]});
  `,context));
  assert.equal(result.weights.length,64);
  for(let distance=1;distance<=64;distance++) {
    assert.equal(result.weights[distance-1],1/distance);

  }
  const expected=Array(64).fill(0);
  for(let distance=1;distance<=64;distance++) expected[(65-distance)%64]+=1/distance;
  expected.forEach((v,i)=>assert.ok(Math.abs(result.x[i]-v)<1e-6));
  assert.deepEqual(result.training,result.x);
});

test('expanded network learns an outcome and propagates finite gradients through both hidden layers', () => {
  const context=load('learn.js');
  const result=JSON.parse(vm.runInContext(`
    const example={history:[15,63,2,10],target:HIT};
    const initial=forward(encode(example.history))[HIT];
    const old=[w1.slice(),w2.slice(),w3.slice()];
    for(let i=0;i<150;i++) train(example);
    const final=forward(encode(example.history))[HIT];
    JSON.stringify({initial,final,sizes:[w1.length,w2.length,w3.length],
      changed:[w1,w2,w3].map((w,j)=>w.some((v,i)=>v!==old[j][i])),
      finite:[...w1,...w2,...w3,...b1,...b2,...b3].every(Number.isFinite)});
  `,context));
  const hiddenSize=vm.runInContext('HIDDEN',context);
  assert.deepEqual(result.sizes,[64*hiddenSize,hiddenSize*hiddenSize,hiddenSize*64]);
  assert.deepEqual(result.changed,[true,true,true]); assert.equal(result.finite,true);
  assert.ok(result.final>result.initial); assert.ok(result.final>0.9);
});

test('both arenas send actual experience and preserve independent training histories', () => {
  const outgoing=[];
  const learner=load('learn.js',{postMessage:message=>outgoing.push(message),performance:{now:()=>0}});
  // Keep the integration scenario deterministic while using real token collection and training.
  vm.runInContext(`choose=()=>({action:4,risk:0.1,outcome:SAFE,scores:[]});`,learner);
  const {context,messages}=game();
  function pump() {
    while(messages.length || outgoing.length) {
      while(messages.length) {
        learner.incoming=messages.shift();
        vm.runInContext('onmessage({data:incoming})',learner);
      }
      while(outgoing.length) {
        context.incoming=outgoing.shift();
        vm.runInContext('worker.onmessage({data:incoming})',context);
      }
    }
    vm.runInContext('while(trainingQueue.length) work();',learner);
  }
  vm.runInContext('start(); left.shots=right.shots=[100,100,100];',context);
  pump();
  for(let i=0;i<300;i++) {
    context.incoming={type:'tick',dt:1/60};
    vm.runInContext('worker.onmessage({data:incoming})',context);
    pump();
  }
  vm.runInContext('flushSamples();',context); pump();
  for(const source of ['left','right']) {
    const expected=JSON.parse(vm.runInContext(`JSON.stringify(${source}.history)`,context));
    const actual=JSON.parse(vm.runInContext(`JSON.stringify(histories.get('${source}'))`,learner));
    assert.deepEqual(actual,expected);
  }
  assert.equal(vm.runInContext("histories.has('right')",learner),true);
  assert.ok(vm.runInContext('right.history.length',context)>0);
  const result=JSON.parse(vm.runInContext(`JSON.stringify({updates,loss,count:examplesBySource.left.length,queue:trainingQueue.length})`,learner));
  assert.ok(result.updates>0); assert.ok(Number.isFinite(result.loss));
  assert.ok(result.count>0); assert.equal(result.queue,0);
});

test('only six actions are generated, predicted and displayed; wait900 is removed', () => {
  const {context} = game();
  assert.equal(vm.runInContext(`
    Math.random=()=>0.999999;
    left.beginSample(true);
    ACTIONS.length===6 && left.action===5 && left.remaining===0.6 && !WORD_TOKENS.has('待機900')
  `,context),true);
  const learner=load('learn.js');
  assert.deepEqual(JSON.parse(vm.runInContext('JSON.stringify(choose([]).scores.map(s=>s.action))',learner)),[0,1,2,3,4,5]);
  const html=fs.readFileSync(path.join(__dirname,'../src/index.html'),'utf8');
  assert.equal(html.includes('待機 900ms'),false);
  assert.equal(html.includes('decision-row-6'),false);
});

test('40x consumes the complete accelerated tick across inference boundaries without extra drawing', () => {
  let frames=0;
  const {context,elements,messages}=game({requestAnimationFrame:()=>++frames});
  for(let i=0;i<4;i++) elements.get('speed').onclick();
  assert.equal(elements.get('speed').textContent,'速度 ×40');
  vm.runInContext(`
    start(); worker.onmessage({data:{type:'choice',id:pending,action:4,risk:0.1,outcome:SAFE}});
    let draws=0; left.draw=right.draw=()=>draws++;
    worker.onmessage({data:{type:'tick',dt:0.05}});
    while(pending!==null) worker.onmessage({data:{type:'choice',id:pending,action:4,risk:0.1,outcome:SAFE}});
  `,context);
  assert.ok(Math.abs(vm.runInContext('elapsed',context)-2)<1e-9);
  assert.equal(vm.runInContext('draws',context),0);
  assert.equal(frames,1);
  const elapsed=messages.filter(m=>m.type==='ticked'||m.type==='progress').reduce((sum,m)=>sum+m.dt,0);
  assert.ok(Math.abs(elapsed-2)<1e-9);
  elements.get('speed').onclick();
  assert.equal(elements.get('speed').textContent,'速度 ×1');
});


test('each collision emits a hit immediately, including idle hits, with no duplicate at completion', () => {
  const {context}=game();
  const result=JSON.parse(vm.runInContext(`
    left.shots=[100,100,100]; left.beginSample(false,5); left.sample();
    left.bullets=[{x:180,y:512,vx:0,vy:150,speed:150,spent:false}];
    left.step(0.01); const contact=left.sample();
    left.step(0.59); const end=left.sample();
    left.bullets=[{x:180,y:512,vx:0,vy:150,speed:150,spent:false}];
    left.step(0.01); const idle=left.sample();
    JSON.stringify({contact,end,idle,hits:left.hits});
  `,context));
  assert.deepEqual(result.contact,[62]); assert.deepEqual(result.end,[]);
  assert.deepEqual(result.idle,[62]); assert.equal(result.hits,2);
});

test('cancellation records position and next action without a delayed hit or synthetic safe token', () => {
  const {context}=game();
  const result=JSON.parse(vm.runInContext(`
    left.shots=[100,100,100]; left.beginSample(false,3); left.step(0.1);
    left.record([HIT]); const position=left.positionToken();
    left.beginSample(false,4); const cancelled=left.sample();
    left.beginSample(false,4); const continued=left.sample();
    left.step(0.3); const ended=left.sample(); left.finishSample();
    JSON.stringify({position,cancelled,continued,ended,duplicate:left.sample()});
  `,context));
  assert.deepEqual(result.cancelled,[10,3,62,result.position,4]);
  assert.deepEqual(result.continued,[]); assert.deepEqual(result.ended,[]);
  assert.deepEqual(result.duplicate,[]);
});

test('all left and right tokens are targets with independent preceding histories', () => {
  const context=load('learn.js');
  const result=JSON.parse(vm.runInContext(`
    const tokens=[2,14,TIME_200MS,10,HIT,4,TIME_200MS];
    onmessage({data:{type:'tokens',source:'left',tokens:tokens.slice(0,3)}});
    onmessage({data:{type:'tokens',source:'right',tokens:[HIT,15]}});
    onmessage({data:{type:'tokens',source:'left',tokens:tokens.slice(3)}});
    JSON.stringify({total,count:examplesBySource.left.length,right:histories.has('right'),
      rows:Array.from({length:examplesBySource.left.length},(_,i)=>examplesBySource.left.recent(examplesBySource.left.length-1-i)).map(e=>({history:[...e.history],target:e.target}))});
  `,context));
  const tokens=[2,14,63,10,62,4,63];
  assert.equal(result.total,tokens.length+2); assert.equal(result.count,tokens.length);
  assert.equal(result.right,true);
  result.rows.forEach((row,i)=>assert.deepEqual(row,{history:tokens.slice(0,i),target:tokens[i]}));
});

test('all-token ring rotates at 8192 examples and snapshots the preceding 64 tokens', () => {
  const context=load('learn.js');
  const result=JSON.parse(vm.runInContext(`
    const tokens=Array.from({length:CAPACITY+20},(_,i)=>i%VOCAB);
    onmessage({data:{type:'tokens',source:'left',tokens}});
    JSON.stringify({count:examplesBySource.left.length,cursor:examplesBySource.left.cursor,
      newest:{history:[...examplesBySource.left.recent(0).history],target:examplesBySource.left.recent(0).target},
      oldest:{history:[...examplesBySource.left.recent(CAPACITY-1).history],target:examplesBySource.left.recent(CAPACITY-1).target}});
  `,context));
  assert.equal(result.count,8192); assert.equal(result.cursor,20);
  assert.deepEqual(result.newest,{history:Array.from({length:64},(_,i)=>(8147+i)%64),target:8211%64});
  assert.deepEqual(result.oldest,{history:Array.from({length:20},(_,i)=>i),target:20});
});

test('one-second training uses the latest 1000 tokens without requiring hit examples', () => {
  const context=load('learn.js',{performance:{now:()=>0}});
  const result=JSON.parse(vm.runInContext(`
    Math.random=()=>0.999999;
    onmessage({data:{type:'resume'}}); learningTick(1); const empty=trainingQueue.length;
    for(let i=0;i<1100;i++) collect([i%VOCAB],TIME_200MS);
    learningTick(0.999); const early=trainingQueue.length;
    learningTick(0.001);
    const count=trainingQueue.length, newest=[...trainingQueue[0].history], oldest=[...trainingQueue[999].history];
    const targets=[]; train=e=>targets.push(e.target);
    while(trainingQueue.length) work(); learningTick(1);
    const repeated=trainingQueue.length;
    onmessage({data:{type:'pause'}}); learningTick(2);
    JSON.stringify({empty,early,count,newest,oldest,targets,repeated,paused:trainingQueue.length});
  `,context));
  assert.equal(result.empty,0); assert.equal(result.early,0); assert.equal(result.count,1000);
  assert.deepEqual(result.newest,[1099%64]); assert.deepEqual(result.oldest,[100%64]);
  assert.equal(result.targets.length,1000); assert.ok(result.targets.every(t=>t===63));
  assert.equal(result.repeated,1000); assert.equal(result.paused,1000);
});

test('rollout counts only selected time tokens, keeps hit peaks and preserves history',()=>{
 const c=load('learn.js');
 const r=JSON.parse(vm.runInContext(`
 encode=h=>h;let calls=0;
 forward=()=>{calls++;const p=Array(VOCAB).fill(0);
 p[calls===2||calls===5?TIME_200MS:calls===3?HIT:4]=0.7;
 if(calls!==3)p[HIT]=calls===5?0.25:0.1;return p;};
 const history=[10];const score=choose(history,[2]);JSON.stringify({score,history,calls,total});
 `,c));
 assert.equal(r.calls,5);assert.equal(r.score.ticks,2);assert.equal(r.score.tokens,5);
 assert.equal(r.score.risk,0.7);assert.deepEqual(r.history,[10]);assert.equal(r.total,0);
});
test('rollout stops at twenty without a penalty and includes the last prediction',()=>{
 const c=load('learn.js');
 const r=JSON.parse(vm.runInContext(`
 let calls=0;forward=()=>{calls++;const p=Array(VOCAB).fill(0);p[14]=0.6;p[HIT]=calls===20?0.4:0.1;p[TIME_200MS]=0.01;return p;};
 JSON.stringify(choose([],[4]));
 `,c));
 assert.equal(r.tokens,20);assert.equal(r.ticks,0);assert.equal(r.risk,0.4);assert.equal(r.unresolved,0);
});
test('two ticks can finish exactly at twenty and token ID breaks probability ties',()=>{
 const c=load('learn.js');
 const r=JSON.parse(vm.runInContext(`
 let calls=0;forward=()=>{calls++;const p=Array(VOCAB).fill(0);
 if(calls===10||calls===20)p[TIME_200MS]=1;
 else {p[4]=0.5;p[TIME_200MS]=0.5;}return p;};
 JSON.stringify(choose([],[4]));
 `,c));
 assert.equal(r.tokens,20);assert.equal(r.ticks,2);
});
test('firing bins use original spawn coordinates with exact boundaries and preserve hit classes',()=>{
 const {context}=game();
 const result=JSON.parse(vm.runInContext(`
 left.x=180;
 const word=(spawnX,x=180,vx=0,speed=150)=>tokenToWord(left.bulletToken({spawnX,x,y:OBSERVATION_Y,vx,vy:150,speed}));
 JSON.stringify([word(-1),word(0),word(44.999),word(45),word(359.999),word(360),word(400),word(90,180,0,134),word(90,180,0,165),word(90,100),word(90,100,70)]);
 `,context));
 assert.deepEqual(result,['1_NORMAL_被弾','1_NORMAL_被弾','1_NORMAL_被弾','2_NORMAL_被弾','8_NORMAL_被弾','8_NORMAL_被弾','8_NORMAL_被弾','3_SLOW_被弾','3_FAST_被弾','3_NORMAL_無被弾','3_NORMAL_被弾']);
});
test('training snapshots retain the complete vocabulary IDs',()=>{
 const context=load('learn.js');
 const result=JSON.parse(vm.runInContext(`
 onmessage({data:{type:'tokens',source:'left',tokens:[30,31,HIT,TIME_200MS]}});
 JSON.stringify({history:[...examplesBySource.left.recent(0).history],target:examplesBySource.left.recent(0).target});
 `,context));
 assert.deepEqual(result,{history:[30,31,62],target:63});
});

test('uncertain low-risk scores are shown as unresolved rather than safe', () => {
  const {context,elements}=game();
  vm.runInContext(`
    updateDecision({action:4,risk:0.2,unresolved:0.1,outcome:SAFE,
      scores:[{action:4,risk:0.2,unresolved:0.1,outcome:SAFE}]});
  `,context);
  assert.ok(elements.get('decision-summary').textContent.includes('先読み未到達'));
  assert.equal(elements.get('decision-result-4').textContent,'先読み未到達');
});

test('full learning batches shuffle exactly the latest 750 left and 250 right examples', () => {
  const context=load('learn.js');
  const result=JSON.parse(vm.runInContext(`
    for(let i=0;i<1200;i++) for(const source of ['left','right']) collect([i%VOCAB],i%VOCAB,source);
    const batch=latestBatch();
    JSON.stringify({length:batch.length,unique:new Set(batch).size,
      left:batch.filter(e=>e.source==='left').map(e=>e.target),right:batch.filter(e=>e.source==='right').map(e=>e.target)});
  `,context));
  assert.equal(result.length,1000);
  assert.equal(result.unique,1000);
  assert.deepEqual(result.left.sort((a,b)=>a-b),Array.from({length:750},(_,i)=>(1199-i)%64).sort((a,b)=>a-b));
  assert.deepEqual(result.right.sort((a,b)=>a-b),Array.from({length:250},(_,i)=>(1199-i)%64).sort((a,b)=>a-b));
});

test('batch shortages are filled from the other arena without duplicating examples', () => {
  for(const [left,right,expectedLeft,expectedRight] of [[100,1200,100,900],[1200,100,900,100],[0,1200,0,1000],[10,20,10,20]]) {
    const context=load('learn.js');
    context.counts={left,right};
    const result=JSON.parse(vm.runInContext(`
      for(const source of ['left','right']) for(let i=0;i<counts[source];i++) collect([i%VOCAB],TIME_200MS,source);
      const batch=latestBatch();
      JSON.stringify({left:batch.filter(e=>e.source==='left').length,right:batch.filter(e=>e.source==='right').length,unique:new Set(batch).size,total:batch.length});
    `,context));
    assert.equal(result.left,expectedLeft); assert.equal(result.right,expectedRight);
    assert.equal(result.unique,result.total);
  }
});

test('right-hand hit examples retain only right-hand context and enter scheduled training', () => {
  const context=load('learn.js');
  const result=JSON.parse(vm.runInContext(`
    onmessage({data:{type:'tokens',source:'left',tokens:[0,14,TIME_200MS]}});
    onmessage({data:{type:'tokens',source:'right',tokens:[5,15]}});
    onmessage({data:{type:'tokens',source:'left',tokens:[10]}});
    onmessage({data:{type:'tokens',source:'right',tokens:[HIT]}});
    onmessage({data:{type:'resume'}}); learningTick(1);
    const hit=trainingQueue.find(e=>e.source==='right' && e.target===HIT);
    JSON.stringify({history:[...hit.history],left:[...histories.get('left')],right:[...histories.get('right')],total});
  `,context));
  assert.deepEqual(result.history,[5,15]);
  assert.deepEqual(result.left,[0,14,63,10]); assert.deepEqual(result.right,[5,15,62]);
  assert.equal(result.total,7);
});

test('hit loss weight scales the hit gradient only and keeps reported loss unweighted',()=>{
 function run(target,weight){
  const context=load('learn.js'); context.setting={target,weight};
  return JSON.parse(vm.runInContext(`
   for(const w of [w1,w2,w3,b1,b2,b3]) w.fill(0);
   onmessage({data:{type:'hit-loss-weight',weight:setting.weight}});
   train({history:[],target:setting.target});
   JSON.stringify({bias:b3[setting.target],loss,weight:hitLossWeight});
  `,context));
 }
 const baseline=run(62,1);
 for(const weight of [1,5,10,15,20]){
  const hit=run(62,weight),other=run(14,weight);
  assert.ok(Math.abs(hit.bias/baseline.bias-weight)<1e-5);
  assert.ok(Math.abs(other.bias-baseline.bias)<1e-8);
  assert.equal(hit.loss,baseline.loss);assert.equal(hit.weight,weight);
 }
 assert.equal(run(62,3).weight,1);
});
test('hit loss selector sends settings and preserves them across pause and reset',()=>{
 const {context,elements,messages}=game();
 for(const weight of [1,5,10,15,20]){
  elements.get('hit-loss-weight').value=String(weight);
  elements.get('hit-loss-weight').onchange();
  assert.equal(messages.at(-1).type,'hit-loss-weight'); assert.equal(messages.at(-1).weight,weight);
 }
 vm.runInContext('start(); stop();',context);
 elements.get('reset').onclick();
 assert.equal(vm.runInContext('hitLossWeight',context),20);
 assert.equal(messages.filter(m=>m.type==='hit-loss-weight').at(-1).weight,20);
});

test('inference appends current position before each candidate without changing actual history',()=>{
 const {context,messages}=game();
 const result=JSON.parse(vm.runInContext(`
 right.x=40;right.history=[14,63];start();
 JSON.stringify({history:right.history,position:right.positionToken()});
 `,context));
 const request=messages.find(m=>m.type==='infer');
 assert.deepEqual([...request.history],[14,63,result.position]);
 assert.deepEqual(result.history,[14,63]);
 const learner=load('learn.js');learner.input=request.history;
 const seen=JSON.parse(vm.runInContext(`
 let first=null;encode=h=>h;
 forward=h=>{if(first===null) first=[...h]; const p=Array(VOCAB).fill(0);p[HIT]=1;return p;};
 choose(input,[2]);JSON.stringify(first);
 `,learner));
 assert.deepEqual(seen,[14,63,result.position,2]);
});

test('risk retains intermediate peaks from the rollout and selects the lowest peak',()=>{
 for(const peakStep of [1,2,3,4]){
  const context=load('learn.js');context.peakStep=peakStep;
  const result=JSON.parse(vm.runInContext(`
   encode=h=>h;
   forward=h=>{
    const p=Array(VOCAB).fill(0), action=h[0], step=h.length;
    const hit=action===0?(step===peakStep?0.45:0.01):0.2;
    p[HIT]=hit;p[step===2||step===4?TIME_200MS:14]=1-hit;return p;
   };
   JSON.stringify(choose([],[0,2]));
  `,context));
  assert.equal(result.scores[0].risk,0.45);
  assert.equal(result.scores[1].risk,0.2);
  assert.equal(result.action,2);
 }
});

test('every eligible action requests inference exactly at completion and freezes until its response', () => {
  for (const action of [0,1,2,3,4,5]) {
    const {context,messages}=game();
    context.selected=action;
    vm.runInContext(`
      start(); worker.onmessage({data:{type:'choice',id:pending,action:selected,risk:0.1,outcome:SAFE}});
      left.shots=right.shots=[100,100,100];
      const duration=right.remaining;
      advance(duration-0.001);
      if (pending !== null) throw new Error('Inference before completion');
      advance(0.101);
      if (pending === null || right.sampleActive) throw new Error('Missing completion inference');
      if (Math.abs(elapsed-duration)>1e-9) throw new Error('Clock passed completion');
      advance(1);
      if (Math.abs(elapsed-duration)>1e-9) throw new Error('Clock advanced while pending');
      worker.onmessage({data:{type:'choice',id:pending,action:4,risk:0.1,outcome:SAFE}});
      if (Math.abs(elapsed-duration-0.1)>1e-9) throw new Error('Remainder was lost');
    `,context);
    assert.equal(messages.filter(m=>m.type==='infer').length,2);
  }
});

test('each interval discards unfinished work, retains source memory and bounds the queue',()=>{
 const context=load('learn.js',{performance:{now:()=>0}});
 assert.equal(vm.runInContext(`
  for(let i=0;i<1200;i++) for(const source of ['left','right']) collect([i%VOCAB],i%VOCAB,source);
  active=true; learningTick(1);
  const oldQueue=trainingQueue;
  const sentinel={history:[],target:0}; oldQueue[0]=sentinel;
  train=()=>{}; work();
  if(trainingQueue.length!==984) throw new Error('Incorrect processing slice');
  oldQueue[0]=sentinel;
  for(let i=0;i<120;i++) {
    learningTick(1);
    if(trainingQueue.length!==1000 || trainingQueue.includes(sentinel)) throw new Error('Backlog retained');
  }
  trainingQueue!==oldQueue && examplesBySource.left.length===1200 && examplesBySource.right.length===1200;
 `,context),true);
});

test('shuffle changes batch order without losing examples and work consumes from the head',()=>{
 const context=load('learn.js',{performance:{now:()=>0}});
 assert.equal(vm.runInContext(`
  for(let i=0;i<20;i++) collect([i],i);
  Math.random=()=>0.999999; const ordered=latestBatch();
  Math.random=()=>0; const shuffled=latestBatch();
  if(shuffled.every((e,i)=>e===ordered[i])) throw new Error('Batch was not shuffled');
  if(new Set(shuffled).size!==20 || !ordered.every(e=>shuffled.includes(e))) throw new Error('Examples lost');
  trainingQueue=shuffled.slice(); active=true;
  const seen=[]; train=e=>seen.push(e); work();
  seen.length===16 && seen.every((e,i)=>e===shuffled[i]) && trainingQueue[0]===shuffled[16];
 `,context),true);
});

test('spawn position survives travel and is recorded at the observation line',()=>{
 const {context}=game();
 assert.equal(vm.runInContext(`
  left.shots=[0,100,100]; left.step(0.01); left.sample();
  const spawned=left.bullets[0];
  if(spawned.spawnX!==90) throw new Error('Missing firing coordinate');
  spawned.x=250; spawned.y=OBSERVATION_Y-1; spawned.vx=0; spawned.vy=150;
  left.shots=[100,100,100]; left.x=250; left.target=250;
  left.step(0.02);
  const tokens=left.sample();
  tokens.length===1 && tokenToWord(tokens[0]).startsWith('3_') && spawned.spawnX===90;
 `,context),true);
});
