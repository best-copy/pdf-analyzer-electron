// 🖨 인쇄 접수·변환 임시본을 저장 기본 폴더로 삼지 않는지 — main.js에서 함수를 그대로 추출해 검증
//   실행: node scripts/test/save-dir-print.test.js
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');

// main.js의 실제 구현을 추출 (테스트용 복사본을 만들지 않는다 — 드리프트 방지)
function extract(name) {
  const s = src.indexOf(`function ${name}(`);
  if (s < 0) throw new Error(`main.js에서 ${name}을 찾지 못했습니다`);
  // 함수 끝 = 열 위치가 0인 '}' 줄
  const e = src.indexOf('\n}', s);
  return src.slice(s, e + 2);
}
// '바탕화면' 대역 — 임시 폴더 밖에 만들어야 한다(임시 폴더는 저장 위치 후보에서 제외되므로)
const DESKTOP = fs.mkdtempSync(path.join(ROOT, 'desk_test_'));
const fakeApp = { getPath: (k) => (k === 'desktop' ? DESKTOP : path.join(os.tmpdir(), 'dl')) };
const NAMES = ['isTempPath', 'usableSaveDir', 'desktopDir', 'printSaveDir', 'printedSourceDir', 'pickSaveDir'];
const code = NAMES.map(extract).join('\n') + '\n; return { ' + NAMES.join(', ') + ' };';
const M = new Function('fs', 'os', 'path', 'app', code)(fs, os, path, fakeApp);

let fail = 0;
const ck = (n, c, x) => { if (!c) fail++; console.log(`  ${c ? '✔' : '✘'} ${n}${x === undefined ? '' : ' ' + JSON.stringify(x)}`); };

// 준비: 임시 폴더 안의 인쇄 접수본 / 진짜 문서 폴더
const tmpFile = path.join(os.tmpdir(), 'pdfedit_print_1.pdf');
const docDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x_'));   // tmp 안에 있지만 '문서 폴더' 형태
const realDir = ROOT;                                          // tmp가 아닌 실제 폴더

ck('임시 폴더를 임시로 판정', M.isTempPath(os.tmpdir()) === true);
ck('임시 폴더 하위도 임시로 판정', M.isTempPath(path.join(os.tmpdir(), 'a', 'b')) === true);
ck('일반 폴더는 임시가 아님', M.isTempPath(realDir) === false);

ck('임시 폴더는 저장 기본 위치로 쓸 수 없음', M.usableSaveDir(os.tmpdir()) === false);
ck('없는 폴더도 쓸 수 없음', M.usableSaveDir(path.join(realDir, '__없는폴더__')) === false);
ck('일반 폴더는 쓸 수 있음', M.usableSaveDir(realDir) === true);

// 인쇄 작업명 → 원본 폴더
ck('전체 경로 작업명에서 원본 폴더 추출', M.printedSourceDir(path.join(realDir, 'main.js')) === realDir,
   M.printedSourceDir(path.join(realDir, 'main.js')));
ck('제목만 있는 작업명은 폴더 없음', M.printedSourceDir('문서1 - Word') === null);
ck('임시 폴더 경로는 폴더로 안 씀', M.printedSourceDir(tmpFile) === null);
ck('UNC 경로도 폴더가 없으면 null', M.printedSourceDir('\\\\server\\share\\없는문서.pdf') === null);

// 저장 다이얼로그 기본 폴더 결정
ck('임시 폴더는 후보에서 제외(PDF)', M.pickSaveDir('pdf', os.tmpdir(), realDir, M.isTempPath) === realDir);
ck('임시 폴더는 후보에서 제외(작업 파일)', M.pickSaveDir('pdfw', os.tmpdir(), realDir, M.isTempPath) === realDir);
ck('둘 다 임시면 null → 바탕화면 폴백', M.pickSaveDir('pdf', os.tmpdir(), path.join(os.tmpdir(), 'z'), M.isTempPath) === null);
ck('작업 파일은 문서 폴더 우선', M.pickSaveDir('pdfw', realDir, path.join(ROOT, 'src'), M.isTempPath) === realDir);
ck('PDF는 직전 저장 폴더 우선', M.pickSaveDir('pdf', realDir, path.join(ROOT, 'src'), M.isTempPath) === path.join(ROOT, 'src'));

ck('바탕화면 폴백이 동작', M.desktopDir() === DESKTOP, M.desktopDir());

// 🖨 인쇄 접수본을 열었을 때의 저장 기본 폴더
ck('인쇄 원본 폴더를 알면 그 폴더', M.printSaveDir(realDir) === realDir);
ck('원본 폴더를 모르면 바탕화면', M.printSaveDir(null) === DESKTOP, M.printSaveDir(null));
ck('원본이 임시 폴더면 바탕화면', M.printSaveDir(os.tmpdir()) === DESKTOP, M.printSaveDir(os.tmpdir()));
ck('없는 폴더면 바탕화면', M.printSaveDir(path.join(realDir, '__없음__')) === DESKTOP);
ck('절대경로 작업명 → 그 폴더로 저장', M.printSaveDir(M.printedSourceDir(path.join(realDir, 'a.pdf'))) === realDir);

try { fs.rmSync(DESKTOP, { recursive: true, force: true }); fs.rmSync(docDir, { recursive: true, force: true }); } catch (e) {}
console.log(`\n결과: ${fail ? fail + '건 실패' : '전부 통과'}\n`);
process.exit(fail ? 1 : 0);
