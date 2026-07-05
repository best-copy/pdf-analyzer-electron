const { contextBridge, ipcRenderer, webUtils } = require('electron');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

contextBridge.exposeInMainWorld('electronAPI', {
  // 파일 열기 다이얼로그 — 경로만 반환 (파일 내용은 readFile로 별도 요청)
  openFile: () => ipcRenderer.invoke('dialog:openFile'),

  // 파일을 직접 읽어 ArrayBuffer 반환 (Node.js fs → asar/실제파일 모두 처리)
  readFile: (filePath) => {
    const buf = fs.readFileSync(filePath);
    // Buffer → ArrayBuffer (structured clone으로 고속 전달)
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  },

  // PDF 저장: 경로는 main에서 다이얼로그로 취득, 파일 쓰기는 여기서 직접 처리
  // (IPC로 대용량 버퍼 전달 시 직렬화 과정에서 손상되므로 fs로 직접 기록)
  saveFile: async ({ defaultName, buffer }) => {
    const filePath = await ipcRenderer.invoke('dialog:saveFilePath', { defaultName });
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

  // '저장 안 한 작업' 상태를 main에 보고 (종료 전 확인용)
  setUnsaved: (dirty) => ipcRenderer.send('app:dirty', !!dirty),

  // 사용 끝난 변환 임시 PDF 삭제 요청
  cleanupTempFile: (filePath) => ipcRenderer.invoke('temp:cleanup', filePath),

  // 설치된 시스템 폰트 목록 (머리글/바닥글 글꼴 선택용)
  listFonts: () => ipcRenderer.invoke('fonts:list'),

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
      if (!/^pdfedit_.*\.(pdf|bin)$/i.test(base)) return false;
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
});
