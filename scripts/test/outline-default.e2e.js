// ✒ 폰트 출력 안전화 — 기본이 '켜짐 + 폰트 완전 임베드'인지, 끄면 그 선택이 기억되는지.
//   실행: npx electron scripts/test/outline-default.e2e.js
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };

const READ = `(() => ({
  enabled: _outlineEnabled,
  mode: _outlineMode,
  sideBtn: (document.getElementById('olOnBtn') || {}).className || '',
  mainBtn: (document.getElementById('opt-outline') || {}).className || '',
  embedChip: (document.querySelector('[data-olmode="embed"]') || {}).className || '',
  outlineChip: (document.querySelector('[data-olmode="outline"]') || {}).className || '',
  stored: (() => { try { return localStorage.getItem('outlineOn'); } catch (e) { return null; } })(),
}))()`;

async function fresh(clear) {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  if (clear) { try { await win.webContents.session.clearStorageData({ storages: ['localstorage'] }); } catch (e) {} }
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 1600));
  return win;
}

app.whenReady().then(async () => {
  try {
    // 저장소를 비운 '처음 설치' 상태
    let win = await fresh(true);
    const a = await win.webContents.executeJavaScript(READ);
    console.log('\n[1] 처음 켤 때 — 기본 켜짐 + 완전 임베드');
    ck('안전화가 켜져 있다', a.enabled === true, a.enabled);
    ck('방식은 폰트 완전 임베드', a.mode === 'embed', a.mode);
    ck('사이드바 버튼이 켜짐 표시', /\bactive\b/.test(a.sideBtn), a.sideBtn);
    ck('메인 처리옵션 버튼도 켜짐 표시', /\bactive\b/.test(a.mainBtn), a.mainBtn);
    ck('완전 임베드 칩이 선택됨', /\bactive\b/.test(a.embedChip), a.embedChip);
    ck('곡선화 칩은 선택 안 됨', !/\bactive\b/.test(a.outlineChip), a.outlineChip);
    ck('방식 칩이 흐리지 않음(켜져 있으므로)', !/\bdim\b/.test(a.embedChip), a.embedChip);

    // 사용자가 끄면 기억한다
    await win.webContents.executeJavaScript('setOutlineEnabled(false)');
    await new Promise(r => setTimeout(r, 300));
    const b = await win.webContents.executeJavaScript(READ);
    console.log('\n[2] 사용자가 끄면');
    ck('꺼짐 상태', b.enabled === false, b.enabled);
    ck('선택이 저장됨', b.stored === '0', b.stored);
    ck('방식 칩이 흐려짐', /\bdim\b/.test(b.embedChip), b.embedChip);
    // 같은 창을 다시 읽어 '앱 재시작'을 흉내낸다 (localStorage는 유지된다)
    await win.loadFile(path.join(ROOT, 'src/index.html'));
    await new Promise(r => setTimeout(r, 1600));
    const c = await win.webContents.executeJavaScript(READ);
    console.log('\n[3] 껐던 선택은 다음에도 유지');
    ck('여전히 꺼짐', c.enabled === false, c.enabled);
    ck('버튼도 꺼짐 표시', !/\bactive\b/.test(c.sideBtn), c.sideBtn);

    // 다시 켜면 완전 임베드로
    await win.webContents.executeJavaScript('setOutlineEnabled(true)');
    await new Promise(r => setTimeout(r, 300));
    const d = await win.webContents.executeJavaScript(READ);
    console.log('\n[4] 다시 켜면');
    ck('켜짐 + 완전 임베드', d.enabled === true && d.mode === 'embed', [d.enabled, d.mode]);
    ck('저장값도 켜짐', d.stored === '1', d.stored);
  } catch (e) { console.log('  ✘ 하네스 오류:', e && e.message); fail++; }
  console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
  app.exit(fail ? 1 : 0);
});
