// 🖼 이미지 업스케일·벡터화 — 실제 앱 본체로: 합성 이미지 2장(흑백 사진풍 JPG · 컬러 로고 PNG) →
//   🔍 AI 업스케일(GPU) → 흑백은 DeviceGray JPEG PDF(gs inkcov C+M+Y=0) → ✒ 벡터화 → 벡터 PDF를 gs로 그려 원본과 화소 대조
//   → 파일 해상도 기록(PNG pHYs·JPEG JFIF) → 📂 앱에서 열기(인쇄 크기 그대로 1쪽) · GPU 없음 감지(엉뚱한 GPU 번호)
//   실행: node scripts/test/img-enhance.e2e.js     (창은 TEST_WINDOW=left · 검사용 사용자 폴더)
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, execSync, execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = 9371;
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };
const getJson = u => new Promise((res, rej) => http.get(u, r => { let s = ''; r.on('data', d => s += d); r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } }); }).on('error', rej));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function connect() {
  for (let i = 0; i < 240; i++) {
    try {
      const t = (await getJson(`http://127.0.0.1:${PORT}/json`)).find(x => x.type === 'page' && /index\.html/.test(x.url));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        let id = 0; const wait = new Map();
        ws.onmessage = m => { const d = JSON.parse(m.data); if (wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } };
        return expr => new Promise(r => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } })); })
          .then(d => d.result && d.result.result ? d.result.result.value : { __err: JSON.stringify(d.result && d.result.exceptionDetails || d).slice(0, 800) });
      }
    } catch (e) {}
    await sleep(300);
  }
  throw new Error('CDP 연결 실패');
}
async function until(ev, expr, ms) { const t = Date.now(); while (Date.now() - t < ms) { if (await ev(expr)) return true; await sleep(300); } return false; }
function gsExe() { for (const c of ['gswin64c', 'C:\\Program Files\\gs\\gs10.07.1\\bin\\gswin64c.exe']) { try { execFileSync(c, ['-v'], { stdio: 'ignore' }); return c; } catch (e) {} } return null; }
function readPnm(file) {   // P6/P5 (# 주석 줄 건너뛰기 — 함정 7)
  const b = fs.readFileSync(file); let p = 0; const tok = () => { while (true) { while (/\s/.test(String.fromCharCode(b[p]))) p++; if (b[p] === 35) { while (b[p] !== 10) p++; continue; } break; } let s = ''; while (!/\s/.test(String.fromCharCode(b[p]))) s += String.fromCharCode(b[p++]); return s; };
  const m = tok(), w = +tok(), h = +tok(); tok(); p++;
  return { w, h, ch: m === 'P6' ? 3 : 1, data: b.subarray(p) };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit-ie-'));
let child;
(async () => {
  try {
    child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', env: Object.assign({}, process.env, { TEST_WINDOW: 'left' }) });
    const ev = await connect();
    await sleep(2500);
    await ev(`window.__errs = []; { const oe = window.showError; window.showError = m => { window.__errs.push(String(m)); try { oe(m); } catch (e) {} }; } window.confirm = () => true; 1`);

    // 합성 이미지 — 흑백 사진풍(그러데이션+원+잡음, 320×220 JPG, 해상도 기록 없음) · 컬러 로고(200×120 PNG, 흰 바탕)
    const made = await ev(`(async () => {
      const mk = (w, h, f, type) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); f(x, w, h); return new Promise(r => c.toBlob(b => b.arrayBuffer().then(a => r(new Uint8Array(a))), type, 0.9)); };
      const photo = await mk(320, 220, (x, w, h) => {
        const g = x.createLinearGradient(0, 0, w, h); g.addColorStop(0, '#222'); g.addColorStop(1, '#ddd'); x.fillStyle = g; x.fillRect(0, 0, w, h);
        x.fillStyle = '#fff'; x.beginPath(); x.arc(110, 110, 50, 0, 7); x.fill(); x.fillStyle = '#000'; x.font = 'bold 28px sans-serif'; x.fillText('PDF 2026', 170, 60);
        const id = x.getImageData(0, 0, w, h); for (let i = 0; i < id.data.length; i += 4) { const v = Math.max(0, Math.min(255, id.data[i] + (Math.random() * 16 - 8))); id.data[i] = id.data[i + 1] = id.data[i + 2] = v; } x.putImageData(id, 0, 0);
      }, 'image/jpeg');
      const logo = await mk(200, 120, (x, w, h) => {
        x.fillStyle = '#fff'; x.fillRect(0, 0, w, h);
        x.fillStyle = '#d81e2c'; x.fillRect(14, 16, 70, 50);
        x.strokeStyle = '#000'; x.lineWidth = 12; x.beginPath(); x.arc(140, 58, 32, 0, 7); x.stroke();
        x.fillStyle = '#1e5bd8'; x.beginPath(); x.moveTo(20, 104); x.lineTo(90, 78); x.lineTo(90, 110); x.closePath(); x.fill();
      }, 'image/png');
      return { photo: window.electronAPI.writeTempFile(photo, 'jpg'), logo: window.electronAPI.writeTempFile(logo, 'png') };
    })()`);
    const photoPath = path.join(tmp, '흑백사진.jpg'), logoPath = path.join(tmp, '로고.png');
    fs.copyFileSync(made.photo, photoPath); fs.copyFileSync(made.logo, logoPath);
    try { fs.unlinkSync(made.photo); fs.unlinkSync(made.logo); } catch (e) {}

    console.log('🖼 창 열기');
    await ev(`openImageEnhance([{ name: '흑백사진.jpg', path: ${JSON.stringify(photoPath)} }, { name: '로고.png', path: ${JSON.stringify(logoPath)} }]); 1`);
    const shown = await until(ev, `(() => { const o = document.querySelector('.ie-modal'); const T = o && o.parentNode.__ieTest; return !!(T && T.list.length === 2); })()`, 30000);
    ok(shown, '창 표시 · 이미지 2장');
    const info = await ev(`(() => { const T = document.querySelector('.ie-modal').parentNode.__ieTest; return T.list.map(S => ({ n: S.name, w: S.w, h: S.h, gray: S.gray, alpha: S.alpha, wMm: Math.round(S.wMm * 10) / 10, dpiKnown: S.dpiKnown })); })()`);
    ok(info[0].gray && !info[1].gray && !info[0].alpha, '흑백 사진 = 흑백 · 로고 = 컬러 ' + JSON.stringify(info));
    ok(Math.abs(info[0].wMm - 320 * 25.4 / 96) < 0.2, '해상도 기록 없는 작은 이미지 = 96dpi로 인쇄 폭 ' + info[0].wMm + 'mm (파일 열기와 같은 규칙)');

    // ── 🔍 업스케일(사진 모델, 2배) ──
    console.log('🔍 AI 업스케일');
    const up = await ev(`(async () => {
      const T = document.querySelector('.ie-modal').parentNode.__ieTest;
      T.P.model = 'realesrgan-x4plus'; T.P.size = '2'; T.setMode('up');
      const t0 = Date.now(); await T.run([0]);
      const S = T.list[0], r = S.up;
      return { ms: Date.now() - t0, method: r && r.method, w: r && r.w, h: r && r.h, gpu: r && r.gpu, note: r && r.note, errs: window.__errs.slice(),
        cap: document.getElementById('ieCapR').textContent, imgShown: document.getElementById('ieImgR').style.display !== 'none' };
    })()`);
    ok(up.method === 'ai' && up.w === 640 && up.h === 440 && up.imgShown, `AI 2배 → ${up.w}×${up.h} (${(up.ms / 1000).toFixed(1)}초 · GPU ${up.gpu}) · ${up.cap}`);
    ok(!up.errs.length, '오류 없음 ' + up.errs.join(' | '));
    // 결과가 원본보다 선명한가: 4배 일반 보간 대비 경계 기울기(라플라시안 에너지) 비교 — AI가 더 크다
    const sharp = await ev(`(async () => {
      const T = document.querySelector('.ie-modal').parentNode.__ieTest, S = T.list[0];
      const en = (src) => { const c = document.createElement('canvas'); c.width = S.up.w; c.height = S.up.h; const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(src, 0, 0, c.width, c.height); const d = x.getImageData(0, 0, c.width, c.height).data, W = c.width; const g = []; for (let y = 1; y < c.height - 1; y++) for (let k = 1; k < W - 1; k++) { const i = (y * W + k) * 4; g.push(Math.abs(d[i + 4] - d[i - 4]) + Math.abs(d[i + W * 4] - d[i - W * 4])); } g.sort((a, b) => a - b); return g[Math.floor(g.length * 0.995)]; };
      return { ai: en(S.up.bmp), interp: en(S.bmp) };
    })()`);
    if (process.env.IE_KEEP) { const im = await ev(`(async () => { const T = document.querySelector('.ie-modal').parentNode.__ieTest, S = T.list[0]; const c = document.createElement('canvas'); c.width = S.up.w * 2 + 10; c.height = S.up.h; const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(S.bmp, 0, 0, S.up.w, S.up.h); x.drawImage(S.up.bmp, S.up.w + 10, 0); return c.toDataURL('image/png').split(',')[1]; })()`); fs.writeFileSync(process.env.IE_KEEP + '/up-compare.png', Buffer.from(im, 'base64')); }
    ok(sharp.ai > sharp.interp * 1.15, `AI 결과가 일반 보간보다 선명(경계 기울기 상위 0.5% ${sharp.ai} > ${sharp.interp})`);
    // 결과를 원본 크기로 줄이면 원본과 같아야 한다(조각이 뒤섞이면 크게 다르다 — x4plus를 2배로 돌렸을 때의 사고)
    const same = await ev(`(async () => { const T = document.querySelector('.ie-modal').parentNode.__ieTest, S = T.list[0]; const a = iePixels(S.bmp).data, b = iePixels(S.up.bmp, S.w, S.h).data; let e = 0; for (let i = 0; i < a.length; i += 4) e += Math.abs(a[i] - b[i]); return e / (a.length / 4); })()`);
    ok(same < 12, 'AI 결과를 원본 크기로 줄이면 원본과 같다(평균 차 ' + same.toFixed(1) + '/255)');
    // PDF: 흑백 → 1성분 JPEG(DeviceGray), 쪽 크기 = 인쇄 폭
    const pdfUp = await ev(`(async () => {
      const T = document.querySelector('.ie-modal').parentNode.__ieTest, S = T.list[0];
      const b = await ieImagePdfBytes(S);
      const d = await PDFLib.PDFDocument.load(b), pg = d.getPage(0);
      let cs = [], filt = [];
      d.context.enumerateIndirectObjects().forEach(([, o]) => { if (o && o.dict && String(o.dict.get(PDFLib.PDFName.of('Subtype'))) === '/Image') { cs.push(String(o.dict.get(PDFLib.PDFName.of('ColorSpace')))); filt.push(String(o.dict.get(PDFLib.PDFName.of('Filter')))); } });
      const p = window.electronAPI.writeTempFile(b, 'pdf');
      return { w: pg.getWidth(), h: pg.getHeight(), wMm: S.wMm, cs, filt, path: p, len: b.length };
    })()`);
    ok(Math.abs(pdfUp.w - pdfUp.wMm * 72 / 25.4) < 0.05 && pdfUp.cs.join() === '/DeviceGray' && pdfUp.filt.join() === '/DCTDecode', `업스케일 PDF: 쪽 폭 = 인쇄 폭 · 그림 ${pdfUp.cs} ${pdfUp.filt} (${(pdfUp.len / 1024).toFixed(0)}KB)`);
    const gs = gsExe();
    if (gs) {
      const out = execFileSync(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=inkcov', '-o', '-', pdfUp.path], { encoding: 'utf8' });
      const v = out.trim().split(/\s+/).slice(0, 4).map(Number);
      ok(v[0] + v[1] + v[2] === 0 && v[3] > 0, `gs inkcov: 흑백 업스케일 PDF는 먹만 (C ${v[0]} M ${v[1]} Y ${v[2]} K ${v[3]})`);
    } else console.log('  (gs 없음 — inkcov 건너뜀)');
    try { fs.unlinkSync(pdfUp.path); } catch (e) {}

    // 파일 해상도 기록
    const dpiRec = await ev(`(async () => {
      const T = document.querySelector('.ie-modal').parentNode.__ieTest, S = T.list[0];
      const png = await T.bytesFor(S, 'png'), jpg = await T.bytesFor(S, 'jpg');
      const isGrayJpg = (() => { for (let p = 2; p < jpg.length - 9;) { if (jpg[p] !== 0xFF) { p++; continue; } const m = jpg[p + 1]; if (m === 0xC0 || m === 0xC1) return jpg[p + 9] === 1; p += 2 + ((jpg[p + 2] << 8) | jpg[p + 3]); } return null; })();
      return { png: pngDpi(png), jpg: jpegDpi(jpg), want: S.up.w / (S.wMm / 25.4), isGrayJpg };
    })()`);
    ok(dpiRec.png && Math.abs(dpiRec.png.x - dpiRec.want) < 1 && dpiRec.jpg && Math.abs(dpiRec.jpg.x - dpiRec.want) < 1, `저장 파일에 해상도 기록: PNG ${dpiRec.png && dpiRec.png.x.toFixed(1)} · JPG ${dpiRec.jpg && dpiRec.jpg.x.toFixed(1)}dpi (목표 ${dpiRec.want.toFixed(1)})`);
    ok(dpiRec.isGrayJpg === true, '흑백 결과 JPG = 1성분(회색) JPEG');

    // ── ✒ 벡터화(로고, 4색, AI로 먼저 키우기) ──
    console.log('✒ 벡터화');
    const vec = await ev(`(async () => {
      const T = document.querySelector('.ie-modal').parentNode.__ieTest;
      document.querySelector('#ieList .ie-row[data-i="1"]').click();
      T.P.colors = 0; T.P.smooth = 1; T.P.speck = 8; T.P.dropWhite = false; T.P.aiFirst = true; T.setMode('vec');
      const t0 = Date.now(); await T.run([1]);
      const S = T.list[1], r = S.vec;
      const b = await ieVectorPdfBytes(S);
      return { ms: Date.now() - t0, src: r && r.src, stats: r && r.stats, tw: r && r.tw, path: window.electronAPI.writeTempFile(b, 'pdf'), len: b.length, wMm: S.wMm, w: S.w, h: S.h,
        cap: document.getElementById('ieCapR').textContent, errs: window.__errs.slice(), aiNote: r && r.aiNote };
    })()`);
    ok(vec.stats && vec.stats.colors === 4 && /AI/.test(vec.src), `벡터: ${vec.src} → 윤곽 ${vec.tw}px · 색 ${vec.stats && vec.stats.colors} · 모양 ${vec.stats && vec.stats.shapes} · ${(vec.ms / 1000).toFixed(1)}초 · ${(vec.len / 1024).toFixed(0)}KB`);
    ok(!vec.errs.length, '오류 없음 ' + vec.errs.join(' | '));
    if (gs) {
      // 벡터 PDF를 원본 화소 크기로 그려(dpi = 화소 ÷ 인쇄 폭) 원본 PNG와 화소 대조 — 위치·방향(위아래)·색이 맞는지
      const dpi = vec.w / (vec.wMm / 25.4);
      const ppm = path.join(tmp, 'vec.ppm');
      execFileSync(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=ppmraw', `-r${dpi.toFixed(4)}`, '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', '-o', ppm, vec.path]);
      const R = readPnm(ppm);
      const src = await ev(`(async () => { const T = document.querySelector('.ie-modal').parentNode.__ieTest, S = T.list[1]; const d = iePixels(S.bmp).data; return Array.from(d); })()`);
      let bad = 0, n = 0;
      for (let y = 0; y < Math.min(R.h, vec.h); y++) for (let x = 0; x < Math.min(R.w, vec.w); x++) {
        const i = (y * R.w + x) * 3, j = (y * vec.w + x) * 4; n++;
        if (Math.abs(R.data[i] - src[j]) + Math.abs(R.data[i + 1] - src[j + 1]) + Math.abs(R.data[i + 2] - src[j + 2]) > 120) bad++;
      }
      ok(Math.abs(R.w - vec.w) <= 1 && Math.abs(R.h - vec.h) <= 1 && bad / n < 0.02, `gs로 그린 벡터 = 원본 (${R.w}×${R.h} · 크게 다른 화소 ${(bad / n * 100).toFixed(2)}%)`);
      const out = execFileSync(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=inkcov', '-o', '-', vec.path], { encoding: 'utf8' });
      ok(out.trim().split(/\s+/).slice(0, 3).map(Number).some(v => v > 0), '컬러 로고는 컬러로 (inkcov ' + out.trim().split(/\s+/).slice(0, 4).join(' ') + ')');
    }
    if (process.env.IE_KEEP) { fs.copyFileSync(vec.path, process.env.IE_KEEP + "/vec.pdf"); fs.copyFileSync(logoPath, process.env.IE_KEEP + "/logo.png"); }
    try { fs.unlinkSync(vec.path); } catch (e) {}
    // 흑백 2색 → 먹만
    const bw = await ev(`(async () => {
      const T = document.querySelector('.ie-modal').parentNode.__ieTest;
      T.P.colors = 2; await T.run([1]);
      const S = T.list[1], b = await ieVectorPdfBytes(S);
      return { stats: S.vec.stats, path: window.electronAPI.writeTempFile(b, 'pdf') };
    })()`);
    if (gs) {
      const out = execFileSync(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=inkcov', '-o', '-', bw.path], { encoding: 'utf8' });
      const v = out.trim().split(/\s+/).slice(0, 4).map(Number);
      ok(bw.stats.gray && v[0] + v[1] + v[2] === 0 && v[3] > 0, `흑백 2색 벡터 → 먹만 (C ${v[0]} M ${v[1]} Y ${v[2]} K ${v[3]})`);
    }
    try { fs.unlinkSync(bw.path); } catch (e) {}

    // GPU 없음 감지 — 없는 GPU 번호로 직접 실행
    const nog = await ev(`(async () => {
      const c = document.createElement('canvas'); c.width = c.height = 32; c.getContext('2d').fillRect(4, 4, 10, 10);
      const b = new Uint8Array(await (await new Promise(r => c.toBlob(r, 'image/png'))).arrayBuffer());
      const inP = window.electronAPI.writeTempFile(b, 'png'), outP = window.electronAPI.tempPath('png');
      const r = await window.electronAPI.upscaleRun({ inPath: inP, outPath: outP, model: 'realesr-animevideov3', scale: 2, gpu: 9 });
      window.electronAPI.removeTempFile(inP);
      const bad = await window.electronAPI.upscaleRun({ inPath: 'C:\\\\Windows\\\\win.ini', outPath: outP, model: 'realesr-animevideov3', scale: 2 });
      return { ok: r.ok, noGpu: r.noGpu, err: r.error, badOk: bad.ok, badErr: bad.error };
    })()`);
    ok(!nog.ok && nog.noGpu, 'GPU를 못 쓰면 noGpu로 알림 → 화면은 일반 보간으로 대신 (' + nog.err + ')');
    ok(!nog.badOk && /임시파일/.test(nog.badErr || ''), '임시 그림이 아닌 경로는 거부');

    // ── 📂 앱에서 열기(지금 = 흑백 2색 벡터 결과 · 문서 없음 → 바로 연다) ──
    console.log('📂 앱에서 열기');
    await ev(`(async () => { const T = document.querySelector('.ie-modal').parentNode.__ieTest; T.P.colors = 0; await T.run([1]); document.getElementById('ieOpen').click(); return 1; })()`);
    const opened = await until(ev, `!!(typeof originalPdfBytes !== 'undefined' && originalPdfBytes && pageResults.filter(Boolean).length === 1 && !document.querySelector('.ie-modal'))`, 60000);
    const doc = await ev(`(async () => { const d = await PDFLib.PDFDocument.load(originalPdfBytes.slice(0)); const p = d.getPage(0); return { w: p.getWidth() * 25.4 / 72, h: p.getHeight() * 25.4 / 72, name: (typeof currentFileName !== 'undefined' ? currentFileName : '') || document.title, recent: (JSON.parse(localStorage.getItem('recentFiles') || '[]')).map(r => r.path), color: pageResults[0] && pageResults[0].isColor }; })()`);
    ok(opened && Math.abs(doc.w - 200 * 25.4 / 96) < 0.3, `앱에서 열림 — 1쪽 ${doc.w && doc.w.toFixed(1)}×${doc.h && doc.h.toFixed(1)}mm (인쇄 크기 그대로) · 분석 컬러 ${doc.color}`);
    ok(!doc.recent.some(p => /pdfedit_/i.test(p)), '임시 PDF는 최근 파일에 넣지 않음');
  } catch (e) {
    fail++; console.log('  ✘ 예외: ' + (e && e.stack || e));
  } finally {
    try { if (child) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n결과: 통과 ${pass} · 실패 ${fail}`);
    process.exit(fail ? 1 : 0);
  }
})();
