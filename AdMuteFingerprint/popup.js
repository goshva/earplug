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
