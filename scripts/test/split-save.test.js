// ✂ 분리 저장 구간 계산 — 앱 파일(src/app-process.js)에서 함수를 그대로 떼어 검증
//   실행: node scripts/test/split-save.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'app-process.js'), 'utf8');
function grab(name) {
  const i = SRC.indexOf(`    function ${name}(`);
  if (i < 0) throw new Error(`함수 ${name}을 app-process.js에서 찾지 못했습니다`);
  const j = SRC.indexOf('\n    }', i);
  return SRC.slice(i, j + 6);
}
const ctx = vm.createContext({});
vm.runInContext([grab('splitRangesEveryN'), grab('parseSplitRanges'), grab('splitPartFileName')].join('\n'), ctx);
const everyN = (t, n) => vm.runInContext(`splitRangesEveryN(${t}, ${n})`, ctx);
const parse = (s, t) => vm.runInContext(`parseSplitRanges(${JSON.stringify(s)}, ${t})`, ctx);
const name = (stem, f, t, pad) => vm.runInContext(`splitPartFileName(${JSON.stringify(stem)}, ${f}, ${t}, ${pad})`, ctx);

let fail = 0;
const eq = (n, got, want) => {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) { fail++; console.log(`  ✘ ${n}\n      받음: ${a}\n      기대: ${b}`); }
  else console.log(`  ✔ ${n}`);
};
const throws = (n, fn, re) => {
  try { fn(); fail++; console.log(`  ✘ ${n} — 오류가 나야 하는데 통과함`); }
  catch (e) {
    if (re && !re.test(e.message)) { fail++; console.log(`  ✘ ${n} — 메시지: ${e.message}`); }
    else console.log(`  ✔ ${n}`);
  }
};
const R = (...pairs) => pairs.map(([from, to]) => ({ from, to }));

console.log('✂ 분리 저장 구간 계산');
// 쪽 수 단위
eq('10쪽 단위 · 30쪽', everyN(30, 10), R([1, 10], [11, 20], [21, 30]));
eq('10쪽 단위 · 25쪽(마지막은 남는 만큼)', everyN(25, 10), R([1, 10], [11, 20], [21, 25]));
eq('20쪽 단위 · 20쪽(한 파일)', everyN(20, 20), R([1, 20]));
eq('묶음이 문서보다 크면 한 파일', everyN(7, 100), R([1, 7]));
eq('1쪽씩 = 쪽마다 한 파일', everyN(3, 1), R([1, 1], [2, 2], [3, 3]));
throws('0쪽씩은 오류', () => everyN(10, 0), /1 이상/);
throws('빈 문서는 오류', () => everyN(0, 10), /나눌 쪽/);

// 쪽 범위
eq('21-39만', parse('21-39', 100), R([21, 39]));
eq('여러 구간(쉼표)', parse('1-20, 41-60', 100), R([1, 20], [41, 60]));
eq('한 쪽만', parse('7', 100), R([7, 7]));
eq('띄어쓰기·다양한 하이픈', parse(' 1 - 5 ; 8–9, 11~12 ', 20), R([1, 5], [8, 9], [11, 12]));
eq('겹치는 구간도 적은 그대로', parse('1-10, 5-8', 10), R([1, 10], [5, 8]));
throws('마지막 쪽을 넘기면 오류', () => parse('1-50', 30), /30쪽까지/);
throws('앞 번호가 더 크면 오류', () => parse('30-10', 100), /앞 번호/);
throws('0쪽은 오류', () => parse('0-5', 100), /1부터/);
throws('글자는 오류', () => parse('가-나', 100), /읽을 수 없습니다/);
throws('빈 값은 오류', () => parse('   ', 100), /적어 주세요/);

// 파일 이름 — 자릿수 채우기(탐색기 정렬)
eq('세 자리 채움', name('원고', 1, 10, 3), '원고_001-010.pdf');
eq('전체가 두 자리면 두 자리', name('원고', 1, 10, 2), '원고_01-10.pdf');
eq('한 자리 문서도 최소 두 자리', name('원고', 3, 3, 1), '원고_03-03.pdf');
eq('네 자리 문서', name('보고서_흑백', 991, 1000, 4), '보고서_흑백_0991-1000.pdf');

console.log(fail ? `FAIL ${fail}` : 'PASS');
process.exit(fail ? 1 : 0);
