// Reproducible headless smoke experiment, not a browser CPU benchmark.
const fs=require('fs'),vm=require('vm'),path=require('path');
const src=path.join(__dirname,'../src');
function random(seed){return()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};}
function context(seed){const math=Object.create(Math);math.random=random(seed);return vm.createContext({Math:math,performance:{now:()=>0},setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},postMessage(){}});}
function run(seed,seconds){
 const c=context(seed),l=context(seed+1000);
 const read=(ctx,name)=>vm.runInContext(fs.readFileSync(path.join(src,name),'utf8'),ctx);
 l.importScripts=n=>read(l,n);read(l,'learn.js');
 c.document={getElementById:()=>({getContext:()=>new Proxy({},{get:()=>()=>{}}),setAttribute(){}})};
 c.Worker=class{postMessage(){} terminate(){}};c.requestAnimationFrame=()=>1;c.cancelAnimationFrame=()=>{};
 read(c,'words.js');read(c,'game.js');
 vm.runInContext('prepare()',l);
 vm.runInContext('left.beginSample(true);right.beginSample(false,2)',c);
 for(let n=0;n<seconds*4;n++){
  const observations=vm.runInContext(`for(let i=0;i<30;i++){left.step(1/120);right.step(1/120);} [left.perceive(),right.perceive()]`,c);
  for(const [i,source] of ['left','right'].entries()) {l.message={type:'observation',source,history:Array.from(observations[i])};vm.runInContext('onmessage({data:message})',l);}
  if(n%4===3)vm.runInContext('trainingQueue=latestBatch();queueIndex=0;',l);
  // Fixed compute budget: 128 example updates per simulated second.
  vm.runInContext('for(let i=0;i<32&&queueIndex<trainingQueue.length;i++)train(trainingQueue[queueIndex++]);',l);
  l.history=Array.from(observations[1]);c.selected=vm.runInContext(process.argv.includes('--teacher')?'(()=>{const scores=[0,1,2].map(a=>target(history,a));const m=Math.min(...scores);const best=[0,1,2].filter(a=>scores[a]<=m+0.02);return best[Math.floor(Math.random()*best.length)];})()':'choose(history).action',l);
  vm.runInContext('left.beginSample(true);right.beginSample(false,selected)',c);
 }
 const result=JSON.parse(vm.runInContext('JSON.stringify({random:left.hits,learned:right.hits})',c));
 result.seed=seed;result.seconds=seconds;result.updates=vm.runInContext('updates',l);return result;
}
const seconds=Number(process.argv[2]||180),seeds=[1,2,3];
const results=seeds.map(seed=>run(seed,seconds));console.log(JSON.stringify(results,null,2));
