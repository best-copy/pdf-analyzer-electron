// 📚 열 순서 정하기 — 통합 ▲▼ 이동/선택 로직 검증.
// src/app-core.js의 실제 함수를 그대로 떼어, 최소 DOM 스텁 위에서 돌린다.
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

function loadFns() {
  const src = fs.readFileSync(path.join(ROOT, 'src/app-core.js'), 'utf8').replace(/\r\n/g, '\n');
  const grab = (name) => {
    const s = src.indexOf('    function ' + name + '(');
    if (s < 0) throw new Error('함수 없음: ' + name);
    const e = src.indexOf('\n    }', s) + 6;
    return src.slice(s, e).replace(/^\s{4}/gm, '');
  };
  const body = ['renderOrderRows', 'syncOrderToolbar', 'selectOrderRow', 'moveOrderSel', 'moveOrderItem', 'sortOrderItems']
    .map(grab).join('\n');
  // DOM 스텁: innerHTML 저장, 행 목록은 _orderItems에서 재구성
  const stub = `
    let _orderItems = [], _orderSel = -1;
    const _el = {}; const _mk = id => (_el[id] = _el[id] || { id, textContent:'', innerHTML:'', disabled:false, classList:{ toggle(){}, add(){}, remove(){} } });
    const document = {
      getElementById: _mk,
      querySelectorAll: () => _orderItems.map((it,k)=>({ classList:{ toggle(c,on){ if(c==='sel') it.__sel=!!on; }, add(){}, remove(){} } })),
      querySelector: () => ({ scrollIntoView(){} }),
    };
  `;
  return new Function(stub + body +
    '\nreturn { set: v => { _orderItems = v; _orderSel = -1; }, items: () => _orderItems, sel: () => _orderSel,' +
    ' selectOrderRow, moveOrderSel, moveOrderItem, sortOrderItems, renderOrderRows, btn: id => _el[id] };')();
}

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };
const A = loadFns();
const names = () => A.items().map(i => i.name).join('');
const reset = (s = 'abcde') => { A.set([...s].map(c => ({ name: c }))); A.renderOrderRows(); };

console.log('\n[1] 선택');
reset();
A.selectOrderRow(2); ck('클릭하면 선택', A.sel() === 2);
A.selectOrderRow(2); ck('같은 행 다시 누르면 해제', A.sel() === -1);
A.selectOrderRow(0);

console.log('\n[2] 한 칸 이동 — 선택이 파일을 따라간다');
reset(); A.selectOrderRow(3);            // d
A.moveOrderSel(-1); ck('▲ 한 칸', names() === 'abdce' && A.sel() === 2, names());
A.moveOrderSel(-1); A.moveOrderSel(-1);  // 연속 클릭
ck('연속 클릭으로 여러 칸', names() === 'dabce' && A.sel() === 0, names());
A.moveOrderSel(-1); ck('맨 위에서 더 못 감', names() === 'dabce' && A.sel() === 0, names());
A.moveOrderSel(1); A.moveOrderSel(1); A.moveOrderSel(1); A.moveOrderSel(1);
ck('▼ 연속으로 맨 아래까지', names() === 'abced' && A.sel() === 4, names());
A.moveOrderSel(1); ck('맨 아래에서 더 못 감', names() === 'abced' && A.sel() === 4, names());

console.log('\n[3] 맨 위/맨 아래');
reset(); A.selectOrderRow(4);
A.moveOrderSel(-999); ck('⤒ 맨 위로', names() === 'eabcd' && A.sel() === 0, names());
A.moveOrderSel(999);  ck('⤓ 맨 아래로', names() === 'abcde' && A.sel() === 4, names());

console.log('\n[4] 선택 없으면 이동 없음 · 버튼 비활성');
reset();
A.moveOrderSel(1); ck('선택 없으면 그대로', names() === 'abcde' && A.sel() === -1);
ck('▲▼ 비활성', A.btn('ordUp').disabled && A.btn('ordDown').disabled);
A.selectOrderRow(0); A.renderOrderRows();
ck('첫 행 선택 시 ▲만 비활성', A.btn('ordUp').disabled && !A.btn('ordDown').disabled);
A.selectOrderRow(0); A.selectOrderRow(4); A.renderOrderRows();
ck('끝 행 선택 시 ▼만 비활성', !A.btn('ordUp').disabled && A.btn('ordDown').disabled);

console.log('\n[5] 이름순 정렬 후에도 선택 유지');
A.set(['10.pdf', '2.pdf', '1.pdf'].map(n => ({ name: n }))); A.renderOrderRows();
A.selectOrderRow(0);                     // 10.pdf
A.sortOrderItems();
ck('자연 정렬', A.items().map(i => i.name).join(',') === '1.pdf,2.pdf,10.pdf');
ck('선택이 같은 파일에 남음', A.items()[A.sel()].name === '10.pdf', A.sel());

console.log('\n[6] 드롭 인덱스 계산(자기 자신 제거 보정)');
// drop 핸들러 규칙: at = 커서가 들어갈 자리(0..n), at > from 이면 at--
const dropTo = (arr, from, at) => { if (at > from) at--; const c = arr.slice(); const it = c.splice(from,1)[0]; c.splice(at,0,it); return c.join(''); };
ck('a를 c 뒤(자리3)로', dropTo([...'abcde'], 0, 3) === 'bcade', dropTo([...'abcde'],0,3));
ck('e를 맨 앞(자리0)으로', dropTo([...'abcde'], 4, 0) === 'eabcd');
ck('제자리(바로 아래 경계)면 변화 없음', dropTo([...'abcde'], 1, 2) === 'abcde');
ck('맨 끝(자리5)으로', dropTo([...'abcde'], 1, 5) === 'acdeb');

console.log(`\n결과: ${pass} 통과 / ${fail} 실패\n`);
process.exit(fail ? 1 : 0);
