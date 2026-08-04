// ── 모바일 브리지: window.electronAPI 의 안드로이드(Capacitor)판 ─────────────
// 데스크톱 앱은 preload.js(fs 직접 접근)를 쓰지만, 모바일은 파일이 경로가 아닌
// File 객체로 오므로 "가상 경로(mob://) → 메모리 바이트" 맵으로 같은 API 모양을 유지한다.
// HWP/Office/Adobe 변환·잉크판정·견적서 PDF는 사무실 PC 서버(remote-server.js)에 HTTP 위임.
// app-core.js 보다 먼저 로드되어야 한다 (mobile-boot.js가 순서 보장).
(function () {
  'use strict';
  window.__MOBILE__ = true;

  const Cap = window.Capacitor || null;
  const Plugins = Cap && Cap.Plugins ? Cap.Plugins : {};

  // ── 가상 파일 저장소 (mob://<종류>_<id> → { bytes:ArrayBuffer, name }) ─────
  // 총량 상한을 두고 오래된 것부터 밀어낸다(폰 메모리 보호).
  const FILE_CAP_BYTES = 512 * 1024 * 1024;
  const _files = new Map();
  let _fileSeq = 0;
  function putFile(kind, name, bytes) {
    const key = `mob://${kind}_${++_fileSeq}/${name}`;
    _files.set(key, { bytes, name });
    let total = 0;
    for (const v of _files.values()) total += v.bytes.byteLength;
    for (const [k, v] of _files) {
      if (total <= FILE_CAP_BYTES) break;
      _files.delete(k); total -= v.bytes.byteLength;
    }
    return key;
  }
  function getFile(key) {
    const e = _files.get(key);
    if (!e) throw new Error('파일이 메모리에서 해제되었습니다 — 파일을 다시 열어 주세요.');
    return e;
  }

  // ── PC 서버 연결 설정 (localStorage) ──────────────────────────────────────
  function serverCfg() {
    try { return JSON.parse(localStorage.getItem('mobServer') || 'null'); } catch (e) { return null; }
  }
  function saveServerCfg(cfg) {
    localStorage.setItem('mobServer', JSON.stringify(cfg));
    try { renderServerCard(); } catch (e) {}
  }
  window.__mobSaveServerCfg = saveServerCfg;   // 딥링크(pdfeditor://connect) 수신부가 사용

  async function serverFetch(path, opts, errWhat) {
    const cfg = serverCfg();
    if (!cfg || !cfg.host) throw new Error(`${errWhat}은(는) 사무실 PC가 필요합니다 — 좌측 'PC 서버 연결'에서 PC를 등록하세요 (PC 앱의 📱 모바일 연동 QR).`);
    opts = opts || {};
    opts.headers = Object.assign({ 'X-Auth-Token': cfg.token || '' }, opts.headers || {});
    let r;
    try {
      r = await fetch(`http://${cfg.host}${path}`, opts);
    } catch (e) {
      throw new Error(`PC 서버(${cfg.host})에 연결할 수 없습니다 — PC가 켜져 있고 같은 WiFi인지 확인하세요. PC가 절전이면 'PC 깨우기'를 눌러 보세요.`);
    }
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { msg = (await r.json()).error || msg; } catch (e) {}
      throw new Error(msg);
    }
    return r;
  }

  async function convertViaServer(type, key) {
    const f = getFile(key);
    const r = await serverFetch(`/convert/${type}`, {
      method: 'POST',
      headers: { 'X-File-Name': encodeURIComponent(f.name) },
      body: f.bytes,
    }, '문서 변환');
    const pdf = await r.arrayBuffer();
    return putFile('conv', f.name.replace(/\.\w+$/, '') + '.pdf', pdf);
  }

  // ── 파일 선택 (숨김 input — WebView가 안드로이드 문서선택기를 연다) ────────
  const _picker = document.createElement('input');
  _picker.type = 'file';
  _picker.multiple = true;
  _picker.accept = '.pdf,.hwp,.hwpx,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.ai,.psd,.indd,application/pdf';
  _picker.style.display = 'none';
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(_picker));

  function pickFiles() {
    return new Promise((resolve) => {
      _picker.value = '';
      _picker.onchange = async () => {
        const out = [];
        for (const f of _picker.files) {
          const bytes = await f.arrayBuffer();   // 선택 시점에 읽어 가상 경로로 보관
          out.push({ path: putFile('file', f.name, bytes), name: f.name });
        }
        resolve(out);
      };
      // 취소 감지: 포커스 복귀 후에도 change가 없으면 빈 배열
      const onFocus = () => setTimeout(() => { window.removeEventListener('focus', onFocus); if (!_picker.files.length) resolve([]); }, 600);
      window.addEventListener('focus', onFocus);
      _picker.click();
    });
  }

  // ── 저장: Capacitor Filesystem → Documents + 공유 시트 / 브라우저 폴백 ─────
  function bytesToBase64(bytes) {
    const u8 = new Uint8Array(bytes);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    return btoa(bin);
  }
  async function saveFileMobile(defaultName, buffer) {
    if (!Plugins.Filesystem) {
      // 데스크톱 브라우저 개발 모드 폴백
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([buffer], { type: 'application/pdf' }));
      a.download = defaultName;
      a.click();
      return defaultName;
    }
    const res = await Plugins.Filesystem.writeFile({
      path: defaultName,
      data: bytesToBase64(buffer),
      directory: 'DOCUMENTS',
      recursive: true,
    });
    // 공유 시트 — 카카오톡·프린터 앱·드라이브 등으로 바로 보낼 수 있게
    if (Plugins.Share) {
      try { await Plugins.Share.share({ title: defaultName, files: [res.uri] }); } catch (e) { /* 사용자가 공유 취소해도 저장은 완료 */ }
    }
    return res.uri;
  }

  // ── electronAPI 구현 ──────────────────────────────────────────────────────
  window.electronAPI = {
    openFile: () => pickFiles(),
    readFile: (p) => getFile(p).bytes,

    saveFile: async ({ defaultName, buffer }) => saveFileMobile(defaultName, buffer),

    convertHwpToPdf:    (p) => convertViaServer('hwp', p),
    convertOfficeToPdf: (p) => convertViaServer('office', p),
    convertAdobeToPdf:  (p) => convertViaServer('adobe', p),

    inkCoverage: async (p) => {
      const f = getFile(p);
      const r = await serverFetch('/ink/coverage', { method: 'POST', body: f.bytes }, '프린터 잉크 판정');
      return (await r.json()).pages;
    },

    printToPDF: async (html) => {
      const r = await serverFetch('/print/topdf', { method: 'POST', body: html }, '견적서 PDF 변환');
      return await r.arrayBuffer();
    },

    // 가상 임시파일 — 잉크판정·편집기 경로가 쓰는 writeTempFile/removeTempFile
    writeTempFile: (bytes, ext) => putFile('tmp', `t.${ext === 'bin' ? 'bin' : 'pdf'}`, bytes.slice ? bytes.slice(0) : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    removeTempFile:  (p) => _files.delete(p),
    cleanupTempFile: (p) => _files.delete(p),

    // 드래그&드롭 File → 가상 경로 등록 (데스크톱은 실경로 반환, 모바일은 즉석 등록)
    getPathForFile: (file) => {
      // File 객체를 동기 API에서 받으므로 비동기로 읽어둘 수 없다 → 별도 등록 큐 사용
      // app-core의 드롭 핸들러가 path 없이도 File.arrayBuffer()로 처리 가능하면 그 경로를 탄다.
      return '';
    },

    getWorkerContent: () => window.__MOB_WORKER_TEXT || '',
    listFonts: () => Promise.resolve([]),          // 폰트 임베드는 PC 전용 (모바일은 기본 폰트)
    setUnsaved: () => {},
    onExternalOpen: () => {},

    // 내부 콘텐츠 편집기(별도 창)는 PC 전용 — 모바일 3단계 과제
    openEditor: () => { throw new Error('내부 콘텐츠 편집기는 PC 버전 전용입니다. (크기·회전·임포징·흑백변환은 폰에서 그대로 사용 가능)'); },
    onEditorResult: () => {},
  };

  // ── 좌측 사이드바 'PC 서버 연결' 카드 (모바일 전용 UI) ─────────────────────
  function renderServerCard() {
    const box = document.getElementById('mobServerCard');
    if (!box) return;
    const cfg = serverCfg();
    const stat = document.getElementById('mobSrvStat');
    document.getElementById('mobSrvHost').value = cfg ? cfg.host : '';
    document.getElementById('mobSrvToken').value = cfg ? cfg.token : '';
    document.getElementById('mobSrvWolBtn').style.display = cfg && cfg.mac ? '' : 'none';
    if (stat && cfg) stat.textContent = cfg.mac ? `MAC ${cfg.mac} (WoL 가능)` : '';
  }
  window.__mobInitServerCard = function () {
    const panel = document.getElementById('sbPanelBody');
    if (!panel || document.getElementById('mobServerCard')) return;
    const div = document.createElement('div');
    div.className = 'sbp-section';
    div.id = 'mobServerCard';
    div.innerHTML = `
      <div class="sbp-title"><span class="ic">🖥</span> PC 서버 연결</div>
      <div style="display:flex; flex-direction:column; gap:6px;">
        <input id="mobSrvHost" placeholder="PC주소:포트 (예 192.168.0.5:8734)" style="background:#1d1d1f; color:#f5f5f7; border:1px solid #48484a; border-radius:6px; padding:8px; font-size:12.5px;">
        <input id="mobSrvToken" placeholder="토큰 (PC QR 아래 8자)" style="background:#1d1d1f; color:#f5f5f7; border:1px solid #48484a; border-radius:6px; padding:8px; font-size:12.5px;">
        <div style="display:flex; gap:6px;">
          <button class="sbp-btn" style="flex:1;" onclick="__mobTestServer()">연결 확인</button>
          <button class="sbp-btn" id="mobSrvWolBtn" style="flex:1; display:none;" onclick="__mobWake()">⚡ PC 깨우기</button>
        </div>
        <div id="mobSrvStat" style="font-size:11.5px; color:#98989d;"></div>
        <div style="font-size:11px; color:#636366; line-height:1.5;">PC 앱의 <b>📱 모바일 연동</b> QR을 폰 카메라로 스캔 → '앱에 이 PC 등록'을 누르면 자동 입력됩니다. HWP·Office·Adobe 변환과 프린터 잉크판정에 필요 (그 외 기능은 폰 단독).</div>
      </div>`;
    panel.appendChild(div);
    renderServerCard();
  };
  window.__mobTestServer = async function () {
    const host = document.getElementById('mobSrvHost').value.trim();
    const token = document.getElementById('mobSrvToken').value.trim().toUpperCase();
    const stat = document.getElementById('mobSrvStat');
    const prev = serverCfg();
    if (!host) { stat.textContent = '✖ PC 주소를 입력하세요.'; return; }
    saveServerCfg({ host, token, mac: prev && prev.host === host ? prev.mac : '' });
    stat.textContent = '⏳ 연결 확인 중…';
    try {
      const r = await fetch(`http://${host}/ping`, { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      const r2 = await fetch(`http://${host}/info?t=${encodeURIComponent(token)}`);
      if (r2.status === 401) { stat.textContent = `⚠ PC(${j.host}) 연결됨 — 토큰이 틀립니다.`; return; }
      const info = await r2.json();
      const mac = info.lan && info.lan.length ? info.lan[0].mac : '';
      saveServerCfg({ host, token, mac });
      stat.textContent = `✔ 연결됨 — ${j.host} (v${j.version})${mac ? ' · WoL 준비됨' : ''}`;
    } catch (e) {
      stat.textContent = '✖ 연결 실패 — PC가 켜져 있고 같은 WiFi인지 확인하세요.';
    }
  };
  // Wake-on-LAN — 네이티브 플러그인(WolPlugin)이 UDP 매직 패킷을 브로드캐스트
  window.__mobWake = async function () {
    const cfg = serverCfg();
    const stat = document.getElementById('mobSrvStat');
    if (!cfg || !cfg.mac) { stat.textContent = '✖ MAC 정보가 없습니다 — 먼저 PC가 켜진 상태에서 [연결 확인]을 한 번 실행하세요.'; return; }
    if (!Plugins.WolPlugin) { stat.textContent = '✖ 이 빌드에는 WoL 플러그인이 없습니다.'; return; }
    try {
      await Plugins.WolPlugin.wake({ mac: cfg.mac });
      stat.textContent = `⚡ 매직 패킷 전송됨 (${cfg.mac}) — PC가 깨어나는 데 수십 초 걸릴 수 있습니다.`;
    } catch (e) {
      stat.textContent = '✖ 전송 실패: ' + (e && e.message ? e.message : e);
    }
  };

  // ── 딥링크 수신: pdfeditor://connect?t=..&mac=..&host=.. (테스트 페이지 버튼) ──
  if (Plugins.App && Plugins.App.addListener) {
    Plugins.App.addListener('appUrlOpen', (ev) => {
      try {
        const u = new URL(ev.url);
        if (u.hostname !== 'connect' && u.pathname.indexOf('connect') < 0) return;
        const host = u.searchParams.get('host'), t = u.searchParams.get('t') || '', mac = decodeURIComponent(u.searchParams.get('mac') || '');
        if (host) { saveServerCfg({ host, token: t, mac }); }
      } catch (e) {}
    });
  }
})();
