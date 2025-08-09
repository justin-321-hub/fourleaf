// 說明：前端聊天邏輯（純原生 JS）
// - 使用 MediaRecorder 錄音，將音檔以 form-data 送到 /api/whisper
// - Whisper 回傳文字後：顯示在輸入框並自動送到 /api/n8n
// - 顯示 n8n 回覆，並可逐則播放語音（OpenAI TTS 經由 /api/tts）
// - 全中文註解

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
    avatar.src = isUser ? 'https://raw.githubusercontent.com/justin-321-hub/fourleaf/refs/heads/main/assets/user-avatar.png' : 'https://raw.githubusercontent.com/justin-321-hub/fourleaf/refs/heads/main/assets/bot-avatar.png';
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
    btnPlay.addEventListener('click', () => speak(m.text)); // ← 呼叫下方的 OpenAI TTS 版本
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
    // 呼叫後端 /api/n8n，將文字轉發給 n8n webhook
    const res = await fetch('/api/n8n', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: content })
    });
    if (!res.ok) throw new Error(await res.text());
    const data = await res.json();

    // 解析 n8n 回覆：優先使用 data.text，其次 data.message，最後整個 JSON
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
    // 從後端取得音檔 Blob
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice, format })
    });
    if (!res.ok) throw new Error(await res.text());

    // 建立音訊並播放
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);

    // iOS/部分瀏覽器需要使用者互動（點擊）後才能播放；若失敗可提示用戶
    audio.play().catch(() => {
      alert('瀏覽器阻擋自動播放，請先點擊頁面或再按一次播放。');
    });

    // 播放完釋放記憶體
    audio.addEventListener('ended', () => URL.revokeObjectURL(url));
  } catch (err) {
    alert('TTS 播放失敗：' + (err?.message || err));
  }
}

// ---- 錄音（MediaRecorder）→ Whisper（/api/whisper）----
let mediaRecorder = null;
let recordedChunks = [];

async function startRecording() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      // 錄音結束：組合 Blob
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });

      // 用 form-data 上傳（欄位名必須叫 file，後端才接得到）
      const fd = new FormData();
      fd.append('file', blob, 'audio.webm');

      try {
        // 呼叫 /api/whisper 取得文字
        const res = await fetch('/api/whisper', { method: 'POST', body: fd });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        const text = data?.text || '';

        // 將辨識文字放到輸入框並自動送出
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

// ---- 初始化：放一則歡迎訊息 ----
messages.push({
  id: uid(),
  role: 'assistant',
  text: '您好！請用語音或文字提問，我會幫您查詢資料庫。',
  ts: Date.now()
});
render();

