// 📐 페이지 방향 판정 검증 — src/app-process.js의 실제 함수를 그대로 떼어 실행한다.
// (표시 방향 = 원본 /Rotate가 반영된 pdf.js 뷰포트 크기 + 앱에서 건 회전)
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

function loadFns() {
  const src = fs.readFileSync(path.join(ROOT, 'src/app-process.js'), 'utf8');
  const grab = (name) => {
    const s = src.indexOf('function ' + name + '(');
    if (s < 0) throw new Error('함수 없음: ' + name);
    const e = src.indexOf('\n    }', s) + 6;
    return src.slice(s, e).replace(/^\s{4}/gm, '');
  };
  const body = grab('pageDisplayOrient') + '\n' + grab('docMajorOrient');
  return new Function(body + '\nreturn { pageDisplayOrient, docMajorOrient };')();
}

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };
const { pageDisplayOrient, docMajorOrient } = loadFns();

const P = (rot) => ({ pageWpt: 595, pageHpt: 842, rotation: rot || 0 });   // 표시상 세로
const L = (rot) => ({ pageWpt: 842, pageHpt: 595, rotation: rot || 0 });   // 표시상 가로

console.log('\n[1] 표시 방향 판정');
ck('세로 페이지', pageDisplayOrient(P()) === 'portrait');
ck('가로 페이지', pageDisplayOrient(L()) === 'landscape');
ck('세로 + 90° 회전 → 가로로 보임', pageDisplayOrient(P(90)) === 'landscape');
ck('세로 + 270° 회전 → 가로로 보임', pageDisplayOrient(P(270)) === 'landscape');
ck('세로 + 180° 회전 → 그대로 세로', pageDisplayOrient(P(180)) === 'portrait');
ck('가로 + 270°(왼쪽 90°) → 세로로 보임', pageDisplayOrient(L(270)) === 'portrait');
ck('정사각형은 건드리지 않음', pageDisplayOrient({ pageWpt: 600, pageHpt: 600 }) === 'square');
ck('오차 2% 안쪽은 정사각 취급', pageDisplayOrient({ pageWpt: 600, pageHpt: 595 }) === 'square');
ck('빈 페이지는 pageSize로 판정', pageDisplayOrient({ isBlank: true, pageSize: [842, 595] }) === 'landscape');
ck('썸네일 픽셀 폴백', pageDisplayOrient({ thumbW: 200, thumbH: 140 }) === 'landscape');
ck('크기 정보가 없으면 null', pageDisplayOrient({}) === null);
ck('회전 음수·초과값 정규화', pageDisplayOrient(Object.assign(P(), { rotation: -90 })) === 'landscape'
   && pageDisplayOrient(Object.assign(P(), { rotation: 450 })) === 'landscape');

console.log('\n[2] 문서 기준 방향(다수결)');
ck('세로 6 + 가로 2 → 세로 기준', docMajorOrient([P(), P(), P(), L(), P(), P(), L(), P()]) === 'portrait');
ck('가로가 많으면 가로 기준', docMajorOrient([L(), L(), L(), P()]) === 'landscape');
ck('동수면 세로 기준', docMajorOrient([P(), L()]) === 'portrait');
ck('판정 불가면 null', docMajorOrient([{}, { pageWpt: 600, pageHpt: 600 }]) === null);
ck('빈 목록도 안전', docMajorOrient([]) === null && docMajorOrient(null) === null);

console.log('\n[3] 실무 시나리오 — 아크로뱃에서 이미 돌려 둔 파일은 건드리지 않는다');
// 가로 원고를 아크로뱃에서 왼쪽 90° 회전해 저장 → 표시상 세로 → 맞출 것이 없어야 한다
const acrobatFixed = [P(), P(), { pageWpt: 595, pageHpt: 842, rotation: 0 }, P()];
ck('전부 세로로 보이면 기준도 세로', docMajorOrient(acrobatFixed) === 'portrait');
ck('그 문서엔 방향이 다른 페이지가 없음',
   acrobatFixed.every(r => pageDisplayOrient(r) === 'portrait'));

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
