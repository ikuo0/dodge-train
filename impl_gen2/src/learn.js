'use strict';
importScripts('words.js');
const {ACTIONS,VOCAB,HISTORY,encode,target}=Words;
const HIDDEN=48,CAPACITY=8192;
const w1=Float32Array.from({length:VOCAB*HIDDEN},()=> (Math.random()*2-1)*Math.sqrt(6/(VOCAB+HIDDEN)));
const b1=new Float32Array(HIDDEN),w2=Float32Array.from({length:HIDDEN*3},()=> (Math.random()*2-1)*0.1);
const b2=new Float32Array(3);
let updates=0,loss=0,total=0,active=false,timer=null,clockTimer=null,lastTick=0,tickPending=false,learnClock=0,lastStats=0;
let trainingQueue=[],queueIndex=0;
const hidden=new Float32Array(HIDDEN),features=new Float32Array(VOCAB);
class Ring {
 constructor(){this.data=new Array(CAPACITY);this.length=0;this.cursor=0;}
 push(e){this.data[this.cursor]=e;this.cursor=(this.cursor+1)%CAPACITY;this.length=Math.min(CAPACITY,this.length+1);}
 recent(i){return this.data[(this.cursor-1-i+CAPACITY)%CAPACITY];}
}
const memory={left:new Ring(),right:new Ring()};
function forward(x,action=2){
 for(let j=0;j<HIDDEN;j++) {let sum=b1[j];for(let i=0;i<VOCAB;i++)sum+=x[i]*w1[i*HIDDEN+j];hidden[j]=Math.tanh(sum);}
 let logit=b2[action];for(let j=0;j<HIDDEN;j++)logit+=hidden[j]*w2[j*3+action];
 return 1/(1+Math.exp(-Math.max(-30,Math.min(30,logit))));
}
function train(e){
 encode(e.history,features);const p=forward(features,e.action),d=p-e.target,rate=0.01;
 const error=-e.target*Math.log(Math.max(1e-9,p))-(1-e.target)*Math.log(Math.max(1e-9,1-p));
 loss=updates?loss*0.98+error*0.02:error;
 for(let j=0;j<HIDDEN;j++) {
  const g=Math.max(-1,Math.min(1,d*w2[j*3+e.action]*(1-hidden[j]*hidden[j])));
  w2[j*3+e.action]-=rate*d*hidden[j];b1[j]-=rate*g;
  for(let i=0;i<VOCAB;i++)w1[i*HIDDEN+j]-=rate*g*features[i];
 }
 b2[e.action]-=rate*d;updates++;
}

let prepared=false;
const curriculum=[];
function prepare() {
 if(prepared)return;prepared=true;
 // A reproducible curriculum made only from the same coarse word language.
 // Teach spatial symmetries before rare online encounters, not exact physics.
 const examples=curriculum;
 for(let pos=0;pos<8;pos++)for(let offset=-3;offset<=3;offset++)for(let eta=0;eta<6;eta++) {
  const history=[Words.RELATIVE+(offset+4)*6+eta,Words.POSITION+pos,Words.AGE];
  for(let action=0;action<3;action++)examples.push({history,action,target:target(history,action)});
 }
 for(let i=0;i<24000;i++)train(examples[Math.floor(Math.random()*examples.length)]);
}

function latestBatch(){
 const batch=[];
 for(const [source,quota] of [['left',558],['right',186]])for(let i=0;i<Math.min(quota,memory[source].length);i++)batch.push(memory[source].recent(i));
 for(let i=0;i<256&&curriculum.length;i++)batch.push(curriculum[Math.floor(Math.random()*curriculum.length)]);
 for(let i=batch.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[batch[i],batch[j]]=[batch[j],batch[i]];}
 return batch;
}
function schedule(){if(active&&timer===null&&queueIndex<trainingQueue.length)timer=setTimeout(work,4);}
function work(){
 timer=null;if(!active)return;
 const start=performance.now();let count=0;
 while(queueIndex<trainingQueue.length&&count++<8&&performance.now()-start<2)train(trainingQueue[queueIndex++]);
 if(queueIndex===trainingQueue.length){trainingQueue=[];queueIndex=0;}
 report();schedule();
}
function report(){if(performance.now()-lastStats>=500){postMessage({type:'stats',tokens:total,updates,loss,queued:trainingQueue.length-queueIndex});lastStats=performance.now();}}
function progress(dt){
 if(!active)return;learnClock+=dt;
 if(learnClock>=1){learnClock%=1;trainingQueue=latestBatch();queueIndex=0;}
 schedule();report();
}
function choose(history,actions=[0,1,2]){
 const scores=actions.map(action=>({action,risk:forward(encode(history,features),action)}));
 const min=Math.min(...scores.map(s=>s.risk));
 // Differences below two percentage points are not meaningful enough to lock
 // onto one command. A small random policy also keeps fresh experience diverse.
 const best=Math.random()<0.05?scores:scores.filter(s=>s.risk<=min+0.02);
 const selected=best[Math.floor(Math.random()*best.length)];
 return {...selected,scores:scores.map(s=>({...s,outcome:s.risk>0.5?1:0})),outcome:selected.risk>0.5?1:0};
}
onmessage=({data})=>{
 if(data.type==='observation'){
  if(!memory[data.source])return;
  const history=data.history.slice(-HISTORY);encode(history);total+=history.length;
  // All commands learn from the SAME old, quantized observation. The teacher
  // receives no live bullet coordinates, collision outcomes or simulator state.
  for(let action=0;action<ACTIONS.length;action++)memory[data.source].push({history,action,target:target(history,action)});
 }else if(data.type==='infer')postMessage({type:'choice',id:data.id,...choose(data.history,data.actions)});
 else if(data.type==='resume'){
  prepare();
  active=true;schedule();lastTick=performance.now();
  if(clockTimer===null)clockTimer=setInterval(()=>{const now=performance.now();if(!tickPending){tickPending=true;postMessage({type:'tick',dt:Math.min(0.05,(now-lastTick)/1000)});}lastTick=now;},1000/60);
 }else if(data.type==='pause'){active=false;clearTimeout(timer);timer=null;clearInterval(clockTimer);clockTimer=null;tickPending=false;}
 else if(data.type==='ticked'){tickPending=false;progress(data.dt||0);}
 else if(data.type==='progress')progress(data.dt||0);
};
