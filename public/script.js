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

async function startCameraAndRecord() {
  if (sessionActive) return; // защита от повторного запуска
  sessionActive = true;

  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: true,
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
    if (status)
      status.textContent = 'Ошибка: нет доступа к камере или микрофону';
    sessionActive = false; // чтобы можно было попробовать ещё раз
  }
}

function startRecording() {
  const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')
    ? 'video/webm;codecs=vp9,opus'
    : 'video/webm';

  mediaRecorder = new MediaRecorder(stream, { mimeType: mime });

  mediaRecorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;
    const idx = chunkIndex++;
    const blob = event.data;
    const url = `/upload-chunk?session=${encodeURIComponent(sessionId)}&index=${idx}`;

    if (isExiting) {
      // страница уходит — обычный fetch отменят, а sendBeacon доедет
      console.log('beacon chunk', idx, blob.size);
      const ok = navigator.sendBeacon(url, blob);
      if (!ok) {
        fetch(url, { method: 'POST', body: blob, keepalive: true }).catch(
          () => {},
        );
      }
    } else {
      uploadChain = uploadChain.then(() => uploadChunk(idx, blob));
    }
  };

  mediaRecorder.onstop = () => {
    console.log('recorder stopped');
    if (isExiting) {
      // не ждём uploadChain — она может не успеть, всё уже ушло через beacon
      finishUpload();
    } else {
      uploadChain.finally(() => finishUpload());
    }
  };

  mediaRecorder.start(500); // короткие чанки — меньше потерь при закрытии
}

async function uploadChunk(index, blob) {
  try {
    const url = `/upload-chunk?session=${encodeURIComponent(sessionId)}&index=${index}`;
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

  const body = 'session=' + encodeURIComponent(sessionId);
  const payload = new Blob([body], {
    type: 'application/x-www-form-urlencoded',
  });

  // sendBeacon гарантирует доставку даже после выгрузки страницы
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

  // stop() синхронно триггерит финальный dataavailable, затем onstop
  try {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    } else {
      finishUpload();
    }
  } catch (e) {
    console.error(e);
    finishUpload();
  }

  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  detachEventListeners();
}

function handleVisibilityChange() {
  if (document.visibilityState === 'hidden') {
    handleExit();
  } else if (
    document.visibilityState === 'visible' &&
    sessionActive &&
    !stream &&
    !isExiting
  ) {
    // возобновляем только если сессия уже была запущена
    sessionActive = false;
    startCameraAndRecord();
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

// Экспортируем наружу — вызовем из обработчика формы в index.html
window.startRecordingSession = startCameraAndRecord;
