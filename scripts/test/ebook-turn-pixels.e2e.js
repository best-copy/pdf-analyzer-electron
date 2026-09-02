// 🎞 넘김 중 실제 화면 픽셀 — 책등 근처와 페이지 안쪽 밝기를 시간순으로 찍는다.
//   실행: npx electron scripts/test/ebook-turn-pixels.e2e.js [single|spread]
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');
const MODE = process.argv.includes('single') ? 'single' : 'spread';
const BSTYLE = process.argv.includes('twinring') ? 'twinring' : 'book';
// --nocover: 표지 단독 없이 시작 — 표지↔펼침면 '미끄러짐' 없이 순수한 넘김만 잰다
const NOCOVER = process.argv.includes('--nocover');

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
    title: '픽셀 진단', book: Array.from({ length: 8 }, pageImg), sheets: [],
    meta: { mm: [148, 210], bind: 'left', view: MODE, bindStyle: BSTYLE }, opts: { coverSingle: !NOCOVER },
  });
  const f = path.join(os.tmpdir(), `pdfedit_px_${Date.now()}.html`);
  fs.writeFileSync(f, html, 'utf8');

  const win = new BrowserWindow({ show: true, width: 1200, height: 860 });
  try { await win.webContents.session.clearStorageData({ storages: ['localstorage'] }); } catch (e) {}
  await win.loadFile(f);
  await new Promise(r => setTimeout(r, 1200));

  const g = await win.webContents.executeJavaScript(`(() => {
    const bs = [...document.querySelectorAll('.spread .pg')];
    const b = bs[bs.length - 1]; if (!b) return null;      // 오른쪽(넘어가는) 면
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  if (!g) { console.log('  ✘ 상자 없음'); app.exit(1); return; }

  // 세로 한 줄만 캡처 — 좁은 rect라 프레임당 비용이 작다
  const rect = { x: g.x, y: g.y + Math.round(g.h / 2), width: g.w, height: 2 };
  const shot = async () => {
    const im = await win.webContents.capturePage(rect);
    const bm = im.toBitmap(); const w = im.getSize().width;
    const at = (fx) => { const x = Math.max(0, Math.min(w - 1, Math.round(w * fx))); const o = x * 4;
      return Math.round((bm[o] + bm[o + 1] + bm[o + 2]) / 3); };
    return { spine: at(0.02), q: at(0.25), mid: at(0.5), out: at(0.95) };
  };

  const before = await shot();
  await win.webContents.executeJavaScript(
    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");   // 오른쪽 면이 넘어간다
  const seq = [];
  const t0 = Date.now();
  const WAIT=+(process.argv.find(a=>/^--wait=/.test(a))||"--wait=0").split("=")[1];
  const STEP=+(process.argv.find(a=>/^--step=/.test(a))||"--step=110").split("=")[1];
  if(WAIT) await new Promise(r=>setTimeout(r,WAIT));
  for (let k = 0; k < 18; k++) {
    seq.push({ t: Date.now() - t0, ...(await shot()) });
    await new Promise(r => setTimeout(r, STEP));
  }
  await new Promise(r => setTimeout(r, 700));
  const after = await shot();

  console.log(`\n=== ${MODE} · 페이지 가로선 밝기 (0=검정 255=흰색) ===`);
  console.log('  구간        책등쪽  1/4   가운데  바깥');
  const row = (n, v) => console.log('  ' + n.padEnd(11) + String(v.spine).padStart(5) + String(v.q).padStart(6) + String(v.mid).padStart(7) + String(v.out).padStart(7));
  row('넘김 전', before);
  for (const s of seq) row(`t=${s.t}ms`, s);
  row('착지 후', after);
  let j = 0, jat = '';
  for (let k = 1; k < seq.length; k++) { const d = Math.abs(seq[k].spine - seq[k - 1].spine); if (d > j) { j = d; jat = `${seq[k - 1].t}→${seq[k].t}ms`; } }
  const land = Math.abs(after.spine - seq[seq.length - 1].spine);
  console.log(`\n  책등 밝기 최대 급변: ${j} (${jat}) · 착지 순간 변화: ${land}`);
  try { fs.unlinkSync(f); } catch (e) {}
  app.exit(0);
});
