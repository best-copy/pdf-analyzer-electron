// 라이선스 창(활성화·관리자 발급) 전용 preload — 메인 앱 preload와 분리해서
// 이 창에는 파일 시스템 API를 일절 노출하지 않는다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lic', {
  status:      () => ipcRenderer.invoke('lic:status'),
  activate:    (key, server) => ipcRenderer.invoke('lic:activate', { key, server }),
  recheck:     () => ipcRenderer.invoke('lic:recheck'),
  savedServer: () => ipcRenderer.invoke('lic:savedServer'),
  hwid:        () => ipcRenderer.invoke('lic:hwid'),
  close:       () => ipcRenderer.send('lic:close'),
  // ── 관리자 (개인키가 있는 PC에서만 실제로 동작) ──
  issue:        (days, note) => ipcRenderer.invoke('lic:admin:issue', { days, note }),
  list:         () => ipcRenderer.invoke('lic:admin:list'),
  revoke:       (key) => ipcRenderer.invoke('lic:admin:revoke', { key }),
  serverStatus: () => ipcRenderer.invoke('lic:admin:serverStatus'),
  setServer:    (enabled, port) => ipcRenderer.invoke('lic:admin:setServer', { enabled, port }),
  lanIps:       () => ipcRenderer.invoke('lic:admin:lanIps'),
});
