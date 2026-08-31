// 🗂 임포징 프리셋 — 불러와 수정 후 '💾 저장' = 그 프리셋 덮어쓰기
//   실행: npx electron scripts/test/imp-profile.e2e.js
// ※ 이 하네스의 저장소는 실제 앱(userData: pdf-analyzer)과 분리돼 있다(Electron 기본 경로).
//   프리셋 목록은 비우면 코드의 시드 목록으로 다시 채워지므로, 개수 대신 '증감'으로 검증한다.
const path = require('path');
const { app, BrowserWindow } = require('electron');
const ROOT = path.join(__dirname, '..', '..');

app.commandLine.appendSwitch('disable-gpu');
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1440, height: 900,
    webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));

  let res;
  try {
    res = await win.webContents.executeJavaScript(`(async () => {
    const out = [];
    const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
    const g = id => document.getElementById(id);
    // 확인창이 뜨는지 세고, 항상 '취소'로 답한다(자동화에서 실제로 뜨면 안 되는 자리 검증)
    let confirmed = 0;
    const origConfirm = window.confirm;
    window.confirm = () => { confirmed++; return false; };

    const NAME_A = '__테스트_명함4up', NAME_B = '__테스트_엽서2up';
    const cleanup = () => {
      const keep = loadImpProfiles().filter(p => !String(p.n).startsWith('__테스트'));
      saveImpProfiles(keep); populateImpProfiles();
    };
    cleanup();
    const n0 = loadImpProfiles().length;

    // ① 새 프리셋 두 개 추가
    setImpMode('nup');
    g('impAcross').value = 2; g('impDown').value = 2; g('impMargin').value = 10; impSettingsChanged();
    g('impProfName').value = NAME_A; impProfileSave();
    g('impMargin').value = 3; impSettingsChanged();
    g('impProfName').value = NAME_B; impProfileSave();
    let list = loadImpProfiles();
    const idxA = list.findIndex(p => p.n === NAME_A);
    ck('새 프리셋 2개 추가됨', list.length === n0 + 2 && idxA >= 0 && list.some(p => p.n === NAME_B),
       { before: n0, after: list.length });
    ck('신규 저장에는 확인창 없음', confirmed === 0, confirmed);

    // ② 불러오면 이름칸이 자동으로 채워진다
    g('impProfile').value = String(idxA);
    onImpProfileChange();
    await new Promise(r => setTimeout(r, 200));
    ck('불러오면 이름칸 = 그 프리셋 이름', g('impProfName').value === NAME_A, g('impProfName').value);
    ck('불러온 여백이 UI에 반영', +g('impMargin').value === 10, g('impMargin').value);

    // ③ 수정 후 저장 → 확인창 없이 그 프리셋만 덮어쓴다(개수 불변)
    g('impMargin').value = 15; impSettingsChanged();
    impProfileSave();
    list = loadImpProfiles();
    ck('덮어쓰기 — 개수 그대로', list.length === n0 + 2, { before: n0 + 2, after: list.length });
    ck('그 프리셋의 여백이 15로 갱신', list[idxA] && list[idxA].n === NAME_A && list[idxA].mg === 15, list[idxA]);
    ck('덮어쓸 때 확인창 없음', confirmed === 0, confirmed);
    ck('선택 상태 유지', g('impProfile').value === String(idxA), g('impProfile').value);

    // ④ 이름을 바꾸면 새 프리셋으로 저장된다
    g('impProfName').value = NAME_A + '-복사';
    impProfileSave();
    list = loadImpProfiles();
    ck('이름을 바꾸면 신규 추가', list.length === n0 + 3 && list.some(p => p.n === NAME_A + '-복사'),
       { after: list.length });

    // ⑤ 다른 프리셋 이름을 적으면 실수 방지 확인창(취소하면 그대로)
    g('impProfile').value = String(idxA); onImpProfileChange();
    await new Promise(r => setTimeout(r, 150));
    const idxB = loadImpProfiles().findIndex(p => p.n === NAME_B);
    g('impProfName').value = NAME_B;             // 지금 선택과 다른 프리셋 이름
    g('impMargin').value = 99; impSettingsChanged();
    impProfileSave();
    list = loadImpProfiles();
    ck('다른 프리셋 덮어쓰기는 확인창', confirmed === 1, confirmed);
    ck('취소하면 변경 없음', list[idxB] && list[idxB].mg !== 99, list[idxB]);

    cleanup();
    window.confirm = origConfirm;
    ck('테스트 프리셋 정리됨', !loadImpProfiles().some(p => String(p.n).startsWith('__테스트')));
    return out;
  })()`);
  } catch (e) { console.error('  ✘ 스크립트 실행 오류:', e && e.message); app.exit(1); return; }

  let fail = 0;
  res.forEach(([m, n, x]) => { if (m === '✘') fail++; console.log(`  ${m} ${n} ${x}`); });
  console.log(`\n결과: ${res.length - fail} 통과 / ${fail} 실패\n`);
  app.exit(fail ? 1 : 0);
});
