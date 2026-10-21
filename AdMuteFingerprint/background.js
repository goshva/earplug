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
