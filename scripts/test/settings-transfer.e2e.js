// ⚙ 설정 내보내기 / 가져오기 — 다른 PC로 지금 쓰는 상태 그대로
//   실행: npx electron scripts/test/settings-transfer.e2e.js   (창 없음)
// 사용자 요청(2026-10-27). 'PC A'(사용자 폴더 A)에서 설정을 만들고 내보낼 JSON을 꺼내, 'PC B'(빈 사용자 폴더 B)에서
// 가져오기 → 같은 값·프리셋이 실제로 쓰이는지, 백업으로 되돌리기, 잘못된 파일 거부, 비밀값 제외를 확인한다.
// 화면: 첫 화면 머리의 ⬆/⬇ 버튼과 왼쪽 패널 ⚙ 버튼. 결과 그림은 임시 폴더 settings-header.png.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { app, BrowserWindow, session } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-settings-A'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };

async function openWin(partition) {
  const win = new BrowserWindow({ show: false, width: 1300, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false, partition } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  return win;
}

app.whenReady().then(async () => {
  try {
    // 두 PC = 서로 다른 저장소(파티션) — localStorage가 따로다
    const A = await openWin('persist:pcA-' + Date.now());
    const exported = await A.webContents.executeJavaScript(`(async () => {
      localStorage.clear();
      localStorage.setItem('uiTheme', 'light');
      localStorage.setItem('quoteDefaultPrices', JSON.stringify({ color: 350, bw: 60 }));
      localStorage.setItem('customPapers', JSON.stringify([{ name: '219x312', w: 219, h: 312 }]));
      localStorage.setItem('impCropStyle', JSON.stringify({ shape: 'double', gap: 3, len: 5, th: 0.25, center: true }));
      localStorage.setItem('aiImageApiKey', 'sk-test-secret');
      const list = loadImpProfiles();
      list.push({ n: '복제2부_위아래_219x312_블리드1mm', m: 'dup', sc: 'orig', al: 'cc', sw: 219, sh: 312, hg: 2, vg: 2, cr: 1, sd: 2, dd: 'v', bg: 1, cs: { shape: 'corner', gap: 2, len: 4, th: 0.3, center: false } });
      saveImpProfiles(list);
      const items = collectAppSettings(false);
      const withSecret = collectAppSettings(true);
      return { text: JSON.stringify({ format: 'pdf-editor-settings', v: 1, exportedAt: new Date().toISOString(), secrets: false, count: Object.keys(items).length, items }),
               n: Object.keys(items).length, hasSecret: 'aiImageApiKey' in items, secretWhenAsked: withSecret.aiImageApiKey === 'sk-test-secret',
               profiles: list.length };
    })()`);
    console.log('⚙ 설정 옮기기');
    ok(exported.n >= 5 && !exported.hasSecret && exported.secretWhenAsked, `내보낼 항목 ${exported.n}개 · API 키는 기본 제외(물으면 포함)`);

    // 첫 화면 머리 그림
    const img = await A.webContents.capturePage({ x: 0, y: 0, width: 700, height: 160 });
    const png = path.join(os.tmpdir(), 'settings-header.png');
    fs.writeFileSync(png, img.toPNG());
    const head = await A.webContents.executeJavaScript(`(() => {
      const r = id => { const e = document.getElementById(id); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, vis: b.width > 0 && getComputedStyle(e).visibility !== 'hidden' }; };
      const rg = document.createRange(); rg.selectNodeContents(document.querySelector('.header h1')); const h1 = rg.getBoundingClientRect();   // 제목 글자가 차지하는 범위(h1 칸은 가로 전체)
      const theme = document.querySelector('.theme-seg:not(.cfg-seg)').getBoundingClientRect();
      return { exp: r('cfgExportBtn'), imp: r('cfgImportBtn'), menu: !!document.getElementById('cfgMenuBtn'), h1: { x: h1.x, y: h1.y, w: h1.width, h: h1.height }, theme: { y: theme.y, h: theme.height } };
    })()`);
    const overlap = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    ok(head.exp && head.exp.vis && head.imp && head.imp.vis && head.menu, '첫 화면 머리에 ⬆ 내보내기·⬇ 가져오기 · 왼쪽 패널에 ⚙');
        ok(head.exp.y >= head.theme.y + head.theme.h - 1 && !overlap(head.exp, head.h1) && !overlap(head.imp, head.h1), '버튼이 주간/야간 아래에 있고 제목과 겹치지 않는다 → ' + png);

    // PC B — 빈 저장소에서 가져오기
    const B = await openWin('persist:pcB-' + Date.now());
    const b = await B.webContents.executeJavaScript(`(async () => {
      localStorage.clear();
      localStorage.setItem('uiTheme', 'dark');
      localStorage.setItem('bOnlyKey', 'keep-me');
      const before = loadImpProfiles().length;
      const n = await applyImportedSettings(${JSON.stringify(exported.text)}, { noConfirm: true, noReload: true });
      const prices = JSON.parse(localStorage.getItem('quoteDefaultPrices') || 'null');
      const cropRaw = JSON.parse(localStorage.getItem('impCropStyle') || 'null');   // 프리셋을 불러오기 전에(프리셋이 재단선 모양을 바꾼다)
      const list = loadImpProfiles();
      const idx = list.findIndex(p => p.n === '복제2부_위아래_219x312_블리드1mm');
      // 가져온 프리셋을 실제로 불러와 본다
      document.getElementById('impProfile') && populateImpProfiles();
      document.getElementById('impProfile').value = String(idx); onImpProfileChange();
      const o = currentImpOptions();
      const res = { n, theme: localStorage.getItem('uiTheme'), prices, papers: JSON.parse(localStorage.getItem('customPapers') || '[]'),
        crop: cropRaw, secret: localStorage.getItem('aiImageApiKey'),
        bOnly: localStorage.getItem('bOnlyKey'), profiles: list.length, idx, before,
        opt: { mode: o.mode, dupDir: o.dupDir, sheet: o.sheet && o.sheet.map(v => Math.round(v * 25.4 / 72)) }, bleed: _bleedEnabled,
        hasBackup: !!localStorage.getItem('__settingsBackup') };
      // 잘못된 파일
      let bad1 = null, bad2 = null;
      try { await applyImportedSettings('{"a":1}', { noConfirm: true, noReload: true }); } catch (e) { bad1 = e.message; }
      try { await applyImportedSettings('not json', { noConfirm: true, noReload: true }); } catch (e) { bad2 = e.message; }
      res.bad1 = bad1; res.bad2 = bad2;
      // 되돌리기 — 가져오기 전과 똑같이(가져오며 생긴 키는 지워진다)
      await restoreSettingsBackup({ noConfirm: true, noReload: true });
      res.after = { theme: localStorage.getItem('uiTheme'), prices: localStorage.getItem('quoteDefaultPrices'), bOnly: localStorage.getItem('bOnlyKey'),
        profiles: loadImpProfiles().length, backup: localStorage.getItem('__settingsBackup') };
      return res;
    })()`);
    ok(b.n === exported.n, `가져온 항목 ${b.n}개 = 내보낸 항목`);
    ok(b.theme === 'light' && b.prices && b.prices.color === 350 && b.papers.length === 1 && b.crop && b.crop.shape === 'double',
      '테마·견적 단가·사용자 용지·재단선 모양이 그대로 ' + JSON.stringify({ theme: b.theme, prices: b.prices, crop: b.crop && b.crop.shape }));
    ok(b.secret === null, 'API 키는 넘어오지 않았다(빼고 내보냄)');
    ok(b.bOnly === 'keep-me', '파일에 없는 이 PC 값은 그대로 둔다');
    ok(b.idx >= 0 && b.profiles === exported.profiles, `임포징 프리셋 ${b.profiles}개(내보낸 PC와 같음)`);
    ok(b.opt.mode === 'dup' && b.opt.dupDir === 'v' && String(b.opt.sheet) === '219,312' && b.bleed === true,
      '가져온 프리셋을 고르면 복제 2부·위아래·219×312·블리드 생성까지 그대로 ' + JSON.stringify(b.opt));
    ok(b.hasBackup, '가져오기 전에 지금 설정을 백업');
    ok(/설정 파일이 아닙니다/.test(b.bad1 || '') && /JSON/.test(b.bad2 || ''), '다른 JSON·깨진 파일은 거부 ' + JSON.stringify([b.bad1, b.bad2]));
    ok(b.after.theme === 'dark' && b.after.prices === null && b.after.bOnly === 'keep-me' && b.after.backup === null,
      '↺ 가져오기 전으로 → 원래 값(가져오며 생긴 값은 지움) · 백업 정리 ' + JSON.stringify(b.after));
  } catch (e) { fail++; console.error(e); }
  console.log(`\n결과: 통과 ${pass} · 실패 ${fail}`);
  app.exit(fail ? 1 : 0);
});
