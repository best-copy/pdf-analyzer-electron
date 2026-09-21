// 📤 탐색기 '보내기'로 이미지 여러 장 → 열 순서 창 → 한 문서로 열림 (실제 앱 본체 구동)
//   실행: node scripts/test/sendto-images.e2e.js
// 회귀: main.js OPEN_DOC_RE에 이미지 확장자가 없어 실행 인자의 이미지가 전부 걸러졌다 →
//       앱만 뜨고 아무 일도 없었다. 첫 실행 인자와 이미 떠 있을 때(second-instance) 둘 다 본다.
// 창은 TEST_WINDOW=left(가장 왼쪽 모니터) · 검사용 사용자 폴더. 화면 조회는 CDP(원격 디버깅 포트).
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const http = require('http');
const { spawn, execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const electron = require('electron');
const PORT = 9337;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit_sendto_'));

// 단색 PNG (크기 w×h)
function png(file, w, h, [r, g, b]) {
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = b; }
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
  return file;
}

const getJson = (url) => new Promise((res, rej) => http.get(url, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function connect() {
  for (let i = 0; i < 100; i++) {
    try {
      const list = await getJson(`http://127.0.0.1:${PORT}/json`);
      const t = list.find(x => x.type === 'page' && /index\.html/.test(x.url));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        let id = 0; const wait = new Map();
        ws.onmessage = (m) => { const d = JSON.parse(m.data); if (wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
        const ev = (expr) => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); })
          .then(d => d.result && d.result.result ? d.result.result.value : undefined);
        return { ws, ev };
      }
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('CDP 연결 실패');
}
async function until(ev, expr, ms) {
  const t = Date.now();
  while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(250); }
  return false;
}

const out = [];
const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
const env = Object.assign({}, process.env, { TEST_WINDOW: 'left', PDFEDIT_TEST_WINDOW: 'left' });
let child;

(async () => {
  try {
    const imgs = [png(path.join(dir, '사진3.png'), 300, 400, [220, 30, 30]), png(path.join(dir, '사진1.png'), 400, 300, [30, 160, 40]), png(path.join(dir, '사진2.png'), 300, 400, [40, 60, 200])];
    child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`, ...imgs], { cwd: ROOT, env, stdio: 'ignore' });
    const { ws, ev } = await connect();

    const shown = await until(ev, `document.getElementById('orderModal').style.display === 'block'`, 20000);
    ck('첫 실행 인자(이미지 3장) → 열 순서 창이 뜸', shown);
    const rows = await ev(`[...document.querySelectorAll('#orderRows .ord-row')].map(r => r.textContent.trim())`);
    ck('창에 이미지 3장 모두 나열', rows && rows.length === 3, rows);

    await ev(`sortOrderItems(), confirmOpenOrder(true)`);
    const ok = await until(ev, `(() => { const t = tabs.get(activeTabId); return !!(t && isTabReady(t) && t.pageResults.filter(Boolean).length === 3); })()`, 40000);
    ck('통합창 → 3쪽 한 문서로 열림', ok, await ev(`(() => { const t = tabs.get(activeTabId); return t ? [t.status, t.pageResults.filter(Boolean).length] : null; })()`));
    const colors = await ev(`tabs.get(activeTabId).pageResults.map(r => r && r.isColor)`);
    ck('각 쪽 컬러 판정(단색 사진)', Array.isArray(colors) && colors.every(Boolean), colors);

    // 이미 떠 있는 앱에 다시 보내기(두 번째 실행 → second-instance)
    const more = [png(path.join(dir, 'B.png'), 200, 200, [200, 200, 0]), png(path.join(dir, 'A.png'), 200, 200, [0, 200, 200])];
    const second = spawn(electron, ['.', ...more], { cwd: ROOT, env, stdio: 'ignore' });
    await new Promise(r => second.on('exit', r));
    const shown2 = await until(ev, `document.getElementById('orderModal').style.display === 'block' && document.querySelectorAll('#orderRows .ord-row').length === 2`, 20000);
    ck('실행 중인 앱에 보내기(이미지 2장) → 열 순서 창', shown2);
    await ev(`document.getElementById('orderModal').style.display = 'none'`);
    ws.close();
  } catch (e) {
    ck('예외 없이 완료', false, String(e && e.stack || e));
  } finally {
    try { execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    for (const r of out) console.log(r.join(' '));
    const fail = out.filter(r => r[0] !== '✔').length;
    console.log(fail ? `FAIL ${fail}/${out.length}` : `PASS ${out.length}/${out.length}`);
    process.exit(fail ? 1 : 0);
  }
})();
