// 📦 압축 파일 풀기(archive.js) — 실제 모듈로 ZIP을 직접 만들어 확인 (7z는 7-Zip이 있을 때만)
//   실행: node scripts/test/archive.test.js   (npm run smoke가 함께 돌린다)
// 확인: CP949 이름(윈도 탐색기·반디집) · UTF-8 표시 비트 · 하위 폴더·같은 이름 · 압축 속 압축 · __MACOSX·숨김 무시 ·
//       암호 항목·지원 안 하는 형식은 건너뜀(이유) · 선언 크기를 속인 항목(압축 폭탄)은 풀지 않음 · 꺼낸 이름에 경로 없음 · 7z
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const cp = require('child_process');
const ROOT = path.join(__dirname, '..', '..');
const { extractArchives, find7z } = require(path.join(ROOT, 'archive.js'));

const out = [];
const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
const WANT = n => /\.(pdfw|pdf|hwpx?|docx?|xlsx?|pptx?|psd|indd|ai|png|jpe?g|gif|bmp|webp|tiff?|avif)$/i.test(n);

// 아주 작은 ZIP 작성기 — { name(Buffer|string), data, utf8, store, encrypted, fakeSize }
function crc32(b) { let c, t = crc32.t; if (!t) { t = crc32.t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } } c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function makeZip(entries) {
  const parts = [], cds = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8');
    const data = Buffer.from(e.data || '');
    const comp = e.store ? data : zlib.deflateRawSync(data);
    const flags = (e.utf8 ? 0x800 : 0) | (e.encrypted ? 1 : 0), method = e.store ? 0 : 8;
    const usize = e.fakeSize != null ? e.fakeSize : data.length, crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flags, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(usize, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(flags, 8); cd.writeUInt16LE(method, 10);
    cd.writeUInt32LE(crc, 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(usize, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(off, 42);
    cds.push(cd, name);
    off += 30 + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(cds);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}
const cp949 = s => (() => {   // 테스트용 CP949 인코딩 — 쓰는 글자만
  const map = { '한': [0xc7, 0xd1], '글': [0xb1, 0xdb], '견': [0xb0, 0xdf], '적': [0xc0, 0xfb], '서': [0xbc, 0xad], '자': [0xc0, 0xda], '료': [0xb7, 0xe1] };
  const bytes = [];
  for (const ch of s) { if (map[ch]) bytes.push(...map[ch]); else bytes.push(ch.charCodeAt(0)); }
  return Buffer.from(bytes);
})();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arctest_'));
const dirs = [];
try {
  const pdf = '%PDF-1.4\n%test\n';
  const inner = makeZip([{ name: '안쪽.pdf', data: pdf + 'inner', utf8: true }]);
  const zipA = path.join(tmp, '자료.zip');
  fs.writeFileSync(zipA, makeZip([
    { name: cp949('자료/견적서.pdf'), data: pdf + 'cp949' },            // CP949 이름(표시 비트 없음)
    { name: '자료/sub/견적서.pdf', data: pdf + 'dup', utf8: true },     // 같은 이름 다른 폴더
    { name: '표지 2.hwp', data: 'HWP', utf8: true, store: true },
    { name: '표지 10.hwp', data: 'HWP10', utf8: true },
    { name: 'readme.txt', data: 'x', utf8: true },                     // 지원 안 함
    { name: '__MACOSX/자료/._견적서.pdf', data: 'mac', utf8: true },    // 무시
    { name: '.DS_Store', data: 'ds', utf8: true },                     // 무시
    { name: '비밀.pdf', data: pdf, utf8: true, encrypted: true },       // 암호
    { name: '폭탄.pdf', data: Buffer.alloc(2 * 1024 * 1024), utf8: true, fakeSize: 100 },   // 선언 크기 속임
    { name: '../../밖으로.pdf', data: pdf + 'slip', utf8: true },        // 경로 조작
    { name: '묶음.zip', data: inner, utf8: true, store: true },        // 압축 속 압축
  ]));
  const r = extractArchives([zipA], WANT);
  dirs.push(...r.dirs);
  const names = r.items.map(i => i.name), rels = r.items.map(i => i.rel);
  ck('CP949 이름 → "자료/견적서.pdf"', rels.includes('자료/견적서.pdf'), rels);
  ck('같은 이름 다른 폴더 → 둘 다(이름 겹치면 "(2)")', names.filter(n => /^견적서( \(2\))?\.pdf$/.test(n)).length === 2, names);
  ck('압축 속 압축 → "묶음.zip/안쪽.pdf"', rels.includes('묶음.zip/안쪽.pdf'), rels);
  ck('정렬: 숫자 자연 순(표지 2 → 표지 10)', rels.indexOf('표지 2.hwp') < rels.indexOf('표지 10.hwp'), rels);
  ck('__MACOSX·숨김 파일 무시', !rels.some(x => /MACOSX|DS_Store/.test(x)) && !r.skipped.some(s => /MACOSX|DS_Store/.test(s.name)), r.skipped);
  ck('지원 안 하는 형식은 건너뜀(이유)', r.skipped.some(s => s.name === 'readme.txt' && /지원하지 않는/.test(s.reason)), r.skipped);
  ck('암호 항목은 건너뜀(이유)', r.skipped.some(s => s.name === '비밀.pdf' && /암호/.test(s.reason)), r.skipped);
  ck('선언 크기를 속인 항목은 풀지 않음', !names.includes('폭탄.pdf') && r.skipped.some(s => s.name === '폭탄.pdf'), r.skipped);
  const slip = r.items.find(i => /밖으로/.test(i.name));
  ck('경로 조작(../) → 꺼낸 폴더 안, 파일 이름만', slip && path.dirname(slip.path) === r.dirs[0] && slip.name === '밖으로.pdf', slip);
  ck('모든 파일이 꺼낸 폴더(pdfedit_arc_) 안', r.items.every(i => path.dirname(i.path) === r.dirs[0]) && /pdfedit_arc_/.test(r.dirs[0]), r.dirs);
  const c = r.items.find(i => i.rel === '자료/견적서.pdf');
  ck('내용 그대로(Deflate)', c && fs.readFileSync(c.path, 'utf8') === pdf + 'cp949');
  ck('압축 속 임시 압축 파일은 지움', !fs.readdirSync(r.dirs[0]).some(n => n.startsWith('_inner_')), fs.readdirSync(r.dirs[0]));
  ck('항목마다 압축 이름', r.items.every(i => i.archive === '자료.zip'));

  // 망가진 ZIP
  const bad = path.join(tmp, '망가짐.zip'); fs.writeFileSync(bad, Buffer.from('PK\x03\x04garbage'));
  const rb = extractArchives([bad], WANT); dirs.push(...rb.dirs);
  ck('망가진 ZIP → 안내(멈추지 않음)', rb.items.length === 0 && rb.skipped.length === 1, rb.skipped);

  // 7z — 7-Zip이 있을 때만
  const seven = find7z();
  if (seven) {
    const src = path.join(tmp, 's7'); fs.mkdirSync(path.join(src, '폴더'), { recursive: true });
    fs.writeFileSync(path.join(src, '폴더', '한글 문서.pdf'), pdf + '7z');
    fs.writeFileSync(path.join(src, '메모.txt'), 'x');
    const a7 = path.join(tmp, '묶음.7z');
    cp.spawnSync(seven, ['a', '-bd', a7, '.'], { cwd: src, windowsHide: true });
    const r7 = extractArchives([a7], WANT); dirs.push(...r7.dirs);
    const it = r7.items.find(i => i.name === '한글 문서.pdf');
    ck('7z → "폴더/한글 문서.pdf" · 내용 그대로', it && it.rel === '폴더/한글 문서.pdf' && fs.readFileSync(it.path, 'utf8') === pdf + '7z', r7);
    ck('7z: 지원 안 하는 형식은 건너뜀', r7.skipped.some(s => s.name === '메모.txt'), r7.skipped);
  } else ck('7-Zip 없음 — 7z 검사 건너뜀', true);
} catch (e) { ck('실행 오류', false, e && e.stack); }
finally {
  for (const d of [tmp, ...dirs]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
}
let fail = 0;
out.forEach(([m, n, x]) => { if (m !== '✔') fail++; console.log(`  ${m} ${n}`, m === '✔' ? '' : x); });
console.log(`\n  ${out.length - fail} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
