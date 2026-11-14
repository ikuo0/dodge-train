'use strict';
// Shared, quantized language. No exact geometry crosses the Worker boundary.
globalThis.Words = (() => {
  const ACTIONS = ['左 250ms', '右 250ms', '待機 250ms'];
  const POSITION = 3, BULLET = 11, ETA = [0.125, 0.375, 0.625, 0.875, 1.25, 1.75];
  const NONE = BULLET + 8 * ETA.length * 3, AGE = NONE + 1, RELATIVE = AGE + 1;
  const TOKEN_WORDS = ['左移動250', '右移動250', '待機250',
    ...Array.from({length:8},(_,i)=>`自機位置${i+1}`),
    ...Array.from({length:8},(_,lane)=>ETA.flatMap((eta,t)=>['左向き','直進','右向き'].map(direction=>`到達区画${lane+1}_残り${Math.round(eta*1000)}ms_${direction}`))).flat(),
    '弾なし','観測遅延300ms',
    ...Array.from({length:9},(_,i)=>ETA.map(eta=>`相対到達${i-4}_残り${Math.round(eta*1000)}ms`)).flat()];
  const VOCAB = TOKEN_WORDS.length, HISTORY = 64;
  const bin = x => Math.max(0,Math.min(7,Math.floor(x/45)));
  function bulletToken(b) {
    const eta=(513-b.y)/b.vy;
    if(b.spent || b.vy<=0 || eta<0 || eta>2) return null;
    const t=eta<0.25?0:eta<0.5?1:eta<0.75?2:eta<1?3:eta<1.5?4:5;
    const lane=bin(b.x+b.vx*eta), direction=b.vx < -20 ? 0 : b.vx > 20 ? 2 : 1;
    return BULLET+(lane*ETA.length+t)*3+direction;
  }
  function decode(token) {
    if(token>=RELATIVE && token<RELATIVE+54) {
      const value=token-RELATIVE;return {offset:Math.floor(value/6)-4,eta:ETA[value%6]};
    }
    if(token<BULLET || token>=NONE) return null;
    const value=Math.floor((token-BULLET)/3);
    return {lane:Math.floor(value/ETA.length),eta:ETA[value%ETA.length]};
  }
  function encode(history, output=new Float32Array(VOCAB)) {
    output.fill(0);
    for(let i=0;i<Math.min(HISTORY,history.length);i++) {
      const token=history[history.length-1-i];
      if(!Number.isInteger(token)||token<0||token>=VOCAB) throw new RangeError('Invalid token');
      output[token]+=1/(i+1);
    }
    return output;
  }
  // A deliberately coarse teacher: expanded radius, lane-width uncertainty,
  // rounded arrival times, and only a delayed language observation.
  function target(history,action) {
    const pos=[...history].reverse().find(t=>t>=POSITION&&t<BULLET);
    if(pos===undefined) return 0.5;
    const x=(pos-POSITION+0.5)*45, velocity=action===0?-180:action===1?180:0;
    let risk=0;
    for(const token of history) {
      const b=decode(token); if(!b) continue;
      const arrival=b.eta-0.3;
      if(arrival < -0.125 || arrival > 1.5) continue;
      // Include temporal quantization uncertainty; planning assumes at most
      // 500ms of this command, followed by holding position.
      for(const jitter of [-0.125,0,0.125]) {
        const t=Math.max(0,Math.min(0.5,arrival+jitter));
        const player=Math.max(9,Math.min(351,x+velocity*t));
        const distance=Math.abs((b.offset===undefined?(b.lane+0.5)*45:x+b.offset*45)-player);
        // Expanded player 18px + bullet 4px, blurred by a 45px lane.
        const proximity=Math.max(0,Math.min(1,(22+22.5-distance)/22.5));
        risk=Math.max(risk,proximity);
      }
    }
    return risk;
  }
  return {ACTIONS,POSITION,BULLET,NONE,AGE,RELATIVE,VOCAB,HISTORY,TOKEN_WORDS,bin,bulletToken,decode,encode,target};
})();
