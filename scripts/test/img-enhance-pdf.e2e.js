// 📄 PDF 안 저해상도 그림 업스케일·벡터화(2단계) — 실제 앱 본체로
//   합성 PDF 3쪽: 1쪽 = 61dpi 컬러 사진 + 81dpi 투명 배경 로고(SMask) + 600dpi 고해상도 그림(목록에서 빠져야 함)
//                2쪽 = 같은 사진을 폼(Matrix 2배) 안에서 다시 씀 · 3쪽 = 72dpi 흑백 그림(Flate DeviceGray)
//   → 🖼 → '📄 지금 PDF의 저해상도 그림' → 찾기(순서·dpi·폼 안) → 사진·흑백 업스케일, 로고 벡터 → ✔ PDF에 바꿔 넣기
//   → 원본 끝 증분 저장(객체가 새 것) · pdf.js 화면이 바꾸기 전과 같다 · gs 오류 없음 · 3쪽 먹만 · 미리 구운 쪽 편집본도 바뀜
//   → ↺ 되돌리기(원본 길이·편집본 그대로) · 옛 방식(표 xref) PDF에서도 바꿔 넣기
//   실행: node scripts/test/img-enhance-pdf.e2e.js   (창은 TEST_WINDOW=left · 검사용 사용자 폴더)
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const { spawn, execSync, execFileSync, spawnSync } = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const electron = require(path.join(ROOT, 'node_modules', 'electron'));
const PORT = 9372;
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit-iep-'));
const T = `document.querySelector('.ie-modal').parentNode.__ieTest`;
let child;
(async () => {
  try {
    child = spawn(electron, ['.', `--remote-debugging-port=${PORT}`], { cwd: ROOT, stdio: 'ignore', env: Object.assign({}, process.env, { TEST_WINDOW: 'left' }) });
    const ev = await connect();
    await sleep(2500);
    await ev(`window.__errs = []; { const oe = window.showError; window.showError = m => { window.__errs.push(String(m)); try { oe(m); } catch (e) {} }; } window.confirm = () => true; 1`);

    // ── 합성 PDF 두 벌(xref 흐름 · 옛 표) ──
    const made = await ev(`(async () => {
      const mk = (w, h, f, type) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); f(x, w, h); return new Promise(r => c.toBlob(b => b.arrayBuffer().then(a => r(new Uint8Array(a))), type, 0.9)); };
      const photoJ = await mk(240, 160, (x, w, h) => { const g = x.createLinearGradient(0, 0, w, 0); g.addColorStop(0, '#1e5bd8'); g.addColorStop(1, '#f0c040'); x.fillStyle = g; x.fillRect(0, 0, w, h); x.fillStyle = '#c0182c'; x.beginPath(); x.arc(70, 80, 40, 0, 7); x.fill(); x.fillStyle = '#fff'; x.font = 'bold 30px sans-serif'; x.fillText('AB', 140, 95); }, 'image/jpeg');
      const logoP = await mk(160, 100, (x) => { x.clearRect(0, 0, 160, 100); x.fillStyle = '#d81e2c'; x.beginPath(); x.arc(50, 50, 38, 0, 7); x.fill(); x.fillStyle = '#000'; x.fillRect(100, 20, 45, 60); }, 'image/png');
      const hiJ = await mk(1200, 800, (x, w, h) => { x.fillStyle = '#2a8a3a'; x.fillRect(0, 0, w, h); x.fillStyle = '#fff'; x.fillRect(100, 100, 400, 300); }, 'image/jpeg');
      const build = async (objStreams) => {
        const d = await PDFLib.PDFDocument.create();
        const photo = await d.embedJpg(photoJ), logo = await d.embedPng(logoP), hi = await d.embedJpg(hiJ);
        const gw = 200, gpx = new Uint8Array(gw * gw);
        for (let y = 0; y < gw; y++) for (let x = 0; x < gw; x++) gpx[y * gw + x] = (Math.hypot(x - 100, y - 100) < 60 ? 30 : 200) + ((x >> 4) & 1) * 20;
        const grayRef = d.context.register(d.context.flateStream(gpx, { Type: 'XObject', Subtype: 'Image', Width: gw, Height: gw, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));
        const grayRef2 = d.context.register(d.context.flateStream(gpx, { Type: 'XObject', Subtype: 'Image', Width: gw, Height: gw, ColorSpace: 'DeviceGray', BitsPerComponent: 8 }));   // 내용이 같은 별도 객체
        const p1 = d.addPage([595.28, 841.89]);
        p1.drawImage(photo, { x: 50, y: 500, width: 283.46, height: 188.98 });   // 100mm 폭 → 61dpi
        p1.drawImage(logo, { x: 360, y: 560, width: 141.73, height: 88.58 });    // 50mm → 81dpi
        p1.drawImage(hi, { x: 50, y: 100, width: 141.73, height: 94.49 });       // 50mm → 610dpi
        const p2 = d.addPage([595.28, 841.89]);
        const form = d.context.register(d.context.flateStream('q 100 0 0 66.6667 0 0 cm /P Do Q', { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 66.6667], Matrix: [2, 0, 0, 2, 0, 0], Resources: { XObject: { P: photo.ref } } }));
        p2.node.setXObject(PDFLib.PDFName.of('F1'), form); p2.node.setXObject(PDFLib.PDFName.of('G2'), grayRef2);
        p2.node.set(PDFLib.PDFName.of('Contents'), d.context.register(d.context.flateStream('q 1 0 0 1 100 400 cm /F1 Do Q q 150 0 0 150 300 100 cm /G2 Do Q')));
        const p3 = d.addPage([595.28, 841.89]);
        p3.node.setXObject(PDFLib.PDFName.of('G1'), grayRef);
        p3.node.set(PDFLib.PDFName.of('Contents'), d.context.register(d.context.flateStream('q 200 0 0 200 100 500 cm /G1 Do Q')));
        return window.electronAPI.writeTempFile(await d.save({ useObjectStreams: objStreams }), 'pdf');
      };
      return { a: await build(true), b: await build(false) };
    })()`);
    const pdfA = path.join(tmp, '저해상도그림.pdf'), pdfB = path.join(tmp, '옛방식xref.pdf');
    fs.copyFileSync(made.a, pdfA); fs.copyFileSync(made.b, pdfB);
    const headB = fs.readFileSync(pdfB, 'latin1'); ok(/\nxref\n/.test(headB) && !/\/XRef/.test(headB), '시험 PDF B는 옛 방식(표 xref)');

    console.log('📄 문서 열기 · 그림 찾기');
    await ev(`openExternalItems([{ name: '저해상도그림.pdf', path: ${JSON.stringify(pdfA)} }]); 1`);
    ok(await until(ev, `!!(typeof originalPdfBytes !== 'undefined' && originalPdfBytes && pageResults.filter(Boolean).length === 3)`, 60000), '문서 열림 3쪽');
    await sleep(1500);
    // 바꾸기 전 화면(pdf.js 72dpi) · 3쪽에 미리 구운 쪽 편집본(K100·스캔 정리 흉내)
    const before = await ev(`(async () => {
      window.__rend = async (bytes, n) => { const pdf = await openPdfDoc({ data: bytes.slice(0) }).promise; const out = []; for (let i = 1; i <= n; i++) { const pg = await pdf.getPage(i), vp = pg.getViewport({ scale: 1 }); const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); await pg.render({ canvasContext: x, viewport: vp }).promise; out.push(x.getImageData(0, 0, c.width, c.height).data); } await pdf.destroy(); return out; };
      window.__before = await __rend(originalPdfBytes, 3);
      const src = await getSourceDoc(), one = await PDFLib.PDFDocument.create(); const [pg] = await one.copyPages(src, [2]); one.addPage(pg);
      contentEdits.set(2, { model: [], bytes: new Uint8Array(await savePdfDoc(one)), rev: 1, k100: { off: [], n: 0, rgb: false } });
      window.__len0 = originalPdfBytes.length;
      return { len: originalPdfBytes.length };
    })()`);
    await ev(`(() => { const oa = window.askChoice; window.askChoice = async () => { window.askChoice = oa; return 'pdf'; }; openImageEnhance(); return 1; })()`);
    ok(await until(ev, `(() => { const o = document.querySelector('.ie-modal'); return !!(o && o.parentNode.__ieTest && o.parentNode.__ieTest.list.length); })()`, 60000), 'PDF 모드 창 열림');
    const found = await ev(`(() => { const t = ${T}; return { names: t.list.map(S => S.name), dpi: t.list.map(S => Math.round(S.w / (S.wMm / 25.4))), gray: t.list.map(S => S.gray), alpha: t.list.map(S => S.alpha), pages: t.list.map(S => S.pdf.places.length), title: document.querySelector('.ie-modal .merge-title').textContent, btn: document.getElementById('ieOpen').textContent }; })()`);
    ok(found.names.length === 3, '저해상도 그림 3개(600dpi 그림은 뺌) ' + JSON.stringify(found.names));
    ok(JSON.stringify(found.dpi) === '[61,72,81]', '실효 해상도 낮은 순 61·72·81dpi ' + JSON.stringify(found.dpi));
    ok(found.pages[0] === 2 && /1·2쪽/.test(found.names[0]), '사진은 1쪽 + 2쪽 폼 안 두 곳 (폼 Matrix까지 따라감)');
    ok(found.gray[1] && found.alpha[2] && !found.gray[0], '흑백 그림 = 흑백 · 로고 = 투명 배경');
    ok(found.pages[1] === 2 && /2·3쪽/.test(found.names[1]), '내용이 같은 흑백 그림 두 객체(2쪽·3쪽)는 한 줄로 ' + found.names[1]);
    ok(/PDF 안 그림/.test(found.title) && /바꿔 넣기/.test(found.btn), '창 제목·버튼: PDF 안 그림 · ✔ PDF에 바꿔 넣기');

    console.log('🔍✒ 실행 · 바꿔 넣기');
    const ran = await ev(`(async () => {
      const t = ${T};
      t.P.model = 'realesrgan-x4plus'; t.P.size = 'dpi'; t.setMode('up');
      t.list.forEach((S, i) => {});
      await t.run([0]); await t.run([1]);
      t.P.colors = 0; t.setMode('vec'); document.querySelector('#ieList .ie-row[data-i="2"]').click(); await t.run([2]);
      return { picks: t.list.map(S => S.pick), w: t.list.map(S => S.up && S.up.w), vec: t.list[2].vec && t.list[2].vec.stats, tags: [...document.querySelectorAll('#ieList .ie-row')].map(r => r.textContent.replace(/\\s+/g, ' ')), open: !document.getElementById('ieOpen').disabled, errs: window.__errs.slice() };
    })()`);
    ok(JSON.stringify(ran.picks) === '["up","up","vec"]' && ran.w[0] === 960 && ran.w[1] === 800 && ran.open, `실행: 사진 ${ran.w[0]}px · 흑백 ${ran.w[1]}px · 로고 벡터 ${ran.vec && ran.vec.colors}색 → 바꿔 넣기 버튼 켜짐`);
    ok(ran.tags.every(t => /✔ (업스케일|벡터)로/.test(t)), '목록에 ✔ 업스케일로/벡터로 표시');
    await ev(`document.getElementById('ieOpen').click(); 1`);
    ok(await until(ev, `!document.querySelector('.ie-modal') && (tabs.get(activeTabId).ieUndo || []).length === 1`, 120000), '바꿔 넣고 창 닫힘');
    const after = await ev(`(async () => {
      const d = await PDFLib.PDFDocument.load(originalPdfBytes.slice(0)), N = PDFLib.PDFName.of;
      const imgs = []; for (const [ref, o] of d.context.enumerateIndirectObjects()) { if (o && o.dict && /Image|Form/.test(String(o.dict.get(N('Subtype'))))) imgs.push({ ref: String(ref), sub: String(o.dict.get(N('Subtype'))), w: o.dict.get(N('Width')) ? o.dict.get(N('Width')).asNumber() : null, cs: String(o.dict.get(N('ColorSpace')) || ''), f: String(o.dict.get(N('Filter')) || ''), sm: !!o.dict.get(N('SMask')) }); }
      const tail = new TextDecoder('latin1').decode(originalPdfBytes.subarray(__len0, Math.min(originalPdfBytes.length, __len0 + 60)));
      const now = await __rend(originalPdfBytes, 3);
      const diff = now.map((a, i) => { const b = __before[i]; let e = 0; for (let k = 0; k < a.length; k += 4) e += Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]); return e / (a.length / 4) / 3; });
      // 로고 자리(1쪽 x 360~502pt, 위에서 841.89-648.58~) 화소 차 — 투명이 검게 칠해지면 크다
      const W = Math.round(595.28), a = now[0], b = __before[0]; let le = 0, ln = 0;
      for (let y = 196; y < 280; y++) for (let x = 362; x < 500; x++) { const k = (y * W + x) * 4; le += Math.abs(a[k] - b[k]) + Math.abs(a[k + 1] - b[k + 1]) + Math.abs(a[k + 2] - b[k + 2]); ln++; }
      const rec = contentEdits.get(2), rd = await PDFLib.PDFDocument.load(rec.bytes.slice(0));
      let recImg = null; for (const [, o] of rd.context.enumerateIndirectObjects()) if (o && o.dict && String(o.dict.get(N('Subtype'))) === '/Image') recImg = { w: o.dict.get(N('Width')).asNumber(), cs: String(o.dict.get(N('ColorSpace'))) };
      return { len: originalPdfBytes.length, len0: __len0, imgs, tail, diff, logoDiff: le / ln / 3, rec: recImg, k100: !!rec.k100, thumbs: pageResults.map(r => r.thumbnail), path: window.electronAPI.writeTempFile(originalPdfBytes, 'pdf'), errs: window.__errs.slice() };
    })()`);
    ok(after.len > after.len0 && /^\n\d+ 0 obj/.test(after.tail), `원본 끝에 덧붙임(증분 저장) ${after.len0} → ${after.len} 바이트`);
    const photo = after.imgs.find(i => i.w === 960), gray = after.imgs.find(i => i.w === 800), form = after.imgs.filter(i => i.sub === '/Form');
    ok(photo && /DCT/.test(photo.f) && /RGB/.test(photo.cs), '사진 → 960px RGB JPEG');
    ok(gray && /Gray/.test(gray.cs) && /DCT/.test(gray.f), '흑백 → 800px DeviceGray JPEG(1성분)');
    ok(after.imgs.filter(i => i.w === 800).length === 2, '한 줄로 묶은 같은 그림 두 객체 모두 바뀜');
    ok(form.length >= 2, '로고 → 폼(벡터)으로 · 2쪽 폼도 그대로 (폼 ' + form.length + ')');
    ok(after.diff.every(v => v < 9), '바꾼 뒤 화면 = 바꾸기 전 (쪽별 평균 차 ' + after.diff.map(v => v.toFixed(2)).join(' · ') + ')');
    ok(after.logoDiff < 20, '투명 배경 로고 자리가 검게 칠해지지 않음 (평균 차 ' + after.logoDiff.toFixed(1) + ')');
    ok(after.rec && after.rec.w === 800 && /Gray/.test(after.rec.cs) && after.k100, '미리 구운 3쪽 편집본 안의 같은 그림도 바뀜(편집 정보 그대로)');
    ok(!after.errs.length, '오류 없음 ' + after.errs.join(' | '));
    const gs = gsExe();
    if (gs) {
      const r = spawnSync(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-dPDFSTOPONERROR', '-sDEVICE=nullpage', after.path], { encoding: 'utf8' });
      ok(r.status === 0 && !/error|warning|repair/i.test((r.stdout || '') + (r.stderr || '')), 'gs: 증분 저장한 PDF를 오류·복구 없이 읽음 ' + ((r.stdout || '') + (r.stderr || '')).slice(0, 200));
      const ink = execFileSync(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-sDEVICE=inkcov', '-dFirstPage=3', '-dLastPage=3', '-o', '-', after.path], { encoding: 'utf8' }).trim().split(/\s+/).slice(0, 4).map(Number);
      ok(ink[0] + ink[1] + ink[2] === 0 && ink[3] > 0, `3쪽(흑백 그림) 먹만 — C ${ink[0]} M ${ink[1]} Y ${ink[2]} K ${ink[3]}`);
    }
    if (process.env.IE_KEEP) fs.copyFileSync(after.path, process.env.IE_KEEP + "/pdf-after.pdf");
    try { fs.unlinkSync(after.path); } catch (e) {}

    console.log('↺ 되돌리기');
    const und = await ev(`(async () => {
      const oa = window.askChoice; let asked = ''; window.askChoice = async (m, ch) => { window.askChoice = oa; asked = ch.map(c => c.label).join(' | '); return 'undo'; };
      await openImageEnhance();
      const rec = contentEdits.get(2), rd = await PDFLib.PDFDocument.load(rec.bytes.slice(0)), N = PDFLib.PDFName.of;
      let w = null; for (const [, o] of rd.context.enumerateIndirectObjects()) if (o && o.dict && String(o.dict.get(N('Subtype'))) === '/Image') w = o.dict.get(N('Width')).asNumber();
      return { asked, len: originalPdfBytes.length, len0: __len0, recW: w, left: (tabs.get(activeTabId).ieUndo || []).length };
    })()`);
    ok(/되돌리기 \(3개\)/.test(und.asked), '🖼 버튼에서 되돌리기 고르기 ' + und.asked);
    ok(und.len === und.len0 && und.recW === 200 && und.left === 0, `되돌림: 원본 길이 ${und.len}(처음 ${und.len0}) · 3쪽 편집본 그림 ${und.recW}px`);

    // ── 옛 방식(표 xref) PDF ──
    console.log('📄 옛 방식 xref PDF');
    await ev('window.__errs = []; 1');
    await ev(`openExternalItems([{ name: '옛방식xref.pdf', path: ${JSON.stringify(pdfB)} }], { mode: 'tab' }); 1`);
    ok(await until(ev, `!!(document.title && originalPdfBytes && pageResults.filter(Boolean).length === 3 && originalPdfBytes.length !== __len0)`, 60000), 'B 열림');
    await sleep(1500);
    await ev(`(() => { const oa = window.askChoice; window.askChoice = async () => { window.askChoice = oa; return 'pdf'; }; openImageEnhance(); return 1; })()`);
    await until(ev, `(() => { const o = document.querySelector('.ie-modal'); return !!(o && o.parentNode.__ieTest && o.parentNode.__ieTest.list.length); })()`, 60000);
    const b = await ev(`(async () => {
      const t = ${T}; t.P.model = 'realesr-animevideov3'; t.P.size = '2'; t.setMode('up'); await t.run([1]);
      const len0 = originalPdfBytes.length;
      document.getElementById('ieOpen').click();
      for (let i = 0; i < 300 && document.querySelector('.ie-modal'); i++) await new Promise(r => setTimeout(r, 200));
      const tail = new TextDecoder('latin1').decode(originalPdfBytes.subarray(len0));
      return { tail: tail.slice(-260), path: window.electronAPI.writeTempFile(originalPdfBytes, 'pdf'), grew: originalPdfBytes.length > len0, errs: window.__errs.slice() };
    })()`);
    ok(b.grew && /\nxref\n/.test(b.tail) && /trailer/.test(b.tail) && /\/Prev \d+/.test(b.tail), '옛 방식 PDF엔 표 xref + trailer(/Prev)로 덧붙임');
    if (gs) {
      const r = spawnSync(gs, ['-q', '-dNOPAUSE', '-dBATCH', '-dPDFSTOPONERROR', '-sDEVICE=nullpage', b.path], { encoding: 'utf8' });
      ok(r.status === 0 && !/error|warning|repair/i.test((r.stdout || '') + (r.stderr || '')), 'gs: 표 xref 증분 저장도 오류 없이 읽음 ' + ((r.stdout || '') + (r.stderr || '')).slice(0, 200));
    }
    try { fs.unlinkSync(b.path); } catch (e) {}
    ok(!b.errs.length, '오류 없음 ' + b.errs.join(' | '));
  } catch (e) {
    fail++; console.log('  ✘ 예외: ' + (e && e.stack || e));
  } finally {
    try { if (child) execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' }); } catch (e) {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
    console.log(`\n결과: 통과 ${pass} · 실패 ${fail}`);
    process.exit(fail ? 1 : 0);
  }
})();
