// 📦 압축 파일 풀기 — 드롭·열기·보내기로 받은 압축 파일 속 문서를 꺼내 분석 파이프라인으로 넘긴다 (2026-10-20)
//   ZIP은 직접 푼다(Node zlib) — 윈도 탐색기·반디집이 만든 ZIP은 파일 이름이 CP949라 7-Zip·Expand-Archive가
//   한글을 깨뜨린다. 이름 표시 비트(UTF-8)·Info-ZIP 유니코드 경로(0x7075)를 먼저 보고, 없으면 UTF-8로
//   읽어 보고 안 되면 CP949(euc-kr)로 읽는다. 7z·RAR·ALZ·EGG·TAR 등과 ZIP의 Deflate64(윈도 '압축 폴더'가 큰 파일에 씀)는 7-Zip이 있으면 7-Zip으로.
//   꺼낸 파일은 tmpdir/pdfedit_arc_* 폴더(main sweepTempConversions가 시작·종료 때 지운다)에 **파일 이름만** 써서
//   경로 조작(../)이 끼어들 틈이 없다. 압축 폭탄은 선언 크기 상한(maxOutputLength)·합계 상한으로 막는다.
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const cp = require('child_process');

const ARCHIVE_RE = /\.(zip|7z|rar|alz|egg|tar|tgz|gz|bz2|xz|cab)$/i;
const MAX_TOTAL = 16 * 1024 * 1024 * 1024;   // 꺼낼 합계 상한 16GB
const MAX_DEPTH = 2;                           // 압축 속 압축은 두 겹까지

function decodeName(buf, utf8Flag) {
  if (utf8Flag) return buf.toString('utf8');
  if (!buf.some(b => b > 0x7f)) return buf.toString('latin1');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (e) {}
  try { return new TextDecoder('euc-kr').decode(buf); } catch (e) {}
  return buf.toString('latin1');
}

// ZIP 목차(중앙 디렉터리) 읽기 — ZIP64 포함
function readZipEntries(fd, size) {
  const tailLen = Math.min(size, 65557 + 20);
  const tail = Buffer.alloc(tailLen);
  fs.readSync(fd, tail, 0, tailLen, size - tailLen);
  let e = -1;
  for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  if (e < 0) throw new Error('ZIP 파일이 아니거나 손상되었습니다(목차 없음).');
  let count = tail.readUInt16LE(e + 10), cdSize = tail.readUInt32LE(e + 12), cdOff = tail.readUInt32LE(e + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) {
    const l = e - 20;   // ZIP64 위치 표
    if (l >= 0 && tail.readUInt32LE(l) === 0x07064b50) {
      const off64 = Number(tail.readBigUInt64LE(l + 8));
      const r = Buffer.alloc(56); fs.readSync(fd, r, 0, 56, off64);
      if (r.readUInt32LE(0) === 0x06064b50) {
        count = Number(r.readBigUInt64LE(32)); cdSize = Number(r.readBigUInt64LE(40)); cdOff = Number(r.readBigUInt64LE(48));
      }
    }
  }
  if (cdOff + cdSize > size) throw new Error('ZIP 목차가 잘렸습니다.');
  const cd = Buffer.alloc(cdSize); fs.readSync(fd, cd, 0, cdSize, cdOff);
  const out = [];
  let p = 0;
  for (let k = 0; k < count && p + 46 <= cd.length; k++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const flags = cd.readUInt16LE(p + 8), method = cd.readUInt16LE(p + 10);
    let csize = cd.readUInt32LE(p + 20), usize = cd.readUInt32LE(p + 24);
    const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
    let lho = cd.readUInt32LE(p + 42);
    const nameBuf = cd.subarray(p + 46, p + 46 + nlen);
    const extra = cd.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
    let name = null;
    for (let x = 0; x + 4 <= extra.length;) {
      const id = extra.readUInt16LE(x), len = extra.readUInt16LE(x + 2), d = extra.subarray(x + 4, x + 4 + len);
      if (id === 0x0001) {   // ZIP64 — 0xffffffff인 값만 순서대로 들어 있다
        let q = 0;
        if (usize === 0xffffffff && q + 8 <= d.length) { usize = Number(d.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff && q + 8 <= d.length) { csize = Number(d.readBigUInt64LE(q)); q += 8; }
        if (lho === 0xffffffff && q + 8 <= d.length) { lho = Number(d.readBigUInt64LE(q)); q += 8; }
      } else if (id === 0x7075 && d.length > 5) {   // Info-ZIP 유니코드 경로
        name = d.subarray(5).toString('utf8');
      }
      x += 4 + len;
    }
    if (name == null) name = decodeName(nameBuf, (flags & 0x800) !== 0);
    out.push({ name: name.normalize('NFC').replace(/\\/g, '/'), flags, method, csize, usize, lho });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

function readZipEntryData(fd, ent) {
  const h = Buffer.alloc(30); fs.readSync(fd, h, 0, 30, ent.lho);
  if (h.readUInt32LE(0) !== 0x04034b50) throw new Error('항목 머리가 손상되었습니다.');
  const start = ent.lho + 30 + h.readUInt16LE(26) + h.readUInt16LE(28);
  const comp = Buffer.alloc(ent.csize); fs.readSync(fd, comp, 0, ent.csize, start);
  if (ent.method === 0) return comp;
  if (ent.method === 8) return zlib.inflateRawSync(comp, { maxOutputLength: Math.max(1, ent.usize) });
  const e = new Error('지원하지 않는 압축 방식(' + ent.method + ')'); e.code = 'METHOD'; throw e;
}

function find7z() {
  const c = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], 'C:\\Program Files', 'D:\\Program Files']
    .filter(Boolean).map(d => path.join(d, '7-Zip', '7z.exe'));
  for (const p of c) { try { if (fs.existsSync(p)) return p; } catch (e) {} }
  try { const r = cp.execFileSync('where', ['7z'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)[0].trim(); if (r) return r; } catch (e) {}
  return null;
}

const safeBase = (n) => (path.basename(String(n).replace(/\\/g, '/')) || 'file').replace(/[<>:"|?*\x00-\x1f]/g, '_').slice(0, 180);

// 압축 하나를 풀어 문서만 꺼낸다. wanted(name) = 꺼낼 문서인가. 반환 { items:[{path,name,rel}], skipped:[{name,reason}] }
function extractArchive(archivePath, wanted, opts, depth) {
  opts = opts || {}; depth = depth || 0;
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit_arc_'));
  const res = { dir, items: [], skipped: [] };
  const arcName = path.basename(archivePath);
  const used = new Set(fs.readdirSync(dir).map(n => n.toLowerCase()));
  const uniq = (base) => {
    let n = base, k = 1;
    const ext = path.extname(base), stem = base.slice(0, base.length - ext.length);
    while (used.has(n.toLowerCase())) n = `${stem} (${++k})${ext}`;
    used.add(n.toLowerCase());
    return n;
  };
  const total = opts.total || { n: 0 };
  const take = (rel, writeTo) => {   // rel = 압축 안 경로 · writeTo(dst) = 파일 쓰기
    const base = safeBase(rel);
    if (ARCHIVE_RE.test(base) && depth < MAX_DEPTH) {
      const tmp = path.join(dir, uniq('_inner_' + base));
      writeTo(tmp);
      try {
        const sub = extractArchive(tmp, wanted, { dir, total, prefix: (opts.prefix || '') + rel + '/' }, depth + 1);
        res.items.push(...sub.items); res.skipped.push(...sub.skipped);
      } catch (e) { res.skipped.push({ name: (opts.prefix || '') + rel, reason: e.message }); }
      try { fs.unlinkSync(tmp); } catch (e) {}
      return;
    }
    if (!wanted(base)) { res.skipped.push({ name: (opts.prefix || '') + rel, reason: '지원하지 않는 형식' }); return; }
    const dst = path.join(dir, uniq(base));
    writeTo(dst);
    res.items.push({ path: dst, name: base, rel: (opts.prefix || '') + rel });
  };

  const isZip = /\.zip$/i.test(archivePath) || (() => { try { const b = Buffer.alloc(4); const fd = fs.openSync(archivePath, 'r'); fs.readSync(fd, b, 0, 4, 0); fs.closeSync(fd); return b.readUInt32LE(0) === 0x04034b50; } catch (e) { return false; } })();
  let needSeven = !isZip;
  if (isZip) {
    const fd = fs.openSync(archivePath, 'r');
    try {
      const ents = readZipEntries(fd, fs.fstatSync(fd).size)
        .filter(e => !e.name.endsWith('/') && !/(^|\/)__MACOSX\//.test(e.name) && !/(^|\/)\.[^/]*$/.test(e.name) && !/(^|\/)Thumbs\.db$/i.test(e.name));
      for (const ent of ents) {
        const base = safeBase(ent.name);
        if (!wanted(base) && !(ARCHIVE_RE.test(base) && depth < MAX_DEPTH)) { res.skipped.push({ name: (opts.prefix || '') + ent.name, reason: '지원하지 않는 형식' }); continue; }
        if (ent.flags & 1) { res.skipped.push({ name: (opts.prefix || '') + ent.name, reason: '암호가 걸린 파일' }); continue; }
        if (ent.method !== 0 && ent.method !== 8) { needSeven = true; continue; }   // Deflate64 등 — 아래에서 7-Zip으로
        total.n += ent.usize;
        if (total.n > MAX_TOTAL) throw new Error('압축을 풀면 16GB가 넘습니다 — 필요한 파일만 따로 풀어 여세요.');
        try { take(ent.name, dst => fs.writeFileSync(dst, readZipEntryData(fd, ent))); }
        catch (e) { res.skipped.push({ name: (opts.prefix || '') + ent.name, reason: '풀기 실패: ' + e.message }); }
      }
    } finally { fs.closeSync(fd); }
    // ZIP 안에 zlib이 못 푸는 항목(Deflate64 등)이 있었다 — 7-Zip으로 그 ZIP을 풀어 남은 것만(이미 꺼낸 것은 건너뜀)
    if (needSeven) extractWith7z(archivePath, new Set(res.items.map(i => i.rel)));
    return res;
  }
  extractWith7z(archivePath, new Set());
  return res;

  // 7-Zip으로 풀고 문서만 옮긴다(결과는 res에 바로) · done = 이미 꺼낸 항목(압축 안 경로)
  function extractWith7z(arc, done) {
    const seven = find7z();
    if (!seven) { res.skipped.push({ name: (opts.prefix || '') + arcName, reason: '이 압축 형식은 7-Zip이 있어야 풀 수 있습니다(7-zip.org에서 설치)' }); return; }
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit_arc_'));
    try {
      const run = cp.spawnSync(seven, ['x', '-y', '-bd', '-p', '-o' + work, arc], { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (run.status !== 0 && run.status !== 1) {
        const msg = /Wrong password|암호/i.test((run.stderr || '') + (run.stdout || '')) ? '암호가 걸린 압축' : '7-Zip으로 풀지 못했습니다';
        res.skipped.push({ name: (opts.prefix || '') + arcName, reason: msg });
      }
      const walk = (d, relBase) => {
        for (const n of fs.readdirSync(d).sort()) {
          const full = path.join(d, n), rel = relBase ? relBase + '/' + n : n;
          const st = fs.statSync(full);
          if (st.isDirectory()) { if (n !== '__MACOSX') walk(full, rel); continue; }
          if (n.startsWith('.') || /^Thumbs\.db$/i.test(n) || done.has((opts.prefix || '') + rel)) continue;
          total.n += st.size;
          if (total.n > MAX_TOTAL) throw new Error('압축을 풀면 16GB가 넘습니다 — 필요한 파일만 따로 풀어 여세요.');
          take(rel, dst => fs.renameSync(full, dst));
        }
      };
      walk(work, '');
    } finally { try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {} }
  }
}

// 여러 압축을 한꺼번에 — 꺼낸 문서는 압축 안 경로 순(한글·숫자 자연 정렬)
function extractArchives(paths, wanted) {
  const all = { items: [], skipped: [], dirs: [] };
  for (const p of paths) {
    try {
      const r = extractArchive(p, wanted);
      const arc = path.basename(p);
      r.items.sort((a, b) => a.rel.localeCompare(b.rel, 'ko', { numeric: true }));
      r.items.forEach(it => { it.archive = arc; });
      all.items.push(...r.items); all.skipped.push(...r.skipped.map(s => Object.assign(s, { archive: arc })));
      all.dirs.push(r.dir);
    } catch (e) {
      all.skipped.push({ name: path.basename(p), archive: path.basename(p), reason: e.message });
    }
  }
  return all;
}

module.exports = { ARCHIVE_RE, extractArchive, extractArchives, readZipEntries, decodeName, find7z };

// 작업 스레드로 돌릴 때(main archive:extract) — 큰 압축을 풀어도 앱 창이 멈추지 않게
const { isMainThread, parentPort, workerData } = require('worker_threads');
if (!isMainThread && workerData && workerData.archiveJob) {
  try {
    const re = new RegExp(workerData.wantRe, 'i');
    parentPort.postMessage({ ok: true, res: extractArchives(workerData.paths, n => re.test(n)) });
  } catch (e) { parentPort.postMessage({ ok: false, err: (e && e.message) || String(e) }); }
}
