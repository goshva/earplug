# ============================================================
#  Создаёт папку Chrome-расширения "Ad Mute by Fingerprint"
#  с полной логикой: скользящие окна + куски разной длины
# ============================================================

$extDir = "AdMuteFingerprint"
New-Item -ItemType Directory -Force -Path $extDir | Out-Null
New-Item -ItemType Directory -Force -Path "$extDir\icons" | Out-Null

Write-Host "Создаю файлы расширения в папке: $extDir" -ForegroundColor Cyan

# --------------------------------------------------
# 1. manifest.json
# --------------------------------------------------
@'
{
  "manifest_version": 3,
  "name": "Ad Mute by Fingerprint",
  "version": "1.1.0",
  "description": "Автоматически мьютит уже виденные рекламные ролики любой длины по аудио-отпечаткам (Chromaprint). Слепки можно экспортировать на другое устройство.",
  "permissions": [
    "tabCapture",
    "tabs",
    "storage",
    "offscreen",
    "activeTab"
  ],
  "host_permissions": [
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup.html",
    "default_title": "Ad Mute by Fingerprint",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png",
      "128": "icons/icon128.png"
    }
  },
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  }
}
'@ | Set-Content -Path "$extDir\manifest.json" -Encoding UTF8

# --------------------------------------------------
# 2. popup.html
# --------------------------------------------------
@'
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Ad Mute</title>
  <style>
    * { box-sizing: border-box; }
    body {
      width: 340px;
      margin: 0;
      padding: 14px;
      font-family: system-ui, -apple-system, sans-serif;
      background: #1e1e1e;
      color: #e0e0e0;
    }
    h2 { margin: 0 0 10px; font-size: 16px; color: #fff; }
    .status {
      font-size: 12px;
      padding: 6px 8px;
      background: #2a2a2a;
      border-radius: 6px;
      margin-bottom: 10px;
      color: #aaa;
    }
    button {
      width: 100%;
      padding: 9px;
      margin: 4px 0;
      border: none;
      border-radius: 6px;
      font-size: 13px;
      cursor: pointer;
      background: #333;
      color: #eee;
    }
    button:hover { background: #444; }
    button.primary { background: #1a73e8; color: white; }
    button.primary:hover { background: #1557b0; }
    button.danger { background: #c5221f; color: white; }
    button.danger:hover { background: #a50e0e; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    hr { border: none; border-top: 1px solid #333; margin: 12px 0; }
    h3 { font-size: 13px; margin: 8px 0 6px; color: #bbb; }
    .list {
      max-height: 200px;
      overflow-y: auto;
      font-size: 12px;
    }
    .item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 6px 4px;
      border-bottom: 1px solid #333;
    }
    .item span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .item button {
      width: auto;
      padding: 3px 8px;
      margin: 0 0 0 6px;
      font-size: 11px;
      background: #444;
    }
    .row { display: flex; gap: 6px; }
    .row button { flex: 1; }
  </style>
</head>
<body>
  <h2>Ad Mute by Fingerprint</h2>
  <div class="status" id="status">Готово</div>

  <button class="primary" id="learnBtn">Записать текущий ролик</button>
  <div class="row">
    <button id="startBtn">Старт мониторинга</button>
    <button id="stopBtn">Стоп</button>
  </div>

  <hr>
  <div class="row">
    <button id="exportBtn">Экспорт JSON</button>
    <button id="importBtn">Импорт JSON</button>
  </div>
  <input type="file" id="importFile" accept=".json" style="display:none">

  <h3>Сохранённые ролики:</h3>
  <div class="list" id="list"></div>

  <script type="module" src="popup.js"></script>
</body>
</html>
'@ | Set-Content -Path "$extDir\popup.html" -Encoding UTF8

# --------------------------------------------------
# 3. popup.js
# --------------------------------------------------
@'
const statusEl = document.getElementById('status');
const listEl   = document.getElementById('list');

function setStatus(text, isError = false) {
  statusEl.textContent = text;
  statusEl.style.color = isError ? '#f28b82' : '#aaa';
}

async function refreshList() {
  const { ads = [] } = await chrome.storage.local.get('ads');
  listEl.innerHTML = '';
  if (ads.length === 0) {
    listEl.innerHTML = '<div style="color:#666;padding:8px 0">Пока нет сохранённых роликов</div>';
    return;
  }
  ads.forEach((ad, i) => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `
      <span title="${ad.name}">${ad.name} (${ad.duration?.toFixed(1) || '?'}с, ${ad.chunks?.length || 0} кусков)</span>
      <button data-i="${i}">?</button>
    `;
    div.querySelector('button').onclick = async () => {
      ads.splice(i, 1);
      await chrome.storage.local.set({ ads });
      refreshList();
    };
    listEl.appendChild(div);
  });
}

document.getElementById('learnBtn').onclick = async () => {
  setStatus('Записываю ролик… (до 20 сек или пока не остановите)');
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return setStatus('Нет активной вкладки', true);

  chrome.runtime.sendMessage({ type: 'LEARN', tabId: tab.id }, (res) => {
    if (chrome.runtime.lastError) {
      setStatus('Ошибка: ' + chrome.runtime.lastError.message, true);
      return;
    }
    if (res?.ok) {
      setStatus(`Ролик сохранён (${res.duration?.toFixed(1)}с, ${res.chunks} кусков)`);
      refreshList();
    } else {
      setStatus('Ошибка: ' + (res?.error || 'unknown'), true);
    }
  });
};

document.getElementById('startBtn').onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return setStatus('Нет активной вкладки', true);
  chrome.runtime.sendMessage({ type: 'START_MONITOR', tabId: tab.id });
  setStatus('Мониторинг запущен на текущей вкладке');
};

document.getElementById('stopBtn').onclick = () => {
  chrome.runtime.sendMessage({ type: 'STOP_MONITOR' });
  setStatus('Мониторинг остановлен');
};

document.getElementById('exportBtn').onclick = async () => {
  const { ads = [] } = await chrome.storage.local.get('ads');
  const blob = new Blob([JSON.stringify(ads, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `ad-fingerprints-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`Экспортировано ${ads.length} роликов`);
};

document.getElementById('importBtn').onclick = () => {
  document.getElementById('importFile').click();
};

document.getElementById('importFile').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error('Ожидался массив роликов');
    await chrome.storage.local.set({ ads: data });
    setStatus(`Импортировано ${data.length} роликов`);
    refreshList();
  } catch (err) {
    setStatus('Ошибка импорта: ' + err.message, true);
  }
  e.target.value = '';
};

refreshList();
'@ | Set-Content -Path "$extDir\popup.js" -Encoding UTF8

# --------------------------------------------------
# 4. background.js
# --------------------------------------------------
@'
let monitoring = false;
let currentTabId = null;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'LEARN') {
    handleLearn(msg.tabId).then(sendResponse);
    return true;
  }
  if (msg.type === 'START_MONITOR') {
    startMonitor(msg.tabId).then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === 'STOP_MONITOR') {
    stopMonitor();
    sendResponse({ ok: true });
  }
});

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Continuous audio fingerprinting of tab audio for ad detection'
  });
}

async function handleLearn(tabId) {
  try {
    await ensureOffscreen();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

    return new Promise((resolve) => {
      const listener = (msg) => {
        if (msg.type === 'LEARN_RESULT') {
          chrome.runtime.onMessage.removeListener(listener);
          if (msg.ok) {
            chrome.storage.local.get('ads', ({ ads = [] }) => {
              ads.push(msg.ad);
              chrome.storage.local.set({ ads }, () => {
                resolve({
                  ok: true,
                  duration: msg.ad.duration,
                  chunks: msg.ad.chunks.length
                });
              });
            });
          } else {
            resolve({ ok: false, error: msg.error });
          }
        }
      };
      chrome.runtime.onMessage.addListener(listener);

      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_LEARN',
        streamId
      });
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function startMonitor(tabId) {
  monitoring = true;
  currentTabId = tabId;
  await ensureOffscreen();
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_START_MONITOR',
    streamId,
    tabId
  });
}

function stopMonitor() {
  monitoring = false;
  currentTabId = null;
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_MONITOR' });
}

// Получаем сигнал о совпадении от offscreen
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'MATCH_FOUND' && monitoring && msg.tabId === currentTabId) {
    chrome.tabs.update(msg.tabId, { muted: true });
  }
  if (msg.type === 'MATCH_ENDED' && msg.tabId === currentTabId) {
    chrome.tabs.update(msg.tabId, { muted: false });
  }
});
'@ | Set-Content -Path "$extDir\background.js" -Encoding UTF8

# --------------------------------------------------
# 5. offscreen.html
# --------------------------------------------------
@'
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body>
  <script type="module" src="offscreen.js"></script>
</body>
</html>
'@ | Set-Content -Path "$extDir\offscreen.html" -Encoding UTF8

# --------------------------------------------------
# 6. offscreen.js  (главная логика + скользящие окна)
# --------------------------------------------------
@'
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
'@ | Set-Content -Path "$extDir\offscreen.js" -Encoding UTF8

# --------------------------------------------------
# 7. README.md
# --------------------------------------------------
@'
# Ad Mute by Fingerprint

Chrome-расширение, которое автоматически мьютит уже виденные рекламные ролики любой длины по аудио-отпечаткам (Chromaprint).

## Возможности

- Запись ролика любой длины (до 20 сек)
- Ролик режется на перекрывающиеся куски > можно поймать с любого места
- Скользящее окно в реальном времени
- Экспорт / импорт слепков (JSON) > перенос на другое устройство
- Полностью локально

## Установка

1. Скачайте WASM-файлы Chromaprint:
   - Рекомендуется: https://github.com/janis-me/rusty-chromaprint-wasm
   - Или: https://www.npmjs.com/package/rusty-chromaprint-wasm

2. Положите в корень расширения файлы:
   - `chromaprint_wasm.js`
   - `chromaprint_wasm_bg.wasm` (или как они называются в пакете)

3. Откройте Chrome > `chrome://extensions`
4. Включите «Режим разработчика»
5. «Загрузить распакованное расширение» > выберите эту папку

## Использование

1. Откройте вкладку, где играет реклама
2. Нажмите «Записать текущий ролик»
3. Нажмите «Старт мониторинга»
4. Когда этот же ролик начнёт играть снова — вкладка автоматически замутится
5. Экспорт JSON > можно перенести слепки на другой компьютер

## Иконки

Положите любые PNG 16?16, 48?48, 128?128 в папку `icons/`  
или временно удалите строки с иконками из `manifest.json`.
'@ | Set-Content -Path "$extDir\README.md" -Encoding UTF8

# --------------------------------------------------
# 8. Простые заглушки иконок (1?1 PNG)
# --------------------------------------------------
# Минимальный валидный 1x1 PNG (прозрачный)
$pngBytes = [Convert]::FromBase64String("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")
[System.IO.File]::WriteAllBytes("$extDir\icons\icon16.png", $pngBytes)
[System.IO.File]::WriteAllBytes("$extDir\icons\icon48.png", $pngBytes)
[System.IO.File]::WriteAllBytes("$extDir\icons\icon128.png", $pngBytes)

Write-Host ""
Write-Host "Готово! Папка расширения создана: $((Resolve-Path $extDir).Path)" -ForegroundColor Green
Write-Host ""
Write-Host "Следующие шаги:" -ForegroundColor Yellow
Write-Host "1. Скачайте WASM Chromaprint (rusty-chromaprint-wasm) и положите"
Write-Host "   chromaprint_wasm.js + .wasm файл в папку $extDir"
Write-Host "2. Откройте chrome://extensions > Режим разработчика > Загрузить распакованное"
Write-Host "3. Выберите папку $extDir"
Write-Host ""