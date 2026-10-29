// 🔄 updater.js — 업데이트 파일 만들기·확인·적용·되돌리기 (노드 단독, smoke에 포함)
//   실행: node scripts/test/updater.test.js
// 임시 폴더에 가짜 포터블 설치(resources/app …)를 만들어 실제 모듈로 검사한다.
// 관리자 PC(개인키 있음)면 진짜 서명으로 만들기·적용·되돌리기까지, 아니면 거부 경로만.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const license = require(path.join(ROOT, 'license.js'));
const U = require(path.join(ROOT, 'updater.js'));

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log('  ✘ ' + m); } };
const throwsLike = (fn, re, m) => { try { fn(); ok(false, m + ' (오류가 나지 않음)'); } catch (e) { ok(re.test(e.message), m + ' — ' + e.message); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfedit-upd-'));
const mk = (dir, files) => { for (const [p, c] of Object.entries(files)) { const a = path.join(dir, ...p.split('/')); fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, c); } };
const rd = (dir, p) => { try { return fs.readFileSync(path.join(dir, ...p.split('/')), 'utf8'); } catch (e) { return null; } };

try {
  // ① 버전 비교·경로 검사
  ok(U.compareVersions('3.10.0', '3.9.9') === 1 && U.compareVersions('3.9.0', '3.9.0') === 0 && U.compareVersions('3.8.1', '3.9') === -1, '버전 비교');
  ok(U.safeRel('resources/app/src/a.js') && U.safeRel('설치.bat') && !U.safeRel('../x.js') && !U.safeRel('resources/app/../../x')
     && !U.safeRel('C:/Windows/x.dll') && !U.safeRel('/etc/x') && !U.safeRel('PDF 분석기.exe') && !U.safeRel('resources/elevate.exe')
     && !U.safeRel('resources/app//a.js'), '경로 검사: resources/app 아래·실행 폴더 스크립트만');

  // ② 형식 아닌 파일·남의 키로 서명한 파일 거부
  throwsLike(() => U.readUpdate(Buffer.from('hello world')), /업데이트 파일\(\.pdfupd\)이 아닙니다/, '형식 아닌 파일 거부');
  {
    const kp = crypto.generateKeyPairSync('ed25519');
    const fake = kp.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const oldDir = path.join(tmp, 'forge');
    mk(oldDir, { 'resources/app/package.json': '{"name":"pdf-analyzer","version":"3.8.1","main":"main.js"}', 'resources/app/main.js': 'x' });
    const { bytes } = U.buildUpdate({ installDir: oldDir, version: '9.9.9', privPem: fake });
    throwsLike(() => U.readUpdate(bytes), /서명이 맞지 않습니다/, '발급자 키가 아닌 서명 거부(위조)');
  }

  const admin = license.adminData();
  if (admin && license.isAdminPC()) {
    // ③ 옛 설치(3.8.1)와 새 포터블(→ 3.9.0)
    const oldDir = path.join(tmp, 'old'), newDir = path.join(tmp, 'new');
    const base = {
      'resources/app/package.json': '{"name":"pdf-analyzer","version":"3.8.1","main":"main.js"}',
      'resources/app/main.js': 'main-v1', 'resources/app/src/a.js': 'a-v1', 'resources/app/src/same.js': 'same',
      'resources/app/node_modules/pdf-lib/index.js': 'lib-v1', 'install-portable.ps1': 'ps-v1', 'PDF 분석기.exe': 'EXE',
    };
    mk(oldDir, base);
    mk(newDir, Object.assign({}, base, { 'resources/app/src/a.js': 'a-v2', 'resources/app/src/b.js': 'b-new', 'install-portable.ps1': 'ps-v2',
      'resources/app/node_modules/pdf-lib/index.js': 'lib-v2', 'PDF 분석기.exe': 'EXE2' }));
    const { bytes, manifest } = U.buildUpdate({ installDir: newDir, version: '3.9.0', notes: '시험', privPem: admin.priv });
    const paths = manifest.files.map(f => f.p);
    ok(!paths.some(p => p.includes('node_modules')) && !paths.includes('PDF 분석기.exe') && paths.includes('install-portable.ps1') && paths.includes('resources/app/src/b.js'),
      '담는 것: resources/app(모듈 제외)·설치 스크립트 — 실행 파일은 안 담는다 ' + JSON.stringify(paths));
    const rr = U.readUpdate(bytes);
    ok(rr.manifest.version === '3.9.0' && JSON.parse(rr.files.find(f => f.p === 'resources/app/package.json').data).version === '3.9.0', '서명 확인 · package.json 버전 3.9.0');
    // 손상: 끝 바이트 하나 바꾸기
    const bad = Buffer.from(bytes); bad[bad.length - 5] ^= 0xff;
    throwsLike(() => U.readUpdate(bad), /손상/, '내용이 한 바이트만 바뀌어도 거부');
    // 매니페스트를 바꿔 끼우기(라이선스 토큰처럼 다른 서명 내용) → 형식 거부
    {
      const tok = Buffer.from(license.signToken({ v: 1, key: 'PDFE-XXXX', hwid: 'h', exp: 1 }, admin.priv), 'utf8');
      const len = Buffer.alloc(4); len.writeUInt32LE(tok.length, 0);
      throwsLike(() => U.readUpdate(Buffer.concat([U.MAGIC, len, tok])), /형식이 아닙니다/, '라이선스 토큰을 업데이트로 쓰지 못한다');
    }
    // 서명된 매니페스트에 '..' 경로 → 거부
    {
      const zlib = require('zlib');
      const data = Buffer.from('evil'); const z = zlib.gzipSync(data);
      const man = { format: U.FORMAT, v: 1, version: '9.0.0', files: [{ p: 'resources/app/../../evil.js', size: 4, sha256: crypto.createHash('sha256').update(data).digest('hex'), z: z.length }] };
      const tok = Buffer.from(license.signToken(man, admin.priv), 'utf8');
      const len = Buffer.alloc(4); len.writeUInt32LE(tok.length, 0);
      throwsLike(() => U.readUpdate(Buffer.concat([U.MAGIC, len, tok, z])), /허용되지 않은 경로/, "서명돼 있어도 '..' 경로는 거부");
    }
    // ④ 적용
    const bkDir = path.join(tmp, 'backup');
    const ap = U.applyUpdate({ buf: bytes, installDir: oldDir, backupDir: bkDir, currentVersion: '3.8.1' });
    ok(ap.version === '3.9.0' && ap.changed === 4, `적용: 바뀐 파일만 쓴다(package.json·a.js·b.js·설치 스크립트 = 4) → ${ap.changed}`);
    ok(rd(oldDir, 'resources/app/src/a.js') === 'a-v2' && rd(oldDir, 'resources/app/src/b.js') === 'b-new' && rd(oldDir, 'install-portable.ps1') === 'ps-v2'
       && JSON.parse(rd(oldDir, 'resources/app/package.json')).version === '3.9.0', '적용 후 새 내용·새 버전');
    ok(rd(oldDir, 'resources/app/node_modules/pdf-lib/index.js') === 'lib-v1' && rd(oldDir, 'PDF 분석기.exe') === 'EXE', '모듈·실행 파일은 그대로');
    ok(!fs.readdirSync(path.join(oldDir, 'resources', 'app', 'src')).some(n => n.endsWith('.updnew')), '임시 파일이 남지 않는다');
    const info = U.backupInfo(bkDir);
    ok(info && info.fromVersion === '3.8.1' && info.toVersion === '3.9.0' && info.files.length === 4, '백업 기록');
    // ⑤ 되돌리기
    const rb = U.rollbackUpdate({ installDir: oldDir, backupDir: bkDir });
    ok(rb.version === '3.8.1' && rd(oldDir, 'resources/app/src/a.js') === 'a-v1' && rd(oldDir, 'resources/app/src/b.js') === null
       && rd(oldDir, 'install-portable.ps1') === 'ps-v1' && JSON.parse(rd(oldDir, 'resources/app/package.json')).version === '3.8.1' && !U.backupInfo(bkDir),
      '되돌리기: 옛 내용·새로 생긴 파일 지움·버전 3.8.1·백업 정리');
    // ⑥ 백업 단계에서 막히면 아무것도 안 바뀐다 — 새 파일 자리에 같은 이름 폴더
    fs.mkdirSync(path.join(oldDir, 'resources', 'app', 'src', 'b.js'), { recursive: true });
    throwsLike(() => U.applyUpdate({ buf: bytes, installDir: oldDir, backupDir: bkDir, currentVersion: '3.8.1' }), /백업하지 못해 적용하지 않았습니다/, '백업 실패 → 적용 안 함');
    ok(rd(oldDir, 'resources/app/src/a.js') === 'a-v1' && JSON.parse(rd(oldDir, 'resources/app/package.json')).version === '3.8.1' && !U.backupInfo(bkDir), '백업 실패 시 파일·버전 그대로');
    fs.rmSync(path.join(oldDir, 'resources', 'app', 'src', 'b.js'), { recursive: true, force: true });
    // ⑦ 쓰다가 실패하면 이미 쓴 파일까지 원래대로 — 뒤쪽 파일(설치 스크립트)을 읽기 전용으로 두어 덮어쓰기 실패
    const ro = path.join(oldDir, 'install-portable.ps1');
    fs.chmodSync(ro, 0o444);
    throwsLike(() => U.applyUpdate({ buf: bytes, installDir: oldDir, backupDir: bkDir, currentVersion: '3.8.1' }), /원래대로 되돌렸습니다|쓸 권한이 없습니다/, '쓰기 실패 → 오류');
    fs.chmodSync(ro, 0o666);
    ok(rd(oldDir, 'resources/app/src/a.js') === 'a-v1' && rd(oldDir, 'resources/app/src/b.js') === null && JSON.parse(rd(oldDir, 'resources/app/package.json')).version === '3.8.1'
       && rd(oldDir, 'install-portable.ps1') === 'ps-v1', '쓰기 실패 시 이미 쓴 파일도 원래대로(새 파일은 지움)');
  } else {
    console.log('  (관리자 개인키 없음 — 만들기·적용 검사는 건너뜀)');
  }
} catch (e) { fail++; console.log('  ✘ 예외: ' + (e && e.stack || e)); }
finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {} }
console.log(`updater.test: 통과 ${pass} · 실패 ${fail}`);
process.exit(fail ? 1 : 0);
