const { contextBridge, ipcRenderer } = require('electron');
const fs   = require('fs');
const path = require('path');

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

  // 견적서 HTML → PDF 변환 (main 프로세스의 printToPDF 사용)
  printToPDF: (html) => ipcRenderer.invoke('print:toPDF', html),

  // PDF.js 워커 콘텐츠 — asar 안에서도 fs로 안전하게 읽어 blob URL 생성용으로 반환
  getWorkerContent: () => fs.readFileSync(
    path.join(__dirname, 'src', 'libs', 'pdf.worker.min.js'), 'utf8'
  ),
});
