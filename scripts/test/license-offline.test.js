// 오프라인 활성화 E2E — 실제 license.js 모듈을 그대로 구동해 검증
// (서버·포트포워딩 없이 '요청 코드 → 활성화 코드' 왕복이 1회용을 그대로 지키는가)
const {execFileSync}=require('child_process');
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const R = path.join(__dirname,'..','..').split(path.sep).join('/')+'/';
const lic=require(R+'license.js');

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'licoff_'));
lic.init({userDataDir:tmp, appVersion:'test'});
const D=86400000;
let pass=0,fail=0;
const ck=(n,c,x)=>{ if(c){pass++;console.log('  ✔',n);} else {fail++;console.log('  ✘',n,x!==undefined?JSON.stringify(x):'');} };

// 테스터 PC를 흉내내려면 남의 hwid로 요청 코드를 만들어야 한다 — 전송 형식을 그대로 재현
const b64u=b=>Buffer.from(b).toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function mkReq(key,hw,host){
  const raw=b64u(Buffer.from(JSON.stringify({k:key,h:hw,n:host||'테스터PC',v:'test'}),'utf8'));
  return 'PDFEQ1.'+raw+'.'+crypto.createHash('sha256').update(raw).digest('hex').slice(0,4).toUpperCase();
}
const HWA='a'.repeat(24), HWB='b'.repeat(24);

console.log('\n[1] 요청 코드 생성');
ck('잘못된 키 형식 → 거부', lic.offlineRequest('ABCD').ok===false);
const iss=lic.issueKey({days:3,note:'__TEST__ 오프라인'});
ck('키 발급', iss.ok, iss);
const KEY=iss.key;
const myReq=lic.offlineRequest(KEY);
ck('요청 코드 형식', myReq.ok && /^PDFEQ1\.[\w-]+\.[0-9A-F]{4}$/.test(myReq.code), myReq);
ck('요청 코드에 이 PC 지문 포함', myReq.hwid===lic.hwid());

console.log('\n[2] 관리자: 요청 코드 → 활성화 코드');
const r1=lic.offlineIssue(mkReq(KEY,HWA));
ck('발급 성공', r1.ok===true, r1);
const p1=lic.verifyToken(r1.token);
ck('토큰 서명 검증 통과', !!p1, p1);
ck('만료일 = 발급 3일', p1 && Math.round((p1.exp-p1.iat)/D)===3, p1&&{iat:p1.iat,exp:p1.exp});
ck('오프라인 표식(off:1)', p1 && p1.off===1);
ck('재확인 기한 없음(next 미포함)', p1 && p1.next===undefined, p1&&{next:p1.next});
ck('요청한 PC에 바인딩', p1 && p1.hwid===HWA);
ck('keys.json에 소진 기록', (()=>{const row=lic.loadKeys().keys.find(k=>k.key===KEY); return row&&row.status==='activated'&&row.hwid===HWA&&row.offline===true;})());

console.log('\n[3] 1회용 유지 (서버 없이도)');
const r2=lic.offlineIssue(mkReq(KEY,HWB));
ck('다른 PC의 요청 → 거부', r2.ok===false && /이미 다른 PC/.test(r2.error||''), r2);
const r3=lic.offlineIssue(mkReq(KEY,HWA));
ck('같은 PC 재요청 → 재발급 허용', r3.ok===true, r3);
ck('재발급해도 만료일 그대로', r3.ok && lic.verifyToken(r3.token).exp===p1.exp);

console.log('\n[4] 온라인 ↔ 오프라인 교차');
const iss2=lic.issueKey({days:5,note:'__TEST__ 교차'});
const on=lic.activateRecord({key:iss2.key,hwid:HWA,host:'온라인',ver:'t'});
ck('온라인 경로 활성화', on.code===200 && lic.verifyToken(on.token).next>0, {code:on.code});
const cross=lic.offlineIssue(mkReq(iss2.key,HWB));
ck('온라인으로 쓴 키 → 오프라인 재사용 거부', cross.ok===false && /이미 다른 PC/.test(cross.error||''), cross);

console.log('\n[5] 잘못된 입력 방어');
const good=mkReq(KEY,HWA);
ck('잘려서 붙여넣은 코드 → 거부', lic.offlineIssue(good.slice(0,good.length-12)).ok===false);
ck('엉뚱한 문자열 → 거부', lic.offlineIssue('안녕하세요').ok===false);
const revoked=lic.issueKey({days:3,note:'__TEST__ 취소'});
lic.revokeKey(revoked.key);
ck('취소된 키 → 거부', (()=>{const x=lic.offlineIssue(mkReq(revoked.key,HWA)); return x.ok===false&&/취소/.test(x.error||'');})());
const nokey=lic.offlineIssue(mkReq('PDFE-ZZZZ-ZZZZ-ZZZZ',HWA));
ck('없는 키 → 거부', nokey.ok===false && /등록되지 않은/.test(nokey.error||''), nokey);

console.log('\n[6] 테스터 PC 등록 (관리자 아님으로 위장한 자식 프로세스)');
const adm=lic.adminData(), now=Date.now();
const mk=(o)=>lic.signToken(Object.assign({v:1,key:'PDFE-TEST-TEST-TEST',hwid:lic.hwid(),iat:now,exp:now+5*D,off:1},o),adm.priv);
const fakeHome=fs.mkdtempSync(path.join(os.tmpdir(),'lichome_'));
function child(tokenExpr){
  const ud=fs.mkdtempSync(path.join(os.tmpdir(),'licud_'));
  const out=execFileSync(process.execPath,['-e',`
    const lic=require(${JSON.stringify(R+'license.js')});
    lic.init({userDataDir:${JSON.stringify(ud)},appVersion:'t'});
    const r=lic.offlineActivate(${tokenExpr});
    const s=lic.status();
    console.log(JSON.stringify({ok:!!r.ok,error:r.error||'',mode:s.mode,canSave:s.canSave,offline:!!s.offline,label:s.label}));
  `],{env:Object.assign({},process.env,{USERPROFILE:fakeHome,HOME:fakeHome}),encoding:'utf8'});
  fs.rmSync(ud,{recursive:true,force:true});
  return JSON.parse(out.trim().split('\n').pop());
}
let c=child(JSON.stringify(mk({})));
ck('활성화 코드 등록 → licensed/허용', c.ok && c.mode==='licensed' && c.canSave===true, c);
ck('오프라인 표시가 상태에 뜸', c.offline===true && /오프라인/.test(c.label||''), c);
c=child(JSON.stringify(mk({hwid:'f'.repeat(24)})));
ck('다른 PC용 코드 → 거부', c.ok===false && /다른 PC/.test(c.error||''), c);
c=child(JSON.stringify(mk({exp:now-D})));
ck('만료된 코드 → 거부', c.ok===false, c);
c=child(JSON.stringify(mk({}).split('.')[0]+'.AAAA'));
ck('서명 위조 코드 → 거부', c.ok===false, c);
// 오프라인 토큰은 아무리 오래돼도 '서버 재확인 필요'로 잠기지 않아야 한다(next가 없으므로)
c=child(JSON.stringify(mk({iat:now-60*D,exp:now+5*D})));
ck('60일 전 발급이어도 재확인 잠금 없음', c.ok && c.mode==='licensed', c);

// 정리
const db=lic.loadKeys(); db.keys=db.keys.filter(k=>!/^__TEST__/.test(k.note||'')); lic.saveKeys(db);
fs.rmSync(tmp,{recursive:true,force:true});
fs.rmSync(fakeHome,{recursive:true,force:true});
try{execFileSync('reg',['delete','HKCU\Software\PDFEditor\Lic','/f'],{stdio:'ignore'});}catch(e){}
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail?1:0);
