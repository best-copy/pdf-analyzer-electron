// 📦 압축 파일 열기 — 앱 흐름 (main.js의 archive:extract 구간을 그대로 싣는다 · 창을 띄우지 않는다 show:false)
//   실행: npx electron scripts/test/archive-open.e2e.js
// 확인: 문서 2개 + 지원 안 하는 파일이 든 ZIP(CP949 폴더 이름) → 순서 지정 창에 2개(압축 안 폴더 표시)·안내(꺼낸 수·건너뜀) →
//       📚 통합창 → 두 문서가 챕터로 이어진 한 문서 · 문서 하나뿐인 ZIP → 순서 창 없이 바로 열림 ·
//       꺼낸 임시 경로는 최근 파일에 남지 않음 · 문서가 없는 ZIP → 오류 안내
const path = require('path');
const os = require('os');
const fs = require('fs');
const zlib = require('zlib');
const { app, BrowserWindow, ipcMain } = require('electron');
const ROOT = path.join(__dirname, '..', '..');
process.on('uncaughtException', e => { console.log('✘ 검사 스크립트 오류', e && e.stack || e); app.exit(1); });

// main.js의 archive:extract 구간을 그대로
{
  const src = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8').split(String.fromCharCode(13)).join('');
  const a = src.indexOf("ipcMain.handle('archive:extract'"), b = src.indexOf('\n});\n', a) + 5;
  const re = src.match(/const OPEN_DOC_RE = (\/.*\/i);/);
  if (a < 0 || b < 5 || !re) throw new Error('main.js archive:extract 구간을 찾지 못함');
  const archive = require(path.join(ROOT, 'archive.js'));
  new Function('ipcMain', 'archive', 'fs', 'path', 'require', '__dirname', 'OPEN_DOC_RE', src.slice(a, b))(ipcMain, archive, fs, path, require, ROOT, eval(re[1]));
}

function crc32(b) { let c, t = crc32.t; if (!t) { t = crc32.t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } } c = 0xffffffff; for (const x of b) c = t[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function makeZip(entries) {   // { name: Buffer|string, data, utf8 }
  const parts = [], cds = []; let off = 0;
  for (const e of entries) {
    const name = Buffer.isBuffer(e.name) ? e.name : Buffer.from(e.name, 'utf8'), data = Buffer.from(e.data), comp = zlib.deflateRawSync(data), fl = e.utf8 ? 0x800 : 0;
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(fl, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc32(data), 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26);
    parts.push(lh, name, comp);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(fl, 8); cd.writeUInt16LE(8, 10);
    cd.writeUInt32LE(crc32(data), 16); cd.writeUInt32LE(comp.length, 20); cd.writeUInt32LE(data.length, 24); cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(off, 42);
    cds.push(cd, name); off += 30 + name.length + comp.length;
  }
  const cdBuf = Buffer.concat(cds), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(cdBuf.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cdBuf, end]);
}
const cp949 = s => { const m = { '자': [0xc0, 0xda], '료': [0xb7, 0xe1], '본': [0xba, 0xbb], '문': [0xb9, 0xae] }; const o = []; for (const ch of s) { if (m[ch]) o.push(...m[ch]); else o.push(ch.charCodeAt(0)); } return Buffer.from(o); };

app.commandLine.appendSwitch('disable-gpu');
const USERDATA = path.join(os.tmpdir(), 'pdfedit-e2e-archive-' + process.pid);
app.setPath('userData', USERDATA);
const ARC_BEFORE = new Set(fs.readdirSync(os.tmpdir()).filter(f => /^pdfedit_arc_/.test(f)));
app.whenReady().then(async () => {
  const out = [];
  const ck = (n, c, x) => out.push([c ? '✔' : '✘', n, x === undefined ? '' : JSON.stringify(x)]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arcopen_'));
  const win = new BrowserWindow({ show: false, width: 1300, height: 900, webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, sandbox: false } });
  await win.loadFile(path.join(ROOT, 'src/index.html'));
  await new Promise(r => setTimeout(r, 2500));
  const js = (code) => win.webContents.executeJavaScript(`(async () => { const sleep = ms => new Promise(r => setTimeout(r, ms));
    const waitFor = async (f, ms) => { const t = Date.now(); while (Date.now() - t < (ms || 60000)) { if (f()) return true; await sleep(50); } return false; };
    try { ${code}\n } catch (e) { return { err: String(e && e.stack || e) }; } })()`);
  try {
    // PDF 두 개(2쪽·3쪽)
    const pdfs = await js(`const mk = async n => { const d = await PDFLib.PDFDocument.create(); for (let i = 0; i < n; i++) d.addPage([300, 400]); return Array.from(await d.save()); };
      return [await mk(2), await mk(3)];`);
    const zip2 = path.join(dir, '자료 묶음.zip');
    fs.writeFileSync(zip2, makeZip([
      { name: cp949('자료/본문.pdf'), data: Buffer.from(pdfs[0]) },
      { name: '표지.pdf', data: Buffer.from(pdfs[1]), utf8: true },
      { name: '메모.txt', data: Buffer.from('x'), utf8: true },
    ]));
    const zip1 = path.join(dir, '한개.zip');
    fs.writeFileSync(zip1, makeZip([{ name: '하나.pdf', data: Buffer.from(pdfs[1]), utf8: true }]));
    const zip0 = path.join(dir, '빈것.zip');
    fs.writeFileSync(zip0, makeZip([{ name: '설명.txt', data: Buffer.from('x'), utf8: true }]));

    // ① 문서 둘 → 순서 지정 창
    const o = await js(`await openItemsWithArchives([{ name: '자료 묶음.zip', path: ${JSON.stringify(zip2)} }]);
      await waitFor(() => document.getElementById('orderModal').style.display === 'block', 30000);
      return { shown: document.getElementById('orderModal').style.display === 'block',
        rows: [...document.querySelectorAll('#orderRows .ord-row')].map(r => r.textContent.replace(/\\s+/g, ' ').trim()),
        msg: document.getElementById('success').textContent };`);
    ck('문서 2개 든 ZIP → 순서 지정 창 · 2개(CP949 폴더 "자료" 표시)', o.shown && o.rows.length === 2 && o.rows.some(t => /본문\.pdf/.test(t) && /📦 자료/.test(t)) && o.rows.some(t => /표지\.pdf/.test(t)), o);
    ck('안내: "문서 2개를 꺼냈습니다" · 건너뜀 메모.txt(지원하지 않는 형식)', /문서 2개를 꺼냈습니다/.test(o.msg) && /메모\.txt\(지원하지 않는 형식\)/.test(o.msg), o.msg);
    // ② 📚 통합창 → 한 문서(5쪽, 챕터 2)
    const m = await js(`confirmOpenOrder(true);
      await waitFor(() => pageResults.length === 5 && isTabReady(tabs.get(activeTabId)), 60000);
      const t = tabs.get(activeTabId);
      return { pages: pageResults.length, tabs: tabs.size, chapters: (t.chapters || []).map(c => c.name + ':' + c.count),
        recent: JSON.parse(localStorage.getItem('recentFiles') || '[]').map(r => r.path || r.name) };`);
    ck('📚 통합창 → 한 문서 5쪽 · 챕터 2(본문 2쪽·표지 3쪽)', m.pages === 5 && m.tabs === 1 && m.chapters.length === 2 && m.chapters.includes('본문.pdf:2') && m.chapters.includes('표지.pdf:3'), m);
    ck('꺼낸 임시 경로는 최근 파일에 없음', !m.recent.some(p => /pdfedit_arc_/.test(String(p))), m.recent);
    // ③ 문서 하나뿐인 ZIP → 순서 창 없음 — 이미 문서가 있으면 '챕터로 추가 / 새 탭' 묻는 창(2026-10-21) → 챕터로 추가
    const one = await js(`const n0 = pageResults.length; document.getElementById('orderModal').style.display = 'none';
      const p = openItemsWithArchives([{ name: '한개.zip', path: ${JSON.stringify(zip1)} }]);
      await waitFor(() => !!document.querySelector('.pt-box'), 30000);
      const asked = !!document.querySelector('.pt-box');
      if (asked) [...document.querySelectorAll('.pt-box button')].find(b => /챕터로 추가/.test(b.textContent)).click();
      await p;
      await waitFor(() => pageResults.length === n0 + 3, 60000);
      return { n0, asked, n: pageResults.length, order: document.getElementById('orderModal').style.display };`);
    ck('문서 하나뿐인 ZIP → 순서 창 없이 묻는 창 → 📑 챕터로 추가(열린 문서에 3쪽 이어 붙음)', one.asked && one.n === one.n0 + 3 && one.order === 'none', one);
    // ④ 문서 없는 ZIP → 오류 안내
    const none = await js(`document.getElementById('error').textContent = '';
      await openItemsWithArchives([{ name: '빈것.zip', path: ${JSON.stringify(zip0)} }]);
      return document.getElementById('error').textContent;`);
    ck('문서 없는 ZIP → "열 수 있는 문서가 없습니다"', /열 수 있는 문서.*없습니다/.test(none), none);
  } catch (e) { ck('실행 오류', false, e && e.stack); }
  let fail = 0;
  out.forEach(([mk, n, x]) => { if (mk !== '✔') fail++; console.log(mk, n, mk === '✔' ? '' : x); });
  console.log(`결과: ${out.length - fail} 통과 / ${fail} 실패`);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
  // 이 검사가 만든 꺼낸 폴더만 지운다(사용자가 켜 둔 앱의 pdfedit_arc_ 폴더는 건드리지 않는다)
  for (const f of fs.readdirSync(os.tmpdir())) if (/^pdfedit_arc_/.test(f) && !ARC_BEFORE.has(f)) { try { fs.rmSync(path.join(os.tmpdir(), f), { recursive: true, force: true }); } catch (e) {} }
  win.destroy();
  setTimeout(() => { try { fs.rmSync(USERDATA, { recursive: true, force: true }); } catch (e) {} }, 0);
  app.exit(fail ? 1 : 0);
});
