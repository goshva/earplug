// Сообщаем background, что offscreen загружен и слушает
try {
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });
} catch (_) {}
let Fingerprinter=null, matchFingerprints=null, wasmReady=false;
try{
  const mod=await import("./chromaprint_wasm.js");
  await mod.default();
  Fingerprinter=mod.Fingerprinter; matchFingerprints=mod.matchFingerprints; wasmReady=true;
  console.log("Chromaprint WASM loaded");
}catch(e){ console.warn("WASM not found – using stub", e); }

let audioCtx=null, stream=null, monitoring=false, monitorInterval=null;
let activeAdId=null, lastMatchTs=0, currentTabId=null;
const SAMPLE_RATE=44100, WINDOW_SEC=4.0, STEP_SEC=1.3, LEARN_MAX_SEC=20;
const MATCH_SCORE=0.62, MATCH_MIN_DUR=1.6, END_TIMEOUT=2800;

chrome.runtime.onMessage.addListener(msg=>{
  if (msg.type === 'OFFSCREEN_FORCE_STOP') {
    forceStopAll();
    sendResponse?.({ ok: true });
    return true;
  }
  if(msg.type==="OFFSCREEN_LEARN"){
    learnFromStream(msg.streamId).then(r=>chrome.runtime.sendMessage({type:"LEARN_RESULT",...r}));
  }
  if(msg.type==="OFFSCREEN_START_MONITOR") startMonitoring(msg.streamId, msg.tabId);
  if(msg.type==="OFFSCREEN_STOP_MONITOR") stopMonitoring();
});

async function getTabStream(streamId){
  return navigator.mediaDevices.getUserMedia({
    audio:{mandatory:{chromeMediaSource:"tab",chromeMediaSourceId:streamId}}, video:false
  });
}
function pipeToSpeakers(ms){
  if(!audioCtx) audioCtx=new AudioContext({sampleRate:SAMPLE_RATE});
  const s=audioCtx.createMediaStreamSource(ms); s.connect(audioCtx.destination); return s;
}
function floatToInt16(f32){
  const i16=new Int16Array(f32.length);
  for(let i=0;i<f32.length;i++){ const s=Math.max(-1,Math.min(1,f32[i])); i16[i]=s<0?s*0x8000:s*0x7FFF; }
  return i16;
}
async function collectSamples(ms, seconds){
  const ctx=new AudioContext({sampleRate:SAMPLE_RATE});
  const source=ctx.createMediaStreamSource(ms);
  const proc=ctx.createScriptProcessor(4096,1,1);
  const chunks=[]; let total=0; const target=Math.floor(seconds*SAMPLE_RATE);
  return new Promise(resolve=>{
    proc.onaudioprocess=e=>{
      const i16=floatToInt16(e.inputBuffer.getChannelData(0));
      chunks.push(i16); total+=i16.length;
      if(total>=target){
        proc.disconnect(); source.disconnect(); ctx.close();
        const r=new Int16Array(total); let o=0; for(const c of chunks){ r.set(c,o); o+=c.length; }
        resolve(r.subarray(0,target));
      }
    };
    source.connect(proc); proc.connect(ctx.destination);
  });
}
async function makeFingerprint(samples){
  if(!wasmReady||!Fingerprinter){
    const fake=new Uint32Array(8);
    for(let i=0;i<Math.min(samples.length,8);i++) fake[i]=samples[i]&0xffffffff;
    return {raw:fake, compressed:btoa(String.fromCharCode(...new Uint8Array(fake.buffer)))};
  }
  const fp=new Fingerprinter(); fp.start(SAMPLE_RATE,1); fp.consume(samples); fp.finish();
  return {raw:fp.getFingerprint(), compressed:fp.getCompressedFingerprint()};
}
async function learnFromStream(streamId){
  try{
    stream=await getTabStream(streamId); pipeToSpeakers(stream);
    const samples=await collectSamples(stream, LEARN_MAX_SEC);
    stream.getTracks().forEach(t=>t.stop()); stream=null;
    const w=Math.floor(WINDOW_SEC*SAMPLE_RATE), st=Math.floor(STEP_SEC*SAMPLE_RATE), chunks=[];
    for(let start=0; start+w<=samples.length; start+=st){
      const fp=await makeFingerprint(samples.subarray(start,start+w));
      chunks.push({t:+(start/SAMPLE_RATE).toFixed(2), fingerprint:fp.compressed, raw:Array.from(fp.raw)});
    }
    return {ok:true, ad:{id:crypto.randomUUID(), name:`Ролик ${new Date().toLocaleString("ru-RU")}`,
      duration:+(samples.length/SAMPLE_RATE).toFixed(2), chunks, created:Date.now()}};
  }catch(e){ return {ok:false, error:e.message}; }
}
async function startMonitoring(streamId, tabId){
  stopMonitoring(); monitoring=true; currentTabId=tabId; activeAdId=null; lastMatchTs=0;
  stream=await getTabStream(streamId); pipeToSpeakers(stream);
  const {ads=[]}=await chrome.storage.local.get("ads");
  monitorInterval=setInterval(async()=>{
    if(!monitoring) return;
    try{
      const samples=await collectSamples(stream, WINDOW_SEC);
      const current=await makeFingerprint(samples);
      let best=null;
      for(const ad of ads){
        for(const chunk of ad.chunks){
          let score=0, duration=0;
          if(wasmReady&&matchFingerprints){
            const m=(matchFingerprints(new Uint32Array(chunk.raw), current.raw)||[])[0];
            if(m){ score=m.score; duration=m.duration; }
          }else{
            const a=chunk.raw||[], b=Array.from(current.raw); let same=0;
            for(let i=0;i<Math.min(a.length,b.length);i++) if(a[i]===b[i]) same++;
            score=same/Math.max(a.length,1); duration=WINDOW_SEC;
          }
          if(score>=MATCH_SCORE&&duration>=MATCH_MIN_DUR){
            if(!best||score>best.score) best={adId:ad.id, score, duration:ad.duration};
          }
        }
      }
      const now=Date.now();
      if(best){
        if(activeAdId!==best.adId){
          activeAdId=best.adId;
          chrome.runtime.sendMessage({type:"MATCH_FOUND", tabId:currentTabId, adId:best.adId});
        }
        lastMatchTs=now;
      }else if(activeAdId&&now-lastMatchTs>END_TIMEOUT){
        chrome.runtime.sendMessage({type:"MATCH_ENDED", tabId:currentTabId});
        activeAdId=null;
      }
    }catch(e){ console.error(e); }
  }, Math.floor(STEP_SEC*1000));
}
function stopMonitoring(){
  monitoring=false;
  if(monitorInterval){ clearInterval(monitorInterval); monitorInterval=null; }
  if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
  if(activeAdId&&currentTabId) chrome.runtime.sendMessage({type:"MATCH_ENDED", tabId:currentTabId});
  activeAdId=null; currentTabId=null;
}
