const preview = document.getElementById('preview');
const indicator = document.getElementById('indicator');
const status = document.getElementById('status');

let mediaRecorder;
let stream;
let sessionId;
let chunkIndex = 0;
let uploadChain = Promise.resolve();
let isExiting = false;
let finished = false;
let sessionActive = false;
let chosenExt = 'webm';

// Выбираем первый поддерживаемый формат (на iOS — mp4, на десктопе — webm)
function pickMime() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4;codecs=h264,aac',
    'video/mp4',
  ];
  for (const c of candidates) {
    try {
      if (window.MediaRecorder && MediaRecorder.isTypeSupported(c)) return c;
    } catch {}
  }
  return '';
}

function extFromMime(mime) {
  if (!mime) return 'webm';
  if (mime.includes('mp4')) return 'mp4';
  return 'webm';
}

async function startCameraAndRecord() {
  if (sessionActive) return;
  sessionActive = true;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    console.error('getUserMedia не поддерживается. Открой через http:// или https://');
    if (status) status.textContent = 'Нужен https или http://localhost';
    sessionActive = false;
    return;
  }
  if (!window.MediaRecorder) {
    console.error('MediaRecorder не поддерживается');
    sessionActive = false;
    return;
  }

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user' },
      audio: true,
    });

    if (preview) {
      preview.srcObject = stream;
      preview.muted = true;
      preview.play().catch(() => {});
    }
    if (status) status.textContent = 'Идёт запись...';
    if (indicator) indicator.style.display = 'flex';

    sessionId =
        (crypto.randomUUID && crypto.randomUUID()) ||
        'sess-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    chunkIndex = 0;
    uploadChain = Promise.resolve();
    finished = false;
    isExiting = false;

    startRecording();
    attachEventListeners();
  } catch (err) {
    console.error('Ошибка доступа к камере:', err);
    if (status) status.textContent = 'Ошибка: ' + (err && err.name ? err.name : 'нет доступа');
    sessionActive = false;
  }
}

function startRecording() {
  const mime = pickMime();
  chosenExt = extFromMime(mime);
  console.log('MediaRecorder mime:', mime || '(default)', 'ext:', chosenExt);

  let opts = {};
  if (mime) opts.mimeType = mime;

  try {
    mediaRecorder = new MediaRecorder(stream, opts);
  } catch (e) {
    console.error('MediaRecorder init error, fallback to default:', e);
    mediaRecorder = new MediaRecorder(stream);
    chosenExt = extFromMime(mediaRecorder.mimeType || '');
  }

  mediaRecorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    const idx = chunkIndex++;
    const blob = event.data;
    const url = `/upload-chunk?session=${encodeURIComponent(sessionId)}&index=${idx}&ext=${chosenExt}`;

    if (isExiting) {
      console.log('beacon chunk', idx, blob.size);
      const ok = navigator.sendBeacon(url, blob);
      if (!ok) {
        fetch(url, { method: 'POST', body: blob, keepalive: true }).catch(() => {});
      }
    } else {
      uploadChain = uploadChain.then(() => uploadChunk(idx, blob));
    }
  };

  mediaRecorder.onstop = () => {
    console.log('recorder stopped');
    if (!isExiting) {
      uploadChain.finally(() => finishUpload());
    }
  };

  // На мобильных timeslice лучше не делать слишком маленьким
  mediaRecorder.start(1000);
}

async function uploadChunk(index, blob) {
  try {
    const url = `/upload-chunk?session=${encodeURIComponent(sessionId)}&index=${index}&ext=${chosenExt}`;
    const res = await fetch(url, { method: 'POST', body: blob });
    if (!res.ok) console.warn('chunk failed', index, res.status);
    else console.log('chunk ok', index, blob.size);
  } catch (e) {
    console.error('chunk error', index, e);
  }
}

function finishUpload() {
  if (finished || !sessionId) return;
  finished = true;

  const body = 'session=' + encodeURIComponent(sessionId) + '&ext=' + chosenExt;
  const payload = new Blob([body], {
    type: 'application/x-www-form-urlencoded',
  });

  const ok = navigator.sendBeacon('/upload-finish', payload);
  console.log('finish beacon:', ok);

  if (!ok) {
    fetch('/upload-finish', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      keepalive: true,
    }).catch(() => {});
  }
}

function handleExit() {
  if (isExiting) return;
  isExiting = true;
  console.log('🚪 exit');

  // Пытаемся красиво остановить рекордер — но не ждём его
  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
  } catch (e) {
    console.error(e);
  }

  // На мобильных страница умирает моментально — шлём finish сразу через beacon.
  // Сервер подождёт 1.5с, успеет принять финальный чанк.
  finishUpload();

  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  detachEventListeners();
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    // На мобильных это самый надёжный сигнал «пользователь уходит»
    handleExit();
  }
}

function attachEventListeners() {
  window.addEventListener('pagehide', handleExit);
  window.addEventListener('beforeunload', handleExit);
  document.addEventListener('visibilitychange', handleVisibilityChange);
}

function detachEventListeners() {
  window.removeEventListener('pagehide', handleExit);
  window.removeEventListener('beforeunload', handleExit);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
}

window.startRecordingSession = startCameraAndRecord;