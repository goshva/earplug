let monitoring = false;
let currentTabId = null;
let offscreenReady = false;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'LEARN') {
    handleLearn(msg.tabId).then(sendResponse);
    return true; // async
  }
  if (msg.type === 'START_MONITOR') {
    startMonitor(msg.tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  if (msg.type === 'STOP_MONITOR') {
    stopMonitor();
    sendResponse({ ok: true });
  }
  // offscreen сообщает, что готов
  if (msg.type === 'OFFSCREEN_READY') {
    offscreenReady = true;
  }
  // mute / unmute
  if (msg.type === 'MATCH_FOUND' && monitoring && msg.tabId === currentTabId) {
    chrome.tabs.update(msg.tabId, { muted: true });
  }
  if (msg.type === 'MATCH_ENDED' && msg.tabId === currentTabId) {
    chrome.tabs.update(msg.tabId, { muted: false });
  }
});

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (contexts.length > 0) {
    offscreenReady = true;
    return;
  }

  offscreenReady = false;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: 'Audio fingerprinting of tab audio'
  });

  // ждём, пока offscreen пришлёт OFFSCREEN_READY (макс. 3 сек)
  const deadline = Date.now() + 3000;
  while (!offscreenReady && Date.now() < deadline) {
    await sleep(50);
  }
  // даже если ready не пришёл — даём ещё чуть времени на загрузку скрипта
  if (!offscreenReady) await sleep(300);
  offscreenReady = true;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Безопасная отправка: не падает, если receiving end нет */
function sendToOffscreen(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        // глушим Unchecked runtime.lastError
        void chrome.runtime.lastError;
        resolve(response);
      });
    } catch (_) {
      resolve(undefined);
    }
  });
}

async function forceStopCapture() {
  await ensureOffscreen();
  await sendToOffscreen({ type: 'OFFSCREEN_FORCE_STOP' });
  await sleep(500); // Chrome отпускает stream
}

async function handleLearn(tabId) {
  try {
    await forceStopCapture();
    await ensureOffscreen();

    const streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tabId
    });

    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        chrome.runtime.onMessage.removeListener(listener);
        resolve({ ok: false, error: 'Таймаут записи (30 сек)' });
      }, 30000);

      const listener = (msg) => {
        if (msg.type !== 'LEARN_RESULT') return;
        clearTimeout(timeout);
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
          resolve({ ok: false, error: msg.error || 'learn failed' });
        }
      };

      chrome.runtime.onMessage.addListener(listener);
      sendToOffscreen({ type: 'OFFSCREEN_LEARN', streamId });
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function startMonitor(tabId) {
  await forceStopCapture();
  monitoring = true;
  currentTabId = tabId;
  await ensureOffscreen();

  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId
  });

  await sendToOffscreen({
    type: 'OFFSCREEN_START_MONITOR',
    streamId,
    tabId
  });
}

function stopMonitor() {
  monitoring = false;
  currentTabId = null;
  sendToOffscreen({ type: 'OFFSCREEN_FORCE_STOP' });
}