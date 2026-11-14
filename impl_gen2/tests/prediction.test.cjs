const {test}=require('node:test');
const assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const src=path.join(__dirname,'../src');
function load(name,extra={}){
 const context=vm.createContext({performance,setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},postMessage(){},...extra});
 const run=n=>vm.runInContext(fs.readFileSync(path.join(src,n),'utf8'),context);
 context.importScripts=n=>{run(n);if(extra.afterImport)extra.afterImport(context);};run('words.js');run(name);return context;
}
function game(){
 const messages=[],elements=new Map(),canvas=new Proxy({},{get:()=>()=>{}});
 const document={getElementById(id){if(!elements.has(id))elements.set(id,{textContent:'',getContext:()=>canvas,setAttribute(){}});return elements.get(id);}};
 return {context:load('game.js',{document,Worker:class{postMessage(m){messages.push(m);}terminate(){}},requestAnimationFrame:()=>1,cancelAnimationFrame(){}}),messages,elements};
}
test('vocabulary is unique and reverse weighted features use exactly 64 words',()=>{
 const c=load('learn.js');assert.equal(vm.runInContext(`
 const h=Array.from({length:65},(_,i)=>i%VOCAB), f=encode(h);
 const expected=new Float32Array(VOCAB);
 for(let i=0;i<64;i++)expected[h[64-i]]+=1/(i+1);
 Words.TOKEN_WORDS.length===VOCAB && new Set(Words.TOKEN_WORDS).size===VOCAB && f.every((v,i)=>v===expected[i]);
 `,c),true);
});
test('language uses coarse arrival lanes, time buckets and no exact collision input',()=>{
 const c=load('learn.js');assert.equal(vm.runInContext(`
 const a=Words.bulletToken({x:180,y:365,vx:0,vy:150,spent:false});
 const b=Words.bulletToken({x:181,y:366,vx:0,vy:150,spent:false});
 a===b && Words.decode(a).lane===4 && Words.bulletToken({x:180,y:100,vx:0,vy:100,spent:false})===null;
 `,c),true);
});
test('coarse teacher expands the player and favors moving away from an arriving lane',()=>{
 const c=load('learn.js');const r=JSON.parse(vm.runInContext(`
 const token=Words.BULLET+(4*6+2)*3+1;
 const h=[token,Words.POSITION+4,Words.AGE];
 JSON.stringify([Words.target(h,0),Words.target(h,1),Words.target(h,2)]);
 `,c));assert.ok(r[2]>r[0]);assert.ok(r[2]>r[1]);
});
test('fresh visual data cannot reach the model before 300ms; current state changes do not leak',()=>{
 const {context:c}=game();assert.equal(vm.runInContext(`
 left.shots=[100,100,100];left.bullets=[{x:180,y:365,vx:0,vy:150,spent:false}];
 left.capture();left.step(0.299);
 const before=left.perceive();
 if(before.some(t=>Words.decode(t)))throw new Error('Fresh bullet leaked');
 left.step(0.002);const delayed=left.perceive();
 if(!delayed.some(t=>Words.decode(t)))throw new Error('Old bullet missing');
 const first=JSON.stringify(delayed);left.x=20;left.bullets=[];left.hits=999;
 JSON.stringify(left.perceive())===first && left.perceived.time<=left.time-0.3+1e-9;
 `,c),true);
});
test('known commands can update proprioception without reading fresh geometry',()=>{
 const {context:c}=game();assert.equal(vm.runInContext(`
 left.shots=[100,100,100];left.act(0);left.step(0.1);const before=left.perceive();
 const p=before.find(t=>t>=POSITION&&t<BULLET);
 left.x=351;const after=left.perceive();
 p===after.find(t=>t>=POSITION&&t<BULLET);
 `,c),true);
});
test('decision clock is 250ms, inference freezes time, and accelerated remainder is retained',()=>{
 const {context:c,messages}=game();vm.runInContext(`
 start();worker.onmessage({data:{type:'choice',id:pending,action:2,risk:0.1,outcome:0,scores:[]}});
 left.shots=right.shots=[100,100,100];advance(0.249);
 if(pending!==null)throw new Error('Early decision');advance(0.751);
 if(Math.abs(elapsed-0.25)>1e-9||pending===null)throw new Error('Clock failed');
 advance(1);if(Math.abs(elapsed-0.25)>1e-9)throw new Error('Pending time advanced');
 while(pending!==null)worker.onmessage({data:{type:'choice',id:pending,action:2,risk:0.1,outcome:0,scores:[]}});
 if(Math.abs(elapsed-1)>1e-9)throw new Error('Remainder lost');
 `,c);assert.equal(messages.filter(m=>m.type==='infer').length,5);
});
test('training is bounded, replaces unfinished work, and preserves quotas',()=>{
 const c=load('learn.js',{performance:{now:()=>0}});
 assert.equal(vm.runInContext(`
 for(let i=0;i<1200;i++)for(const source of ['left','right'])memory[source].push({history:[Words.NONE],action:2,target:0});
 active=true;progress(1);const old=trainingQueue;
 const good=trainingQueue.length===744 && trainingQueue.filter(e=>memory.left.data.includes(e)).length===558;
 train=()=>{};work();const partial=queueIndex===8;
 for(let i=0;i<120;i++){progress(1);if(trainingQueue.length>1000)throw new Error('Backlog');}
 good&&partial&&trainingQueue!==old&&queueIndex===0;
 `,c),true);
});
test('counterfactual training receives only language and creates all three command examples',()=>{
 const c=load('learn.js');assert.equal(vm.runInContext(`
 const h=[Words.BULLET+(4*6+2)*3+1,Words.POSITION+4,Words.AGE];
 onmessage({data:{type:'observation',source:'left',history:h}});
 memory.left.length===3&&memory.right.length===0&&memory.left.recent(0).action===2 && memory.left.recent(0).target>0;
 `,c),true);
});
test('network learns different action risks from weighted language and remains finite',()=>{
 const c=load('learn.js');const r=JSON.parse(vm.runInContext(`
 const h=[Words.BULLET+(4*6+2)*3+1,Words.POSITION+4,Words.AGE];
 const examples=[0,1,2].map(action=>({history:h,action,target:target(h,action)}));
 for(let i=0;i<1500;i++)train(examples[i%3]);
 JSON.stringify({scores:[0,1,2].map(a=>forward(encode(h),a)),finite:[...w1,...w2,...b1,...b2].every(Number.isFinite)});
 `,c));assert.equal(r.finite,true);assert.ok(r.scores[2]>r.scores[0]+0.3);assert.ok(r.scores[2]>r.scores[1]+0.3);
});
test('Worker and game exchange observations, choices and training progress without errors',()=>{
 const outgoing=[],learner=load('learn.js',{postMessage:m=>outgoing.push(m),performance:{now:()=>0}});
 const {context:c,messages,elements}=game();
 function pump(){let count=0;while(messages.length||outgoing.length){if(count++>10000)throw Error('Message loop');while(messages.length){learner.input=messages.shift();vm.runInContext('onmessage({data:input})',learner);}while(outgoing.length){c.input=outgoing.shift();vm.runInContext('worker.onmessage({data:input})',c);}}}
 vm.runInContext('start()',c);pump();
 for(let i=0;i<120;i++){c.input={type:'tick',dt:0.05};vm.runInContext('worker.onmessage({data:input})',c);pump();vm.runInContext('work()',learner);}
 assert.ok(vm.runInContext('updates',learner)>0);assert.ok(vm.runInContext('memory.right.length',learner)>0);
 vm.runInContext('stop();start()',c);pump();elements.get('reset').onclick();pump();assert.equal(vm.runInContext('elapsed',c),0);
});

test('relative words share avoidance across screen positions and use only quantized old lanes',()=>{
 const c=load('learn.js');assert.equal(vm.runInContext(`
 const near=Words.RELATIVE+4*6+2;
 const h1=[near,Words.POSITION+2,Words.AGE],h2=[near,Words.POSITION+5,Words.AGE];
 [0,1,2].every(a=>Math.abs(target(h1,a)-target(h2,a))<1e-8) && target(h1,2)>target(h1,0);
 `,c),true);
});
test('curriculum is bounded and mixed with online experience without extra backlog',()=>{
 const c=load('learn.js',{performance:{now:()=>0}});
 assert.equal(vm.runInContext(`
 prepare();const count=updates;
 prepare();if(updates!==count||count!==24000)throw new Error('Curriculum repeated');
 if(curriculum.length!==1008)throw new Error('Curriculum size');
 for(let i=0;i<1200;i++)for(const source of ['left','right'])memory[source].push({history:[Words.NONE],action:2,target:0});
 const batch=latestBatch();
 batch.length===1000&&batch.filter(e=>curriculum.includes(e)).length===256&&
 batch.filter(e=>memory.left.data.includes(e)).length===558&&batch.filter(e=>memory.right.data.includes(e)).length===186;
 `,c),true);
});
test('inference uses learned heads without calling the coarse teacher',()=>{
 const c=load('learn.js',{afterImport:ctx=>vm.runInContext("Words.target=()=>{throw new Error('Teacher used for selection');};",ctx)});assert.equal(vm.runInContext(`
 const result=choose([Words.NONE,Words.POSITION+4,Words.AGE]);
 result.scores.length===3&&result.scores.every(s=>s.risk>=0&&s.risk<=1);
 `,c),true);
});
