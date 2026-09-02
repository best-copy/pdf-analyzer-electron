// 📄 단면(한 쪽씩) 낱장 뒷면 검증 — 넘기는 도중 종이의 뒷면이 **백지**여야 한다.
//   (예전에는 뒷면에 다음 쪽 그림이 들어가, 아직 오지 않은 페이지가 비쳐 보였다)
//   실행: npx electron scripts/test/ebook-solo-back.e2e.js
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
const pageImg = (hue) => ({
  u: 'data:image/svg+xml;utf8,' + encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="595"><rect width="420" height="595" fill="hsl(${hue},80%,50%)"/></svg>`),
  w: 420, h: 595,
});

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

async function faces(win, view) {
  const { buildEbookProofHtml } = loadCore();
  const html = buildEbookProofHtml({
    title: '뒷면 검증', book: [0, 120, 240, 30, 150, 270].map(pageImg), sheets: [],
    meta: { mm: [148, 210], bind: 'left', view }, opts: { coverSingle: true },
  });
  const f = path.join(os.tmpdir(), `pdfedit_back_${view}_${Date.now()}.html`);
  fs.writeFileSync(f, html, 'utf8');
  await win.loadFile(f);
  await new Promise(r => setTimeout(r, 900));
  const out = await win.webContents.executeJavaScript(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await new Promise(r => setTimeout(r, 300));          // 넘김 중간
    const leaf = document.querySelector('.leaf');
    if (!leaf) return { err: '낱장 없음' };
    const front = [...leaf.querySelectorAll('.sfc:not(.sbc)')];
    const back  = [...leaf.querySelectorAll('.sfc.sbc')];
    const hasImg = (el) => {
      const b = el.style.backgroundImage || '';
      return b && b !== 'none';
    };
    return {
      strips: front.length,
      frontWithImg: front.filter(hasImg).length,
      backWithImg: back.filter(hasImg).length,
      backBg: back.length ? getComputedStyle(back[0]).backgroundColor : '',
    };
  })()`);
  try { fs.unlinkSync(f); } catch (e) {}
  return out;
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1200, height: 860 });
  try { await win.webContents.session.clearStorageData({ storages: ['localstorage'] }); } catch (e) {}
  try {
    console.log('\n[1] 단면(한 쪽씩) — 뒷면은 백지여야 한다');
    const a = await faces(win, 'single');
    ck('낱장 조각이 만들어짐', a.strips > 0, a);
    ck('앞면에는 지금 쪽 그림이 있다', a.frontWithImg === a.strips, a);
    ck('뒷면에는 그림이 하나도 없다', a.backWithImg === 0, a);
    ck('뒷면 바탕은 흰 종이', a.backBg === 'rgb(255, 255, 255)', a.backBg);

    console.log('\n[2] 양면(펼침) — 대조군: 뒷면에 다음 쪽이 인쇄돼 있다');
    const b = await faces(win, 'spread');
    ck('뒷면에도 그림이 있다', b.backWithImg === b.strips && b.strips > 0, b);
  } catch (e) {
    console.log('  ✘ 하네스 오류:', e && e.message); fail++;
  }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  app.exit(fail ? 1 : 0);
});
