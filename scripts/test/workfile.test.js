// 💼 작업 파일(.pdfw) 컨테이너 검증 — src/app-process.js의 <WORKFILE-CORE>를 **실제 코드 그대로** 실행.
// (테스트용 복사본을 만들면 드리프트가 생긴다 — CLAUDE.md 7.2)
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');

function loadCore() {
  const src = fs.readFileSync(path.join(ROOT, 'src/app-process.js'), 'utf8');
  const s = src.indexOf('// <WORKFILE-CORE>');
  const e = src.indexOf('// </WORKFILE-CORE>');
  if (s < 0 || e < 0) throw new Error('WORKFILE-CORE 마커를 찾을 수 없습니다');
  const body = src.slice(s, e);
  const impure = ['document.', 'window.', 'electronAPI', 'originalPdfBytes', 'pageResults', 'showSuccess']
    .filter(t => body.includes(t));
  return { impure, api: new Function(body + '\nreturn { packWorkFile, unpackWorkFile, describeWorkFile, WORK_MAGIC };')() };
}

let pass = 0, fail = 0;
const ck = (n, c, x) => { if (c) { pass++; console.log('  ✔', n); } else { fail++; console.log('  ✘', n, x !== undefined ? JSON.stringify(x) : ''); } };
const { impure, api } = loadCore();
const { packWorkFile, unpackWorkFile, describeWorkFile } = api;

const bytes = (n, fill) => Uint8Array.from({ length: n }, (_, i) => (fill != null ? fill : i % 256));

console.log('\n[1] 코어 순수성');
ck('DOM·앱 전역 참조 없음', impure.length === 0, impure);

console.log('\n[2] 담고 그대로 꺼내기');
const pdf = bytes(5000);
const edit1 = bytes(300, 7), edit2 = bytes(1, 9);
const manifest = {
  v: 1, savedAt: 1756000000000,
  doc: { name: '카탈로그', file: '카탈로그.pdf', pages: 12, size: pdf.length },
  state: { data: { nUp: 2, proc: { bw: true } }, docState: { order: [{ oi: 0, rot: 90 }], selected: [1, 3] },
           edits: [{ oi: 4, model: [{ t: 'text' }], rev: 2 }, { oi: 9, model: [], rev: 1 }], quote: [{ n: '인쇄', v: 1000 }] },
  entries: [{ k: 'pdf', name: '카탈로그.pdf' }, { k: 'edit', name: 'edit_4' }, { k: 'edit', name: 'edit_9' }],
};
const packed = packWorkFile(manifest, [pdf, edit1, edit2]);
ck('매직으로 시작', Buffer.from(packed.slice(0, 13)).toString() === 'PDFEDITWORK1\n');
const un = unpackWorkFile(packed);
ck('PDF 바이트가 1:1로 복원', Buffer.compare(Buffer.from(un.blobs[0]), Buffer.from(pdf)) === 0);
ck('내부편집 바이트도 1:1', Buffer.compare(Buffer.from(un.blobs[1]), Buffer.from(edit1)) === 0
   && Buffer.compare(Buffer.from(un.blobs[2]), Buffer.from(edit2)) === 0);
ck('상태(JSON)가 그대로', JSON.stringify(un.manifest.state) === JSON.stringify(manifest.state));
ck('길이가 자동 기록됨', un.manifest.entries.map(e => e.len).join(',') === `${pdf.length},300,1`);
ck('설명 문구', describeWorkFile(un.manifest).startsWith('카탈로그 · 12쪽 · 내부편집 2쪽'), describeWorkFile(un.manifest));

console.log('\n[3] 경계·이상 입력');
const empty = packWorkFile({ v: 1, doc: {}, state: {}, entries: [] }, []);
ck('첨부 0개도 왕복', unpackWorkFile(empty).blobs.length === 0);
const big = packWorkFile({ v: 1, entries: [{ k: 'pdf', name: 'x' }] }, [bytes(300000)]);
ck('300KB 왕복', unpackWorkFile(big).blobs[0].length === 300000);
ck('빈 첨부(0바이트)도 자리 유지', (() => {
  const p = packWorkFile({ v: 1, entries: [{ k: 'a' }, { k: 'b' }] }, [new Uint8Array(0), bytes(5)]);
  const u = unpackWorkFile(p);
  return u.blobs.length === 2 && u.blobs[0].length === 0 && u.blobs[1].length === 5;
})());
ck('한글 파일명 보존', unpackWorkFile(packed).manifest.doc.file === '카탈로그.pdf');
ck('entries/blobs 개수 불일치 → 거부', (() => {
  try { packWorkFile({ entries: [{ k: 'a' }, { k: 'b' }] }, [bytes(3)]); return false; }
  catch (e) { return /개수/.test(e.message); }
})());

console.log('\n[4] 남의 파일·손상 파일 거부');
ck('PDF를 넣으면 거부', (() => {
  try { unpackWorkFile(Buffer.from('%PDF-1.7\n...garbage...')); return false; }
  catch (e) { return /작업 파일/.test(e.message); }
})());
ck('너무 짧은 파일 거부', (() => { try { unpackWorkFile(new Uint8Array(4)); return false; } catch (e) { return true; } })());
ck('뒷부분이 잘린 파일 거부', (() => {
  try { unpackWorkFile(packed.slice(0, packed.length - 100)); return false; }
  catch (e) { return /잘렸|손상/.test(e.message); }
})());
ck('JSON이 깨진 파일 거부', (() => {
  const bad = packed.slice(0);
  bad[20] = 0x00;   // 매니페스트 한가운데를 훼손
  try { unpackWorkFile(bad); return false; } catch (e) { return /손상/.test(e.message); }
})());

console.log('\n[5] 오프셋이 있는 뷰(TypedArray subarray)도 정확히 읽기');
// 실제 앱에서는 readFile 결과를 잘라 쓰는 경우가 있어, byteOffset이 0이 아닌 뷰가 들어올 수 있다
const padded = new Uint8Array(packed.length + 64);
padded.set(packed, 64);
const view = padded.subarray(64);
ck('offset 뷰에서도 동일 결과', (() => {
  const u = unpackWorkFile(view);
  return Buffer.compare(Buffer.from(u.blobs[0]), Buffer.from(pdf)) === 0
      && JSON.stringify(u.manifest.state) === JSON.stringify(manifest.state);
})());

console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail ? 1 : 0);
