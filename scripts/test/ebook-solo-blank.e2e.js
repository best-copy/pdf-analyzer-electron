// 📄 단면 — 왼쪽 백지가 '흰 종이'로 남아 있는지 픽셀로 확인.
//   넘김이 끝난 뒤 백지가 사라져 보이면(무대 배경색이 비치면) 실패.
//   실행: npx electron scripts/test/ebook-solo-blank.e2e.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

function loadCore() {
  const src = fs.readFileSync(path.join(ROOT, 'src/app-process.js'), 'utf8');
  const s = src.indexOf('// <EBOOK-CORE>'), e = src.indexOf('// </EBOOK-CORE>');
  return new Function(src.slice(s, e) + '\nreturn { buildEbookProofHtml };')();
}
const pageImg = () => ({
  u: 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="595"><rect width="420" height="595" fill="rgb(90,140,220)"/></svg>'),
  w: 420, h: 595,
});

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

app.whenReady().then(async () => {
  const { buildEbookProofHtml } = loadCore();
  const mk = (view) => {
    const html = buildEbookProofHtml({
      title: '백지 검증', book: Array.from({ length: 8 }, pageImg), sheets: [],
      meta: { mm: [148, 210], bind: 'left', view }, opts: { coverSingle: true },
    });
    const f = path.join(os.tmpdir(), `pdfedit_blank_${view}_${Date.now()}.html`);
    fs.writeFileSync(f, html, 'utf8'); return f;
  };
  const win = new BrowserWindow({ show: true, width: 1200, height: 860 });
  try { await win.webContents.session.clearStorageData({ storages: ['localstorage'] }); } catch (e) {}

  const probe = async (f, advance) => {
    await win.loadFile(f);
    await new Promise(r => setTimeout(r, 900));
    // 단면의 왼쪽 흰 면은 '앞장의 뒷면'이라 가운데 쪽에서만 있다 —
    // 첫 장은 앞에 넘긴 장이 없어 한 면만 보인다(그래서 몇 쪽 넘긴 뒤 잰다).
    for (let k = 0; k < (advance || 0); k++) {
      await win.webContents.executeJavaScript(
        "document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
      await win.webContents.executeJavaScript(`(async () => {
        for (let q = 0; q < 120; q++) {
          if (!document.querySelector('.leaf')) return true;
          await new Promise(r => setTimeout(r, 50));
        } return false;
      })()`);
      await new Promise(r => setTimeout(r, 250));
    }
    const g = await win.webContents.executeJavaScript(`(() => {
      const b = document.querySelector('.spread .pg'); if (!b) return null;   // 왼쪽 면
      const r = b.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    if (!g) return null;
    const shot = async () => {
      const im = await win.webContents.capturePage(
        { x: g.x + Math.round(g.w * 0.4), y: g.y + Math.round(g.h * 0.5), width: 4, height: 2 });
      const bm = im.toBitmap();
      return Math.round((bm[0] + bm[1] + bm[2]) / 3);
    };
    await shot();                       // 첫 캡처는 합성 전이라 비어 나온다 — 버린다
    const before = await shot();
    await win.webContents.executeJavaScript(
      "document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
    await new Promise(r => setTimeout(r, 2000));      // 넘김 완료까지
    const after = await shot();
    return { before, after };
  };

  try {
    const fSolo = mk('single'), fSpread = mk('spread');
    console.log('\n[1] 단면 가운데 쪽 — 왼쪽(앞장의 뒷면)은 늘 흰 종이');
    const a = await probe(fSolo, 2);
    ck('넘김 전 왼쪽이 흰 종이', a.before >= 235, a.before);
    ck('넘김 후에도 왼쪽이 흰 종이', a.after >= 235, a.after);
    ck('넘김 전후 밝기가 유지됨', Math.abs(a.after - a.before) <= 8, a);

    // 첫 장은 앞에 넘긴 장이 없으므로 왼쪽 면 자체가 없어야 한다(닫힌 앞표지)
    const first = await probe(fSolo, 0);
    ck('첫 장은 왼쪽 면 자체가 없다(어두운 배경)', first.before < 80, first.before);

    console.log('\n[2] 양면 — 표지 맞은편 빈 자리는 종이가 아니라 빈 공간(어둡다)');
    const b = await probe(fSpread);
    ck('표지 맞은편은 어두운 빈 자리', b.before < 80, b.before);

    for (const f of [fSolo, fSpread]) { try { fs.unlinkSync(f); } catch (e) {} }
  } catch (e) { console.log('  ✘ 하네스 오류:', e && e.message); fail++; }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  app.exit(fail ? 1 : 0);
});
