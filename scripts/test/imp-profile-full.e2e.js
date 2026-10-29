// 📖 임포징 프리셋 — 방금 쓴 설정을 💾로 저장하고 목록에서 골라 그대로 되살리기
//   실행: npx electron scripts/test/imp-profile-full.e2e.js   (창 없음)
// 사용자 요청(2026-10-27): "방금 임포징한 설정을 프로파일로 저장하고 불러와 적용". 예전 프리셋에는
// ◲ 블리드 생성(임포징과 별개 기능)·재단선 모양이 빠져 있었고, 저장 버튼이 '▸ 관리' 안에 숨어 있었다.
// 확인: ① 💾 버튼 → 이름 제안(복제2부_위아래_219x312) → 저장 ② 설정을 흐트러뜨린 뒤 목록에서 고르면
//      방식·배치·용지·여백·거터·재단선(모양 포함)·양면·배치크기·블리드 생성(폭·재단선)이 그대로
//      ③ 불러온 옵션으로 조립하면 위아래 · 세로 대지 ④ 블리드 생성 항목이 없는 옛 프리셋은 블리드 상태를 건드리지 않는다
//      ⑤ 블리드 끔으로 저장한 프리셋은 블리드를 끈다
const path = require('path');
const os = require('os');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.setPath('userData', path.join(os.tmpdir(), 'pdfedit-e2e-impprofull'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✔ ' + m); } else { fail++; console.log('  ✘ ' + m); } };

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1200, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  try {
    const r = await win.webContents.executeJavaScript(`(async () => {
      const g = id => document.getElementById(id);
      const MM = 72 / 25.4;
      window.confirm = () => true;
      let asked = null;
      window.promptText = async (msg, def) => { asked = def; return '도록 복제2부 위아래'; };
      // ── 방금 쓴 설정 ──
      setImpMode('dup'); setCutSides(2); g('impDupDir').value = 'auto';
      populatePaperSelect('__custom__'); g('bkPaper').value = '__custom__'; g('impCustomW').value = 219; g('impCustomH').value = 312; onImpPaperChange();
      g('impMargin').value = 0; g('bkGutter').value = 2; g('impBleed').value = 0;
      g('impCrop').checked = true; g('impCropShape').value = 'double'; g('impCropGap').value = 3; g('impCropLen').value = 5; g('impCropTh').value = 0.25; g('impCropCenter').checked = true;
      setImpScale('orig');
      g('bleedGenMm').value = '1'; g('bleedCrop').checked = false; setBleedEnabled(true);
      g('impDupDir').value = 'v'; impSettingsChanged();
      const quickBtn = !!g('impProfQuickSave') && g('impProfMgmt').style.display === 'none';
      const before = loadImpProfiles().length;
      await impProfileQuickSave();
      const list = loadImpProfiles();
      const saved = list.find(p => p.n === '도록 복제2부 위아래');
      // 이름 제안은 이름칸이 비어 있을 때 — 한 번 더(이름칸 비우고 제안만 확인)
      g('impProfName').value = '';
      let suggest = null; window.promptText = async (m, d) => { suggest = d; return null; };
      await impProfileQuickSave();
      // ── 흐트러뜨리기 ──
      setImpMode('nup'); setCutSides(1); g('bkPaper').value = 'auto'; onImpPaperChange();
      g('impMargin').value = 7; g('bkGutter').value = 9; g('impCrop').checked = false;
      g('impCropShape').value = 'corner'; g('impCropGap').value = 1; g('impCropLen').value = 3; g('impCropTh').value = 0.4; g('impCropCenter').checked = false;
      setImpScale('fit'); g('impDupDir').value = 'auto';
      setBleedEnabled(false); g('bleedGenMm').value = '3';
      impSettingsChanged();
      // ── 목록에서 고르기 ──
      const idx = loadImpProfiles().findIndex(p => p.n === '도록 복제2부 위아래');
      g('impProfile').value = String(idx); onImpProfileChange();
      const o = currentImpOptions();
      const ui = { mode: _impMode, sides: _cutSides, dupDir: g('impDupDir').value, paper: g('bkPaper').value, W: g('impCustomW').value, H: g('impCustomH').value,
        margin: g('impMargin').value, gutter: g('bkGutter').value, crop: g('impCrop').checked, shape: g('impCropShape').value, gap: g('impCropGap').value,
        len: g('impCropLen').value, th: g('impCropTh').value, center: g('impCropCenter').checked, scale: _impScale,
        bleedOn: _bleedEnabled, bleedMm: g('bleedGenMm').value, bleedCrop: g('bleedCrop').checked, impOn: _impEnabled };
      // 조립해 보기
      const { PDFDocument } = PDFLib;
      const d = await PDFDocument.create(); for (let i = 0; i < 2; i++) d.addPage([210 * MM, 148 * MM]);
      const res = await buildDup2upBytes(await d.save(), Object.assign({}, o, { slug: null }));
      // ── 옛 프리셋(블리드 항목 없음)은 블리드를 건드리지 않는다 ──
      const old = Object.assign({}, saved); delete old.bg; delete old.bgc; delete old.cs; old.n = '옛 프리셋';
      const l2 = loadImpProfiles(); l2.push(old); saveImpProfiles(l2); populateImpProfiles();
      g('impProfile').value = String(l2.length - 1); onImpProfileChange();
      const oldKeepsBleed = _bleedEnabled === true;
      // ── 블리드 끔으로 저장한 프리셋은 끈다 ──
      setBleedEnabled(false);
      window.promptText = async () => '블리드 없음'; g('impProfName').value = '';
      await impProfileQuickSave();
      setBleedEnabled(true);
      const i3 = loadImpProfiles().findIndex(p => p.n === '블리드 없음');
      g('impProfile').value = String(i3); onImpProfileChange();
      return { quickBtn, before, after: list.length, saved, asked, suggest, ui,
        opt: { mode: o.mode, dupDir: o.dupDir, sheet: o.sheet.map(v => Math.round(v / MM)), gutter: o.gutter, crop: o.crop, cropStyle: o.cropStyle, scale: o.place.scale },
        dir: res.dir, sheets: res.sheets, oldKeepsBleed, offTurnsOff: _bleedEnabled === false, bgOff: loadImpProfiles()[i3].bg };
    })()`);
    console.log('📖 임포징 프리셋 — 💾 저장 → 목록에서 불러오기');
    ok(r.quickBtn, "프리셋 줄에 💾 버튼('▸ 관리'를 펼치지 않아도 보임)");
    ok(r.after === r.before + 1 && r.saved, '💾 → 이름 입력 → 프리셋 1개 저장');
    ok(r.suggest === '복제2부_위아래_219x312', '이름 제안 = 방식_배치_용지 (' + r.suggest + ')');
    const s = r.saved || {};
    ok(s.m === 'dup' && s.dd === 'v' && s.sd === 2 && s.sw === 219 && s.sh === 312 && (s.mg || 0) === 0 && s.hg === 2 && s.cr === 1 && s.sc === 'orig',
      '저장 내용: 복제 2부·위아래·양면·219×312·여백 0·거터 2·재단선·100% ' + JSON.stringify({ m: s.m, dd: s.dd, sd: s.sd, sw: s.sw, sh: s.sh, hg: s.hg, cr: s.cr, sc: s.sc }));
    ok(s.bg === 1 && !s.bgc && s.cs && s.cs.shape === 'double' && +s.cs.gap === 3 && +s.cs.len === 5 && +s.cs.th === 0.25 && s.cs.center === true,
      '저장 내용: ◲ 블리드 1mm · 재단선 모양(이중 코너·간격 3·길이 5·굵기 0.25·가운데 표시) ' + JSON.stringify({ bg: s.bg, cs: s.cs }));
    const u = r.ui;
    ok(u.mode === 'dup' && u.sides === 2 && u.dupDir === 'v' && u.paper === '__custom__' && +u.W === 219 && +u.H === 312 && +u.margin === 0 && +u.gutter === 2,
      '불러오기 → 방식·양면·배치·용지·여백·거터 복원 ' + JSON.stringify({ mode: u.mode, sides: u.sides, dupDir: u.dupDir, W: u.W, H: u.H, margin: u.margin, gutter: u.gutter }));
    ok(u.crop && u.shape === 'double' && +u.gap === 3 && +u.len === 5 && +u.th === 0.25 && u.center && u.scale === 'orig',
      '불러오기 → 재단선(모양까지)·배치 크기 복원 ' + JSON.stringify({ crop: u.crop, shape: u.shape, gap: u.gap, len: u.len, th: u.th, center: u.center, scale: u.scale }));
    ok(u.bleedOn && +u.bleedMm === 1 && !u.bleedCrop && u.impOn, '불러오기 → ◲ 블리드 생성 켜짐 1mm · 임포징 포함 켜짐');
    ok(r.opt.mode === 'dup' && r.opt.dupDir === 'v' && r.opt.sheet.join() === '219,312' && r.opt.gutter === 2 && r.opt.crop && r.opt.cropStyle.shape === 'double' && r.opt.scale === 'orig',
      '조립에 쓰는 옵션도 그대로 ' + JSON.stringify(r.opt));
    ok(r.dir === 'v' && r.sheets === 1, '불러온 옵션으로 조립 → 위아래(세로 대지)');
    ok(r.oldKeepsBleed, '블리드 항목이 없는 옛 프리셋은 블리드 상태를 그대로 둔다');
    ok(r.bgOff === 0 && r.offTurnsOff, '블리드 끔으로 저장한 프리셋을 고르면 블리드가 꺼진다');
  } catch (e) { fail++; console.error(e); }
  console.log(`\n결과: 통과 ${pass} · 실패 ${fail}`);
  app.exit(fail ? 1 : 0);
});
