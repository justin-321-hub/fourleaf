// ✅ 後端 API 網域
const API_BASE = 'https://fourleaf.onrender.com';
const api = (p) => `${API_BASE}${p}`;

/* =========================
   免登入多使用者：clientId
   ========================= */
const CID_KEY = 'fourleaf_client_id';
let clientId = localStorage.getItem(CID_KEY);
if (!clientId) {
  clientId = (crypto.randomUUID && crypto.randomUUID())
    || (Date.now() + '-' + Math.random().toString(36).slice(2));
  localStorage.setItem(CID_KEY, clientId);
}

// ---- DOM 參照 ----
const elMessages = document.getElementById('messages');
const elInput = document.getElementById('txtInput');
const elBtnSend = document.getElementById('btnSend');
const elBtnMic = document.getElementById('btnMic');
const elThinking = document.getElementById('thinking'); // ★ 思考動畫

// ---- 訊息狀態 ----
/** @type {{id:string, role:'user'|'assistant', text:string, ts:number}[]} */
const messages = [];
// 每次 render 後，記住各訊息對應的播放按鈕（自動播放用）
const audioBtnMap = new Map();

// ---- 工具 ----
const uid = () => Math.random().toString(36).slice(2);
function scrollToBottom() {
  elMessages.scrollTo({ top: elMessages.scrollHeight, behavior: 'smooth' });
}

// ★ 思考動畫 on/off + 禁用輸入
function setThinking(on) {
  if (!elThinking) return;
  if (on) {
    elThinking.classList.remove('hidden');
    elBtnSend.disabled = true;
    elBtnMic.disabled = true;
    elInput.disabled = true;
  } else {
    elThinking.classList.add('hidden');
    elBtnSend.disabled = false;
    elBtnMic.disabled = false;
    elInput.disabled = false;
  }
}

/* =========================
   單一音訊播放管理器 + TTS 快取
   ========================= */
const AudioManager = (() => {
  let currentAudio = null;
  let currentBtn = null;
  let currentURL = null; // objectURL
  const ttsCache = new Map(); // cacheKey -> Blob
  const CACHE_LIMIT = 20;

  function setBtnState(btn, state) {
    if (!btn) return;
    btn.dataset.state = state; // idle | playing
  }
  function evictIfNeeded() {
    if (ttsCache.size > CACHE_LIMIT) {
      const firstKey = ttsCache.keys().next().value;
      ttsCache.delete(firstKey);
    }
  }
  function stop() {
    if (currentAudio) {
      currentAudio.pause();
      currentAudio = null;
    }
    if (currentURL) {
      URL.revokeObjectURL(currentURL);
      currentURL = null;
    }
    setBtnState(currentBtn, 'idle');
    currentBtn = null;
  }

  async function getTTSBlob(cacheKey, text, opts = {}) {
    if (cacheKey && ttsCache.has(cacheKey)) return ttsCache.get(cacheKey);
    const { voice = 'alloy', format = 'mp3' } = opts;
    const res = await fetch(api('/api/tts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, format })
    });
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    if (cacheKey) {
      ttsCache.set(cacheKey, blob);
      evictIfNeeded();
    }
    return blob;
  }

  async function playFromText(cacheKey, text, opts, btn) {
    // 若點擊的是「同一顆正在播放的按鈕」，則視為「暫停/停止」
    if (btn && currentBtn === btn && btn.dataset.state === 'playing') {
      stop();
      return;
    }

    // 播放新的音訊前，先停掉舊的
    stop();

    // 取得/產生 TTS
    const blob = await getTTSBlob(cacheKey, text, opts);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    currentAudio = audio;
    currentBtn = btn || null;
    currentURL = url;

    audio.addEventListener('ended', () => {
      stop();
    });
    audio.addEventListener('pause', () => {
      // 若因為使用者或瀏覽器造成 pause，也回復按鈕狀態
      setBtnState(currentBtn, 'idle');
    });

    try {
      await audio.play();
      setBtnState(currentBtn, 'playing');
    } catch (err) {
      // 自動播放被阻擋
      setBtnState(currentBtn, 'idle');
      alert('瀏覽器阻擋自動播放，請先點擊頁面或再按一次播放。');
    }
  }

  return { playFromText, stop };
})();

/* =========================
   將訊息渲染到畫面（含語音按鈕）
   ========================= */
function render() {
  elMessages.innerHTML = '';
  audioBtnMap.clear();

  for (const m of messages) {
    const isUser = m.role === 'user';
    const row = document.createElement('div');
    row.className = `msg ${isUser ? 'user' : 'bot'}`;

    // 頭像
    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.src = isUser
      ? 'https://raw.githubusercontent.com/justin-321-hub/fourleaf/refs/heads/main/assets/user-avatar1.png'
      : 'https://raw.githubusercontent.com/justin-321-hub/fourleaf/refs/heads/main/assets/bot-avatar1.png';
    avatar.alt = isUser ? 'you' : 'bot';

    // 泡泡
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerText = m.text;

    // 動作列（含語音播放按鈕）
    const actions = document.createElement('div');
    actions.className = 'actions';

    const btnPlay = document.createElement('button');
    btnPlay.className = 'audio-btn';
    btnPlay.type = 'button';
    btnPlay.setAttribute('aria-label', '播放/暫停語音');
    btnPlay.dataset.state = 'idle';
    btnPlay.innerHTML = `
      <svg class="icon play" viewBox="0 0 24 24" aria-hidden="true">
        <use href="#icon-play"></use>
      </svg>
      <svg class="icon pause" viewBox="0 0 24 24" aria-hidden="true">
        <use href="#icon-pause"></use>
      </svg>
    `;
    btnPlay.addEventListener('click', () => {
      AudioManager.playFromText(m.id, m.text, { voice: 'alloy', format: 'mp3' }, btnPlay);
    });

    actions.appendChild(btnPlay);
    bubble.appendChild(actions);

    // 組合
    row.appendChild(avatar);
    row.appendChild(bubble);
    elMessages.appendChild(row);

    // 記錄此訊息的按鈕（方便之後自動播放）
    audioBtnMap.set(m.id, btnPlay);
  }

  scrollToBottom();
}

/* =========================
   將文字送到 n8n，並顯示雙方訊息
   ========================= */
async function sendText(text) {
  const content = (text ?? elInput.value).trim();
  if (!content) return;

  // 先加上使用者訊息
  const userMsg = { id: uid(), role: 'user', text: content, ts: Date.now() };
  messages.push(userMsg);
  elInput.value = '';
  render();

  // 思考中（直到收到 n8n 回覆才關閉）
  setThinking(true);

  try {
    // 呼叫後端 /api/chat
    const res = await fetch(api('/api/chat'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': clientId
      },
      body: JSON.stringify({ text: content, clientId })
    });

    const raw = await res.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { errorRaw: raw }; }

    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} ${res.statusText} — ${data.error || data.body || data.errorRaw || raw || 'unknown error'}`
      );
    }

    const replyText =
      typeof data === 'string'
        ? data
        : (data && (data.text || data.message)) || JSON.stringify(data);

    const botMsg = { id: uid(), role: 'assistant', text: replyText, ts: Date.now() };
    messages.push(botMsg);

    // 關閉思考中 → 再渲染
    setThinking(false);
    render();

    // 自動語音播放這則回覆（單一音訊管理會自動停止舊的）
    const btn = audioBtnMap.get(botMsg.id);
    if (btn) {
      AudioManager.playFromText(botMsg.id, replyText, { voice: 'alloy', format: 'mp3' }, btn);
    }
  } catch (err) {
    setThinking(false);
    const botErr = {
      id: uid(),
      role: 'assistant',
      text: `取得回覆時發生錯誤：${err?.message || err}`,
      ts: Date.now()
    };
    messages.push(botErr);
    render();
  }
}

/* =========================
   （更新版）文字轉語音：走 AudioManager
   ========================= */
// 若你還想在其他地方手動播放，可用：
// AudioManager.playFromText(cacheKey, text, { voice: 'alloy', format: 'mp3' }, 按鈕或null);

/* =========================
   錄音（MediaRecorder）→ Whisper（/api/whisper）
   ========================= */
let mediaRecorder = null;
let recordedChunks = [];

function pickAudioMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/ogg'
  ];
  const chosen = candidates.find(t => 'MediaRecorder' in window && MediaRecorder.isTypeSupported(t)) || '';
  const container = chosen.includes('ogg') ? 'audio/ogg' : 'audio/webm';
  return { chosen, container };
}

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];

    const { chosen, container } = pickAudioMime();
    mediaRecorder = new MediaRecorder(stream, chosen ? { mimeType: chosen } : undefined);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      const blob = new Blob(recordedChunks, { type: container });
      const filename = container === 'audio/ogg' ? 'audio.ogg' : 'audio.webm';

      const fd = new FormData();
      fd.append('file', blob, filename);

      try {
        const res = await fetch(api('/api/whisper'), { method: 'POST', body: fd });
        const raw = await res.text();
        let data;
        try { data = raw ? JSON.parse(raw) : {}; } catch { data = { errorRaw: raw }; }

        if (!res.ok) {
          throw new Error(data.error || data.errorRaw || raw || `HTTP ${res.status}`);
        }

        const text = data?.text || '';
        elInput.value = text;
        await sendText(text);
      } catch (err) {
        alert('語音辨識失敗：' + (err?.message || err));
      } finally {
        stream.getTracks().forEach(t => t.stop());
      }
    };

    mediaRecorder.start();
    elBtnMic.dataset.recording = '1';
    elBtnMic.textContent = '⏹ 停止';
  } catch (err) {
    alert('無法啟動錄音：' + (err?.message || err));
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }
  elBtnMic.dataset.recording = '';
  elBtnMic.textContent = '🎤 語音';
}

// ---- 事件綁定 ----
elBtnSend.addEventListener('click', () => sendText());
elInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) sendText();
});
elBtnMic.addEventListener('click', () => {
  if (elBtnMic.dataset.recording === '1') stopRecording();
  else startRecording();
});

// ---- 初始化歡迎訊息 ----
messages.push({
  id: uid(),
  role: 'assistant',
  text: `您好，歡迎光臨！
這裡是餐飲業專屬客服中心，我們將為您提供餐廳資訊、菜單介紹、訂位服務、交通指南與優惠活動等內容，協助您享受最美好的用餐體驗。請問今天想了解哪方面的資訊呢？`,
  ts: Date.now()
});
render();



