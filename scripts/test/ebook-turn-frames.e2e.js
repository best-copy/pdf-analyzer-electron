// 🎞 넘김 프레임 단위 진단 — beginFrameSubscription으로 **합성된 모든 프레임**을 받아
//   책등 밝기를 프레임마다 기록한다. (capturePage 폴링은 100ms 간격이라 한 프레임 튐을 놓친다)
//   실행: npx electron scripts/test/ebook-turn-frames.e2e.js [single|spread]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');
const MODE = process.argv.includes('single') ? 'single' : 'spread';
const BSTYLE = process.argv.includes('twinring') ? 'twinring' : 'book';

function loadCore() {
  const src = fs.readFileSync(path.join(ROOT, 'src/app-process.js'), 'utf8');
  const s = src.indexOf('// <EBOOK-CORE>'), e = src.indexOf('// </EBOOK-CORE>');
  return new Function(src.slice(s, e) + '\nreturn { buildEbookProofHtml };')();
}
const pageImg = () => ({    // 균일한 흰 종이 — 그늘 농도가 밝기로 그대로 나온다
  u: 'data:image/svg+xml;utf8,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="420" height="595"><rect width="420" height="595" fill="rgb(250,250,250)"/></svg>'),
  w: 420, h: 595,
});

app.whenReady().then(async () => {
  const { buildEbookProofHtml } = loadCore();
  const html = buildEbookProofHtml({
    title: '프레임 진단', book: Array.from({ length: 8 }, pageImg), sheets: [],
    meta: { mm: [148, 210], bind: 'left', view: MODE, bindStyle: BSTYLE }, opts: { coverSingle: false },
  });
  const f = path.join(os.tmpdir(), `pdfedit_fr_${Date.now()}.html`);
  fs.writeFileSync(f, html, 'utf8');

  const win = new BrowserWindow({ show: true, width: 1200, height: 860 });
  try { await win.webContents.session.clearStorageData({ storages: ['localstorage'] }); } catch (e) {}
  await win.loadFile(f);
  await new Promise(r => setTimeout(r, 1200));

  // 오른쪽(넘어가는) 면의 책등 쪽 좌표
  const g = await win.webContents.executeJavaScript(`(() => {
    const bs = [...document.querySelectorAll('.spread .pg')];
    const b = bs[bs.length - 1]; if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  if (!g) { console.log('  ✘ 상자 없음'); app.exit(1); return; }

  const sx = g.x + Math.max(1, Math.round(g.w * 0.02));   // 책등 바로 옆
  const mx = g.x + Math.round(g.w * 0.5);                 // 페이지 한가운데
  const py = g.y + Math.round(g.h * 0.5);

  const frames = [];
  const t0 = Date.now();
  // ⚠ 구독으로 오는 프레임은 **기기 픽셀** 크기다(창 CSS 폭과 다를 수 있다) — 배율을 맞춰야
  //   엉뚱한 자리를 재게 된다. 또 전체 비트맵을 뜨면 느려서 프레임을 놓치므로 잘라서 본다.
  let scale = 0;
  let below = () => 0;
  win.webContents.beginFrameSubscription(false, (image) => {
    try {
      if (!scale) scale = image.getSize().width / win.getContentSize()[0];
      const cut = image.crop({ x: Math.round(sx * scale), y: Math.round(py * scale),
                               width: Math.max(1, Math.round((mx - sx) * scale)), height: 2 });
      // 책 아래(drop-shadow가 떨어지는 자리)도 함께 본다 — 낱장이 실루엣을 바꾸면 여기가 출렁인다
      const bcut = image.crop({ x: Math.round(mx * scale), y: Math.round((g.y + g.h + 26) * scale), width: 2, height: 2 });
      const bbm = bcut.toBitmap();
      below = () => Math.round((bbm[0] + bbm[1] + bbm[2]) / 3);
      const bm = cut.toBitmap();
      const w = cut.getSize().width;
      const at = (fx) => { const o = Math.min(w - 1, Math.round(fx * (w - 1))) * 4;
        return Math.round((bm[o] + bm[o + 1] + bm[o + 2]) / 3); };
      frames.push({ t: Date.now() - t0, spine: at(0.02), mid: at(0.96), below: below() });
    } catch (e) {}
  });

  await new Promise(r => setTimeout(r, 250));
  await win.webContents.executeJavaScript(
    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
  await new Promise(r => setTimeout(r, 2600));
  win.webContents.endFrameSubscription();

  // 변화가 있는 프레임만 추려서 본다 (정지 구간은 같은 값이 반복된다)
  const rows = frames.filter((f, i) => i === 0 || f.spine !== frames[i - 1].spine || f.mid !== frames[i - 1].mid || f.below !== frames[i - 1].below);
  console.log(`\n=== ${MODE} · 합성 프레임 ${frames.length}장 (값이 바뀐 프레임 ${rows.length}장) ===`);
  console.log('  t(ms)  책등  가운데  책아래   책등 변화');
  let worst = 0, worstAt = 0;
  for (let i = 0; i < rows.length; i++) {
    const d = i ? rows[i].spine - rows[i - 1].spine : 0;
    if (Math.abs(d) > Math.abs(worst)) { worst = d; worstAt = rows[i].t; }
    console.log('  ' + String(rows[i].t).padStart(5) + String(rows[i].spine).padStart(6)
      + String(rows[i].mid).padStart(8) + String(rows[i].below).padStart(8)
      + (i ? String(d > 0 ? '+' + d : d).padStart(10) : ''));
  }
  console.log(`\n  ▶ 책등 프레임 간 최대 급변: ${worst > 0 ? '+' + worst : worst} (t=${worstAt}ms)`);
  try { fs.unlinkSync(f); } catch (e) {}
  app.exit(0);
});
