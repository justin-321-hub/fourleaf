// ✅ 後端 API 網域
const API_BASE = 'https://fourleaf.onrender.com';
const api = (p) => `${API_BASE}${p}`;

/* =========================
   免登入多使用者：clientId
   - 每個瀏覽器第一次載入就產生一個 clientId
   - 之後所有請求都帶上，用於在 n8n 分流/記錄對話
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

// ---- 訊息狀態 ----
/** @type {{id:string, role:'user'|'assistant', text:string, ts:number}[]} */
const messages = [];

// ---- 工具：產生簡單唯一 ID ----
const uid = () => Math.random().toString(36).slice(2);

// ---- 工具：自動捲到最底 ----
function scrollToBottom() {
  elMessages.scrollTo({ top: elMessages.scrollHeight, behavior: 'smooth' });
}

// ---- 顯示訊息到畫面 ----
function render() {
  elMessages.innerHTML = '';
  for (const m of messages) {
    const isUser = m.role === 'user';
    const row = document.createElement('div');
    row.className = `msg ${isUser ? 'user' : 'bot'}`;

    // 頭像
    const avatar = document.createElement('img');
    avatar.className = 'avatar';
    avatar.src = isUser
      ? 'https://raw.githubusercontent.com/justin-321-hub/fourleaf/refs/heads/main/assets/user-avatar.png'
      : 'https://raw.githubusercontent.com/justin-321-hub/fourleaf/refs/heads/main/assets/bot-avatar.png';
    avatar.alt = isUser ? 'you' : 'bot';

    // 泡泡
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerText = m.text;

    // 每則訊息的動作：播放（OpenAI TTS）
    const actions = document.createElement('div');
    actions.className = 'actions';
    const btnPlay = document.createElement('span');
    btnPlay.className = 'link';
    btnPlay.innerText = '播放';
    btnPlay.title = '播放此則語音';
    btnPlay.addEventListener('click', () => speak(m.text));
    actions.appendChild(btnPlay);

    bubble.appendChild(actions);

    // 組合
    row.appendChild(avatar);
    row.appendChild(bubble);
    elMessages.appendChild(row);
  }
  scrollToBottom();
}

// ---- 將文字送到 n8n，並顯示雙方訊息 ----
async function sendText(text) {
  const content = (text ?? elInput.value).trim();
  if (!content) return;

  // 先加上使用者訊息
  const userMsg = { id: uid(), role: 'user', text: content, ts: Date.now() };
  messages.push(userMsg);
  elInput.value = '';
  render();

  try {
    // 呼叫後端 /api/n8n，將文字與 clientId 轉發給 n8n webhook
    const res = await fetch(api('/api/n8n'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Client-Id': clientId // 自訂 header（後端與 n8n 都可讀）
      },
      body: JSON.stringify({ text: content, clientId }) // 同時放在 body
    });

    // 優化錯誤顯示：先取字串，再嘗試 JSON 解析
    const raw = await res.text();
    let data;
    try { data = raw ? JSON.parse(raw) : {}; } catch { data = { errorRaw: raw }; }

    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} ${res.statusText} — ${data.error || data.body || data.errorRaw || raw || 'unknown error'}`
      );
    }

    // 解析 n8n 回覆
    const replyText =
      typeof data === 'string'
        ? data
        : (data && (data.text || data.message)) || JSON.stringify(data);

    const botMsg = { id: uid(), role: 'assistant', text: replyText, ts: Date.now() };
    messages.push(botMsg);
    render();

    // 自動語音播放機器人回覆（OpenAI TTS）
    speak(replyText);
  } catch (err) {
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
   文字轉語音（OpenAI TTS）
   經由後端 /api/tts 產生音檔再播放
   可用 voice: alloy/nova/onyx/sage/shimmer/…，format: mp3/wav/opus/aac/flac/pcm
   ========================= */
async function speak(text, opts = {}) {
  const { voice = 'alloy', format = 'mp3' } = opts; // 想換聲線/格式在此調整
  try {
    const res = await fetch(api('/api/tts'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, format })
    });
    if (!res.ok) throw new Error(await res.text());

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    await audio.play().catch(() => {
      alert('瀏覽器阻擋自動播放，請先點擊頁面或再按一次播放。');
    });
    audio.addEventListener('ended', () => URL.revokeObjectURL(url));
  } catch (err) {
    alert('TTS 播放失敗：' + (err?.message || err));
  }
}

/* =========================
   錄音（MediaRecorder）→ Whisper（/api/whisper）
   - 自動挑可用的 MIME，增加跨瀏覽器相容
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
  // 回傳容器（去掉 codecs）
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
      // 錄音結束：組合 Blob（使用容器 MIME，避免不支援格式）
      const blob = new Blob(recordedChunks, { type: container });
      const filename = container === 'audio/ogg' ? 'audio.ogg' : 'audio.webm';

      // 用 form-data 上傳（欄位名必須叫 file，後端才接得到）
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
        // 釋放麥克風
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

// ---- 初始化：放一則歡迎訊息（尾碼顯示 clientId 末 6 碼方便辨識會話）----
messages.push({
  id: uid(),
  role: 'assistant',
  text: `您好！這是您的對話會話（#${clientId.slice(-6)}）。請用語音或文字提問，我會幫您查詢資料庫。`,
  ts: Date.now()
});
render();
