const { contextBridge, ipcRenderer, webUtils } = require('electron');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

contextBridge.exposeInMainWorld('electronAPI', {
  // 파일 열기 다이얼로그 — 경로만 반환 (파일 내용은 readFile로 별도 요청)
  openFile: (opts) => ipcRenderer.invoke('dialog:openFile', opts || {}),
  openCoverFile: () => ipcRenderer.invoke('dialog:openCoverFile'),
  genCoverImage: (opts) => ipcRenderer.invoke('ai:genCoverImage', opts),
  // 📂 표지 핫폴더 — 감시는 메인, 표지 생성은 렌더러
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  hotfolderStart: (dir) => ipcRenderer.invoke('hotfolder:start', dir),
  hotfolderStop: () => ipcRenderer.invoke('hotfolder:stop'),
  hotfolderFinish: (r) => ipcRenderer.invoke('hotfolder:finish', r),
  onHotfolderJob: (cb) => ipcRenderer.on('hotfolder:job', (_, job) => cb(job)),

  // 외부(실행 인자·목차 검증기 연동)에서 넘어온 문서 열기 알림
  // cb([{path, name}]) — main이 검증한 실제 존재 문서만 온다
  onExternalOpen: (cb) => ipcRenderer.on('external:open', (_e, items) => cb(items)),

  // 파일을 직접 읽어 ArrayBuffer 반환 (Node.js fs → asar/실제파일 모두 처리)
  readFile: (filePath) => {
    const buf = fs.readFileSync(filePath);
    // Buffer → ArrayBuffer (structured clone으로 고속 전달)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },

  // PDF 저장: 경로는 main에서 다이얼로그로 취득, 파일 쓰기는 여기서 직접 처리
  // (IPC로 대용량 버퍼 전달 시 직렬화 과정에서 손상되므로 fs로 직접 기록)
  saveFile: async ({ defaultName, buffer, kind }) => {
    const filePath = await ipcRenderer.invoke('dialog:saveFilePath', { defaultName, kind });
    if (!filePath) return false;
    fs.writeFileSync(filePath, Buffer.from(buffer));
    return filePath;
  },

  // HWP/HWPX → PDF 변환 (main의 한글 COM 자동화) — 변환된 임시 PDF 경로 반환
  convertHwpToPdf: (filePath) => ipcRenderer.invoke('hwp:convertToPdf', filePath),

  // MS Office(Word·Excel·PowerPoint) → PDF 변환 (main의 Office COM 자동화) — 임시 PDF 경로 반환
  convertOfficeToPdf: (filePath) => ipcRenderer.invoke('office:convertToPdf', filePath),

  // Adobe(Photoshop·InDesign·Illustrator) → PDF 변환 (main의 Adobe COM 자동화) — 임시 PDF 경로 반환
  convertAdobeToPdf: (filePath) => ipcRenderer.invoke('adobe:convertToPdf', filePath),

  // 드래그&드롭된 File 객체의 실제 디스크 경로 취득 (HWP 변환 입력용)
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); }
    catch (e) { return (file && file.path) || ''; }
  },

  // 견적서 HTML → PDF 변환 (main 프로세스의 printToPDF 사용)
  printToPDF: (html) => ipcRenderer.invoke('print:toPDF', html),

  // 닫기 전 '작업 저장하고 닫기' 요청 수신 / 결과 회신
  onSaveWorkAndQuit: (cb) => ipcRenderer.on('app:saveWorkAndQuit', () => cb()),
  sendSaveWorkResult: (ok) => ipcRenderer.send('app:saveWorkResult', !!ok),

  // 방금 연 문서가 있던 폴더 — 저장 다이얼로그 기본 위치로 쓰인다
  setSaveDir: (dir) => ipcRenderer.send('app:docDir', dir),

  // '저장 안 한 작업' 상태를 main에 보고 (종료 전 확인용)
  setUnsaved: (dirty) => ipcRenderer.send('app:dirty', !!dirty),

  // 앱 강제 새로고침 (캐시 무시) — 화면·상태가 꼬였을 때 재시작 없이 복구
  forceReload: () => ipcRenderer.invoke('app:forceReload'),
  // Ctrl+R·Ctrl+Shift+R를 main이 가로채 전달 — 확인 후 렌더러가 새로고침을 결정
  onReloadRequest: (cb) => ipcRenderer.on('app:reload-request', () => cb()),

  // 사용 끝난 변환 임시 PDF 삭제 요청
  cleanupTempFile: (filePath) => ipcRenderer.invoke('temp:cleanup', filePath),

  // 설치된 시스템 폰트 목록 (머리글/바닥글 글꼴 선택용)
  listFonts: () => ipcRenderer.invoke('fonts:list'),

  // Ghostscript inkcov — 페이지별 CMYK 잉크 커버리지 (프린터 기준 컬러 판정)
  inkCoverage: (pdfPath) => ipcRenderer.invoke('ink:coverage', pdfPath),

  // 폰트 아웃라인화 (gs pdfwrite -dNoOutputFonts) — 변환된 임시 PDF 경로 반환
  // opts.flatten = 투명도 평탄화(PDF 1.4, 구형 RIP 대응)
  outlineFonts: (pdfPath, opts) => ipcRenderer.invoke('gs:outlineFonts', pdfPath, opts || {}),

  // 💼 작업 파일(.pdfw) 더블클릭 연결 — HKCU만 사용(관리자 권한 불필요)

  // 가상 프린터 'PDF Editor' 설치 (UAC 승격) — 어떤 앱에서든 인쇄로 문서 전달
  setupPrinter: () => ipcRenderer.invoke('printer:setup'),
  printerStatus: () => ipcRenderer.invoke('printer:status'),

  // ── 모바일 연동 LAN 변환 서버 (remote-server.js) ──────────────────────────
  remoteStatus:     ()   => ipcRenderer.invoke('remote:status'),
  remoteSetEnabled: (on) => ipcRenderer.invoke('remote:setEnabled', !!on),

  // PDF.js 워커 콘텐츠 — asar 안에서도 fs로 안전하게 읽어 blob URL 생성용으로 반환
  getWorkerContent: () => fs.readFileSync(
    path.join(__dirname, 'src', 'libs', 'pdf.worker.min.js'), 'utf8'
  ),

  // ── 페이지 내부편집기 창 연동 ──────────────────────────────────────────────
  // 큰 PDF 바이트는 IPC로 넘기지 않고 임시파일(디스크)로 주고받는다(50MB+ 직렬화 손상 방지).
  // 임시 파일 쓰기 — tmpdir에 pdfedit_ 접두사로 저장, 경로 반환. (bytes=ArrayBuffer/TypedArray)
  writeTempFile: (bytes, ext) => {
    const name = `pdfedit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext === 'bin' ? 'bin' : 'pdf'}`;
    const p = path.join(os.tmpdir(), name);
    fs.writeFileSync(p, Buffer.from(bytes));
    return p;
  },
  // 편집 임시파일 삭제 (tmpdir 내 pdfedit_ 파일만)
  removeTempFile: (p) => {
    try {
      if (!p) return false;
      const base = path.basename(p);
      if (!/^pdfedit_.*\.(pdf|bin|png)$/i.test(base)) return false;   // png: AI 뒤표지 생성 결과
      if (path.dirname(p) !== os.tmpdir()) return false;
      fs.unlinkSync(p);
      return true;
    } catch (e) { return false; }
  },
  // 편집기 열기 (opener 렌더러 → main) — payload는 작은 JSON+경로만
  openEditor: (payload) => ipcRenderer.invoke('editor:open', payload),
  // 편집기 저장 결과 수신 (메인 창)
  onEditorResult: (cb) => ipcRenderer.on('editor:result', (_, data) => cb(data)),
  // 편집기 창이 자신의 페이로드를 당겨옴 (편집기 창)
  pullEditorPayload: () => ipcRenderer.invoke('editor:pull'),
  // 편집기 → 저장 결과를 main으로 (편집기 창)
  sendEditorResult: (data) => ipcRenderer.send('editor:save', data),
  // 편집기 → 취소로 닫기 (편집기 창)
  closeEditorWindow: () => ipcRenderer.send('editor:close'),

  // ── 라이선스(체험판) 상태 — 화면 배지·안내 전용. 실제 차단은 메인 프로세스가 한다.
  // 여기서 true를 돌려주도록 화면 코드를 고쳐도 저장 길목(main)에서 막히므로 의미가 없다.
  licenseStatus: () => ipcRenderer.invoke('lic:status'),
  openLicenseWindow: () => ipcRenderer.invoke('lic:open'),
  onLicenseStatus: (cb) => ipcRenderer.on('license:status', (_, st) => cb(st)),
});
