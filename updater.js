// 🔄 업데이트 파일(.pdfupd) — 만들기(관리자 PC) · 확인 · 적용 · 되돌리기
// 2026-10-27 사용자 요청: 버전이 오를 때마다 포터블 폴더 전체(약 400MB)를 다시 보내지 않고
// 프로그램 파일만 담은 업데이트 파일 하나로 올린다.
//
// · 담는 것: resources/app 아래 프로그램 파일 전체(누적 — 어느 옛 버전에 적용해도 빠지는 파일이 없다).
//   node_modules는 거의 안 바뀌어 기본 제외(includeModules), 실행 폴더의 설치 스크립트 몇 개(ROOT_FILES).
//   Electron 실행기·Ghostscript는 담지 않는다 — Electron 버전을 올릴 때만 전체 재배포.
// · 형식: 'PDFEDITUPD1\n' + uint32(서명 매니페스트 길이) + 서명 매니페스트(license.js signToken —
//   체험판 키와 같은 관리자 서명) + 파일마다 gzip 조각. 매니페스트에 파일 경로·크기·SHA-256.
//   format:'pdf-editor-update'로 라이선스 토큰과 섞이지 않게 한다(서로 바꿔치기 불가).
// · 적용: 서명·버전·해시 확인 → 바뀔 파일 백업(userData/update-backup) → 쓰기(실패하면 백업으로 되돌림)
//   → 앱 다시 시작(main). 되돌리기 = 백업 되살리기(그때 없던 파일은 지운다).
// · 경로 안전: 매니페스트 경로는 'resources/app/…' 또는 실행 폴더의 허용 확장자 파일만 — '..'·절대 경로 거부.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const license = require('./license');

const MAGIC = Buffer.from('PDFEDITUPD1\n', 'latin1');
const FORMAT = 'pdf-editor-update';
const ROOT_FILES = ['install-portable.ps1', '설치.bat', 'SETUP.bat'];   // 실행 폴더에 같이 두는 설치 스크립트
const ROOT_EXT = /\.(ps1|bat|pdf|txt|html)$/i;

const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');

// '3.10.0' > '3.9.2' — 숫자 단위 비교
function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(x => parseInt(x, 10) || 0);
  const pb = String(b || '0').split('.').map(x => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

// 매니페스트 경로 검사 — 실행 폴더 밖으로 나가거나 실행 파일·DLL을 건드리지 못하게
function safeRel(p) {
  const s = String(p || '').replace(/\\/g, '/');
  if (!s || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.split('/').some(x => x === '..' || x === '.' || x === '')) return null;
  if (s.startsWith('resources/app/')) return s;
  if (!s.includes('/') && ROOT_EXT.test(s)) return s;
  return null;
}

function walk(dir, base, out, skip) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, ent.name);
    const rel = (base ? base + '/' : '') + ent.name;
    if (skip && skip(rel, ent)) continue;
    if (ent.isDirectory()) walk(abs, rel, out, skip);
    else if (ent.isFile()) out.push({ abs, rel });
  }
  return out;
}

// ── 만들기 (관리자 PC) ────────────────────────────────────────────────────────
// installDir: 포터블 실행 폴더(dist/win-unpacked). version: 새 버전(resources/app/package.json에도 적는다).
function buildUpdate({ installDir, version, notes, includeModules, privPem }) {
  if (!privPem) throw new Error('관리자 개인키가 없습니다 — 업데이트 파일은 관리자 PC에서만 만들 수 있습니다.');
  const appDir = path.join(installDir, 'resources', 'app');
  if (!fs.existsSync(path.join(appDir, 'package.json'))) throw new Error('resources/app/package.json을 찾을 수 없습니다: ' + appDir);
  const files = walk(appDir, 'resources/app', [], (rel, ent) =>
    (!includeModules && ent.isDirectory() && rel === 'resources/app/node_modules'));
  for (const r of ROOT_FILES) { const abs = path.join(installDir, r); if (fs.existsSync(abs)) files.push({ abs, rel: r }); }
  const entries = [], blobs = [];
  for (const f of files) {
    let data = fs.readFileSync(f.abs);
    if (f.rel === 'resources/app/package.json' && version) {   // 새 버전을 적는다(app.getVersion이 여기서 읽는다)
      const pj = JSON.parse(data.toString('utf8')); pj.version = version;
      data = Buffer.from(JSON.stringify(pj, null, 2) + '\n', 'utf8');
    }
    const z = zlib.gzipSync(data, { level: 9 });
    entries.push({ p: f.rel, size: data.length, sha256: sha256(data), z: z.length });
    blobs.push(z);
  }
  const pj = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
  const manifest = { format: FORMAT, v: 1, version: version || pj.version, createdAt: Date.now(),
    notes: String(notes || '').slice(0, 4000), modules: !!includeModules, files: entries };
  const token = Buffer.from(license.signToken(manifest, privPem), 'utf8');
  const len = Buffer.alloc(4); len.writeUInt32LE(token.length, 0);
  return { bytes: Buffer.concat([MAGIC, len, token, ...blobs]), manifest };
}

// ── 확인 (서명·형식·해시) ──────────────────────────────────────────────────────
// 반환 { manifest, files: [{p, data}] } — 문제가 있으면 한국어 오류를 던진다.
function readUpdate(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < MAGIC.length + 4 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('PDF Editor 업데이트 파일(.pdfupd)이 아닙니다.');
  const tlen = buf.readUInt32LE(MAGIC.length);
  const t0 = MAGIC.length + 4;
  if (t0 + tlen > buf.length) throw new Error('업데이트 파일이 잘렸습니다.');
  const manifest = license.verifyToken(buf.subarray(t0, t0 + tlen).toString('utf8'));
  if (!manifest) throw new Error('업데이트 파일의 서명이 맞지 않습니다 — 발급자가 만든 파일이 아니거나 손상되었습니다.');
  if (manifest.format !== FORMAT || !Array.isArray(manifest.files) || !manifest.version) throw new Error('업데이트 파일 형식이 아닙니다.');
  let off = t0 + tlen;
  const files = [];
  for (const e of manifest.files) {
    const rel = safeRel(e.p);
    if (!rel) throw new Error('허용되지 않은 경로가 들어 있습니다: ' + e.p);
    if (off + e.z > buf.length) throw new Error('업데이트 파일이 잘렸습니다.');
    let data;
    try { data = zlib.gunzipSync(buf.subarray(off, off + e.z)); } catch (err) { throw new Error('업데이트 파일이 손상되었습니다: ' + rel); }
    if (data.length !== e.size || sha256(data) !== e.sha256) throw new Error('업데이트 파일이 손상되었습니다(해시 불일치): ' + rel);
    files.push({ p: rel, data });
    off += e.z;
  }
  return { manifest, files };
}

// ── 적용 ──────────────────────────────────────────────────────────────────────
// installDir: 실행 폴더(exe 있는 곳). backupDir: userData/update-backup. 내용이 같은 파일은 건드리지 않는다.
function applyUpdate({ buf, installDir, backupDir, currentVersion }) {
  const { manifest, files } = readUpdate(buf);
  const changed = files.filter(f => {
    const abs = path.join(installDir, ...f.p.split('/'));
    try { return !fs.existsSync(abs) || sha256(fs.readFileSync(abs)) !== sha256(f.data); } catch (e) { return true; }
  });
  // 백업 — 지난 백업은 지우고 이번 것만 둔다(되돌리기는 한 단계)
  fs.rmSync(backupDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(backupDir, 'files'), { recursive: true });
  const record = { fromVersion: currentVersion || '', toVersion: manifest.version, at: Date.now(), files: [] };
  try {
    for (const f of changed) {
      const abs = path.join(installDir, ...f.p.split('/'));
      const existed = fs.existsSync(abs);
      if (existed) {
        if (!fs.statSync(abs).isFile()) throw new Error('파일 자리에 폴더가 있습니다: ' + f.p);
        const bk = path.join(backupDir, 'files', ...f.p.split('/'));
        fs.mkdirSync(path.dirname(bk), { recursive: true });
        fs.copyFileSync(abs, bk);
      }
      record.files.push({ p: f.p, existed });
    }
    fs.writeFileSync(path.join(backupDir, 'backup.json'), JSON.stringify(record, null, 1), 'utf8');
  } catch (e) {
    fs.rmSync(backupDir, { recursive: true, force: true });
    throw new Error('업데이트 전에 지금 파일을 백업하지 못해 적용하지 않았습니다(아무것도 바뀌지 않음). ' + (e && e.message ? e.message : String(e)));
  }
  // 쓰기 — 임시 이름으로 쓴 뒤 바꾼다. 하나라도 실패하면 이미 쓴 것까지 백업으로 되돌린다.
  const done = [];
  try {
    for (const f of changed) {
      const abs = path.join(installDir, ...f.p.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      const tmp = abs + '.updnew';
      fs.writeFileSync(tmp, f.data);
      fs.renameSync(tmp, abs);
      done.push(f.p);
    }
  } catch (e) {
    restoreFiles(installDir, backupDir, record.files.filter(r => done.includes(r.p)));
    for (const f of changed) { try { fs.rmSync(path.join(installDir, ...f.p.split('/')) + '.updnew', { force: true }); } catch (x) {} }
    const perm = e && (e.code === 'EPERM' || e.code === 'EACCES');
    throw new Error((perm ? '프로그램 폴더에 쓸 권한이 없습니다(관리자 권한이 필요한 위치일 수 있습니다). ' : '업데이트를 쓰다가 실패해 원래대로 되돌렸습니다. ')
      + (e && e.message ? e.message : String(e)));
  }
  return { version: manifest.version, changed: changed.length, total: files.length, notes: manifest.notes || '' };
}

function restoreFiles(installDir, backupDir, list) {
  for (const r of list) {
    const abs = path.join(installDir, ...r.p.split('/'));
    if (r.existed) {
      const bk = path.join(backupDir, 'files', ...r.p.split('/'));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.copyFileSync(bk, abs);
    } else {
      try { fs.rmSync(abs, { force: true }); } catch (e) {}
    }
  }
}
function backupInfo(backupDir) {
  try { return JSON.parse(fs.readFileSync(path.join(backupDir, 'backup.json'), 'utf8')); } catch (e) { return null; }
}
// ↺ 이전 버전으로 — 마지막 업데이트 전 상태
function rollbackUpdate({ installDir, backupDir }) {
  const rec = backupInfo(backupDir);
  if (!rec) throw new Error('되돌릴 업데이트 백업이 없습니다.');
  restoreFiles(installDir, backupDir, rec.files);
  fs.rmSync(backupDir, { recursive: true, force: true });
  return { version: rec.fromVersion, files: rec.files.length };
}

module.exports = { MAGIC, FORMAT, compareVersions, safeRel, buildUpdate, readUpdate, applyUpdate, rollbackUpdate, backupInfo };
