/**
 * Offscreen document – захват звука вкладки + Chromaprint
 *
 * ВАЖНО: положите сюда файлы WASM:
 *   chromaprint_wasm.js
 *   chromaprint_wasm_bg.wasm
 * (из пакета rusty-chromaprint-wasm или chromaprint-wasm)
 */

import init, { Fingerprinter, matchFingerprints } from './chromaprint_wasm.js';

let audioCtx = null;
let stream = null;
let monitoring = false;
let monitorInterval = null;
let activeAdId = null;
let lastMatchTs = 0;
let currentTabId = null;

const SAMPLE_RATE = 44100;
const WINDOW_SEC = 4.0;      // размер окна для fingerprint
const STEP_SEC = 1.3;        // шаг скользящего окна
const LEARN_MAX_SEC = 20;    // макс. длина записи ролика
const MATCH_SCORE = 0.62;    // порог совпадения
const MATCH_MIN_DUR = 1.6;   // минимальная длительность совпадения (сек)
const END_TIMEOUT = 2800;    // через сколько мс без матчей считаем ролик законченным

await init();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OFFSCREEN_LEARN') {
    learnFromStream(msg.streamId).then(result => {
      chrome.runtime.sendMessage({ type: 'LEARN_RESULT', ...result });
    });
    return false;
  }
  if (msg.type === 'OFFSCREEN_START_MONITOR') {
    startMonitoring(msg.streamId, msg.tabId);
  }
  if (msg.type === 'OFFSCREEN_STOP_MONITOR') {
    stopMonitoring();
  }
});

async function getTabStream(streamId) {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });
}

function pipeToSpeakers(mediaStream) {
  if (!audioCtx) audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = audioCtx.createMediaStreamSource(mediaStream);
  source.connect(audioCtx.destination);
  return source;
}

function floatToInt16(float32) {
  const i16 = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
  }
  return i16;
}

async function collectSamples(mediaStream, seconds) {
  const ctx = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = ctx.createMediaStreamSource(mediaStream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);

  const chunks = [];
  let total = 0;
  const target = Math.floor(seconds * SAMPLE_RATE);

  return new Promise((resolve) => {
    processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const i16 = floatToInt16(input);
      chunks.push(i16);
      total += i16.length;
      if (total >= target) {
        processor.disconnect();
        source.disconnect();
        ctx.close();
        const result = new Int16Array(total);
        let off = 0;
        for (const c of chunks) {
          result.set(c, off);
          off += c.length;
        }
        resolve(result.subarray(0, target));
      }
    };
    source.connect(processor);
    processor.connect(ctx.destination);
  });
}

async function makeFingerprint(samples) {
  const fp = new Fingerprinter();
  fp.start(SAMPLE_RATE, 1);
  fp.consume(samples);
  fp.finish();
  return {
    raw: fp.getFingerprint(),          // Uint32Array
    compressed: fp.getCompressedFingerprint()
  };
}

/**
 * LEARN: записываем длинный кусок и режем на перекрывающиеся окна
 */
async function learnFromStream(streamId) {
  try {
    stream = await getTabStream(streamId);
    pipeToSpeakers(stream);

    const samples = await collectSamples(stream, LEARN_MAX_SEC);
    stream.getTracks().forEach(t => t.stop());
    stream = null;

    const windowSamples = Math.floor(WINDOW_SEC * SAMPLE_RATE);
    const stepSamples = Math.floor(STEP_SEC * SAMPLE_RATE);
    const chunks = [];

    for (let start = 0; start + windowSamples <= samples.length; start += stepSamples) {
      const slice = samples.subarray(start, start + windowSamples);
      const fp = await makeFingerprint(slice);
      chunks.push({
        t: +(start / SAMPLE_RATE).toFixed(2),
        fingerprint: fp.compressed,
        raw: Array.from(fp.raw)
      });
    }

    const ad = {
      id: crypto.randomUUID(),
      name: `Ролик ${new Date().toLocaleString('ru-RU')}`,
      duration: +(samples.length / SAMPLE_RATE).toFixed(2),
      chunks,
      created: Date.now()
    };

    return { ok: true, ad };
  } catch (e) {
    console.error(e);
    return { ok: false, error: e.message };
  }
}

/**
 * MONITOR: скользящее окно + поиск по всем кускам всех роликов
 */
async function startMonitoring(streamId, tabId) {
  stopMonitoring();
  monitoring = true;
  currentTabId = tabId;
  activeAdId = null;
  lastMatchTs = 0;

  stream = await getTabStream(streamId);
  pipeToSpeakers(stream);

  const { ads = [] } = await chrome.storage.local.get('ads');

  monitorInterval = setInterval(async () => {
    if (!monitoring) return;

    try {
      // Берём последние WINDOW_SEC секунд
      const samples = await collectSamples(stream, WINDOW_SEC);
      const current = await makeFingerprint(samples);

      let best = null;

      for (const ad of ads) {
        for (const chunk of ad.chunks) {
          const matches = matchFingerprints(
            new Uint32Array(chunk.raw),
            current.raw
          );
          if (matches && matches.length) {
            const m = matches[0];
            if (m.score >= MATCH_SCORE && m.duration >= MATCH_MIN_DUR) {
              if (!best || m.score > best.score) {
                best = { adId: ad.id, score: m.score, duration: ad.duration };
              }
            }
          }
        }
      }

      const now = Date.now();

      if (best) {
        if (activeAdId !== best.adId) {
          // Новый ролик начался
          activeAdId = best.adId;
          chrome.runtime.sendMessage({
            type: 'MATCH_FOUND',
            tabId: currentTabId,
            adId: best.adId
          });
        }
        lastMatchTs = now;
      } else if (activeAdId && now - lastMatchTs > END_TIMEOUT) {
        // Совпадений давно нет > ролик закончился
        chrome.runtime.sendMessage({
          type: 'MATCH_ENDED',
          tabId: currentTabId
        });
        activeAdId = null;
      }
    } catch (e) {
      console.error('monitor tick error', e);
    }
  }, Math.floor(STEP_SEC * 1000));
}

function stopMonitoring() {
  monitoring = false;
  if (monitorInterval) {
    clearInterval(monitorInterval);
    monitorInterval = null;
  }
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  if (activeAdId && currentTabId) {
    chrome.runtime.sendMessage({ type: 'MATCH_ENDED', tabId: currentTabId });
  }
  activeAdId = null;
  currentTabId = null;
}
