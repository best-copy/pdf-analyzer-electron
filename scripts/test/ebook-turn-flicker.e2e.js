// 🎞 E-book 넘김 진단 — 넘기는 동안 프레임마다 화면 상태를 페이지 안에서 직접 기록해
//   ① 착지 순간 그림이 비는지(깜박임) ② 책등 그늘 농도가 끊기는지를 수치로 본다.
//   실행: npx electron scripts/test/ebook-turn-flicker.e2e.js [single|spread]
//   ⚠ show:true — 숨김 창은 rAF가 1fps로 조여져 프레임이 안 돈다.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { leftWin } = require('./_leftwin');   // 검사 창은 늘 가장 왼쪽 모니터에
const ROOT = path.join(__dirname, '..', '..');
const MODE = process.argv.includes('single') ? 'single' : 'spread';

function loadCore() {
  const src = fs.readFileSync(path.join(ROOT, 'src/app-process.js'), 'utf8');
  const s = src.indexOf('// <EBOOK-CORE>'), e = src.indexOf('// </EBOOK-CORE>');
  return new Function(src.slice(s, e) + '\nreturn { buildEbookProofHtml };')();
}
// 쪽마다 다른 색 + 큼직한 JPEG data URI 흉내(디코드 지연을 재현하려면 실제로 무거워야 한다)
function pageImg(hue) {
  let rects = '';
  for (let i = 0; i < 400; i++) rects += `<rect x="${(i * 7) % 400}" y="${(i * 13) % 560}" width="18" height="30" fill="hsl(${(hue + i) % 360},60%,${40 + (i % 40)}%)"/>`;
  return {
    u: 'data:image/svg+xml;utf8,' + encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="595"><rect width="420" height="595" fill="hsl(${hue},50%,70%)"/>${rects}</svg>`),
    w: 420, h: 595,
  };
}

app.whenReady().then(async () => {
  const { buildEbookProofHtml } = loadCore();
  const html = buildEbookProofHtml({
    title: '넘김 진단', book: [0, 45, 90, 135, 180, 225, 270, 315].map(pageImg), sheets: [],
    meta: { mm: [148, 210], bind: 'left', view: MODE },
    opts: { coverSingle: true },
  });
  const f = path.join(os.tmpdir(), `pdfedit_flick_${Date.now()}.html`);
  fs.writeFileSync(f, html, 'utf8');

  const win = new BrowserWindow({ show: true, width: 1200, height: 860, ...leftWin(1200, 860) });
  try { await win.webContents.session.clearStorageData({ storages: ['localstorage'] }); } catch (e) {}
  await win.loadFile(f);
  await new Promise(r => setTimeout(r, 1200));

  let rows;
  try {
  rows = await win.webContents.executeJavaScript(`(async () => {
    const log = [];
    let stop = false;
    const sample = () => {
      const imgs = [...document.querySelectorAll('.spread .pg img')];
      const leaf = document.querySelector('.leaf');
      const gu = document.querySelector('.spread .pg .gut');
      const gt = document.querySelector('.spread .gtop');   // 넘기는 동안 낱장 위를 덮는 제본선 그늘
      const fg = leaf ? leaf.querySelector('.stgu') : null;
      const bg = leaf ? leaf.querySelectorAll('.stgu')[1] : null;
      log.push({
        t: Math.round(performance.now()),
        leaf: !!leaf,
        imgs: imgs.length,
        // 아직 디코드가 안 끝난 그림 — 이 프레임에 흰 자리가 보인다는 뜻
        undecoded: imgs.filter(im => !im.complete || !im.naturalWidth).length,
        gut: gu ? +(getComputedStyle(gu).opacity) : null,
        // 그 프레임에 **실제로 보이는** 제본선 그늘 — 덮개(.gtop)가 있으면 그것, 없으면 펼침면의 골.
        // 낱장이 살아 있는데 덮개가 없으면 낱장(z:9)이 골(z:auto)을 가려 책등이 허옇게 뜬다.
        spine: gt ? +(getComputedStyle(gt).opacity) : ((gu && getComputedStyle(gu).display !== 'none') ? +(getComputedStyle(gu).opacity) : 0),
        covered: !!(leaf && !gt && gu && getComputedStyle(gu).display !== 'none'),
        // 착지해 녹는 낱장은 조각(.st)이 아니라 **평평한 한 장**이어야 한다 —
        // 조각인 채로 녹이면 이음매가 아래 페이지와 어긋나 자잘하게 떨려 보인다.
        landStrips: !!(leaf && leaf.classList.contains('land') && leaf.querySelector('.st')),
        leafGutF: fg ? +fg.style.opacity : null,
        leafGutB: bg ? +bg.style.opacity : null,
      });
    };
    const loop = () => { if (stop) return; sample(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise(r => setTimeout(r, 2200));
    stop = true;
    return log;
  })()`);
  } catch (e) { console.log('  ✘ 하네스 오류:', e && e.message); app.exit(1); return; }

  console.log(`\n=== ${MODE} 넘김 · 프레임 ${rows.length}장 ===`);
  const turnFrames = rows.filter(r => r.leaf).length;
  console.log(`  낱장(.leaf)이 살아 있던 프레임: ${turnFrames}  → ${turnFrames > 10 ? '펼침(넘김) 연출 있음' : '⚠ 연출 없이 교체'}`);
  const bad = rows.filter(r => r.undecoded > 0);
  console.log(`  그림이 아직 안 그려진 프레임: ${bad.length}장` + (bad.length ? `  (t=${bad.map(b => b.t - rows[0].t).join(',')})` : ''));
  // 착지 전후 책등 그늘 농도 흐름
  const strp = rows.filter(r => r.landStrips).length;
  console.log(`  조각인 채로 녹은 프레임: ${strp}장` + (strp ? '  ⚠ 이음매가 어긋나 페이지가 떨린다' : '  ✔ 평평한 한 장으로 녹음'));
  const cov = rows.filter(r => r.covered).length;
  console.log(`  낱장이 제본선 골을 덮은 프레임: ${cov}장` + (cov ? '  ⚠ 착지 순간 책등이 밝아진다(깜박임)' : '  ✔ 없음'));
  const gline = rows.map(r => (r.spine != null ? r.spine : 0));
  let jump = 0, jat = -1;
  for (let k = 1; k < gline.length; k++) { const d = Math.abs(gline[k] - gline[k - 1]); if (d > jump) { jump = d; jat = k; } }
  console.log(`  책등 그늘 프레임 간 최대 변화: ${jump.toFixed(3)} (프레임 ${jat}/${gline.length})`);
  console.log('  그늘 흐름:', gline.filter((_, k) => k % 3 === 0).map(v => v.toFixed(2)).join(' '));
  try { fs.unlinkSync(f); } catch (e) {}
  // 착지 회귀(조각인 채 녹음·골 덮임)는 실패로 끝낸다 — 로그만 찍으면 다시 생겨도 모른다
  app.exit(strp || cov ? 1 : 0);
});
