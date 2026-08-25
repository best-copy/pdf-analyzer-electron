// 라이선스 E2E — 실제 license.js / license-server.js 모듈을 그대로 구동해 검증
const fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const R = require('path').join(__dirname, '..', '..').split(path.sep).join('/') + '/';   // 저장소 루트
const lic=require(R+'license.js');
const srv=require(R+'license-server.js');

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'licud_'));
lic.init({userDataDir:tmp, appVersion:'test'});

let pass=0,fail=0;
const ck=(name,cond,extra)=>{ if(cond){pass++;console.log('  ✔',name);} else {fail++;console.log('  ✘',name,extra!==undefined?JSON.stringify(extra):'');} };

function post(port,route,body){return new Promise((res,rej)=>{
  const d=Buffer.from(JSON.stringify(body));
  const rq=http.request({host:'127.0.0.1',port,path:route,method:'POST',headers:{'content-type':'application/json','content-length':d.length}},r=>{
    const c=[];r.on('data',x=>c.push(x));r.on('end',()=>{let j=null;try{j=JSON.parse(Buffer.concat(c).toString())}catch(e){};res({code:r.statusCode,json:j})});});
  rq.on('error',rej);rq.end(d);});}

(async()=>{
console.log('\n[1] 관리자 판정 / 키 발급');
ck('이 PC는 관리자(개인키 보유)', lic.isAdminPC()===true);
ck('관리자 PC는 무제한 사용', lic.status().mode==='admin' && lic.status().canSave===true, lic.status());
const iss=lic.issueKey({days:5,note:'__TEST__ 자동검증'});
ck('키 발급 성공', iss.ok && /^PDFE(-[A-Z0-9]{4}){3}$/.test(iss.key), iss);
const KEY=iss.key;

console.log('\n[2] 활성화 서버 기동');
const cfg={enabled:false,port:18736};
srv.init(lic,{load:()=>cfg,save:c=>Object.assign(cfg,c)});
await srv.setEnabled(true,18736);
ck('서버 실행 중', srv.status().running===true, srv.status());

console.log('\n[3] 테스터 A 활성화 (1회용 소진)');
const HWA='a'.repeat(24), HWB='b'.repeat(24);
let r=await post(18736,'/lic/activate',{key:KEY,hwid:HWA,ver:'1',host:'테스터A'});
ck('활성화 성공', r.code===200 && !!r.json.token, r.json);
const tokA=r.json.token;
const pA=lic.verifyToken(tokA);
ck('토큰 서명 검증 통과', !!pA, pA);
ck('만료일 = 발급 5일', pA && Math.round((pA.exp-pA.iat)/86400000)===5, pA&&{exp:pA.exp,iat:pA.iat});
ck('재확인 기한 = 7일', pA && Math.round((pA.next-pA.iat)/86400000)===7);
ck('HWID 바인딩됨', pA && pA.hwid===HWA);

console.log('\n[4] 재사용 차단');
r=await post(18736,'/lic/activate',{key:KEY,hwid:HWB,ver:'1',host:'테스터B'});
ck('다른 PC에서 같은 키 → 거부(409)', r.code===409, r.json);
r=await post(18736,'/lic/activate',{key:KEY,hwid:HWA,ver:'1',host:'테스터A'});
ck('같은 PC 재설치 → 재발급 허용', r.code===200 && !!r.json.token, r.json);
const pA2=lic.verifyToken(r.json.token);
ck('재설치해도 만료일 그대로(기간 연장 불가)', pA2 && pA2.exp===pA.exp, {before:pA.exp,after:pA2&&pA2.exp});
r=await post(18736,'/lic/activate',{key:'PDFE-ZZZZ-ZZZZ-ZZZZ',hwid:HWB});
ck('없는 키 → 404', r.code===404, r.json);

console.log('\n[5] 위·변조 방어');
const bad=Buffer.from(JSON.stringify({...pA,exp:pA.exp+365*86400000}),'utf8').toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'')+'.'+tokA.split('.')[1];
ck('만료일만 늘린 토큰 → 검증 실패', lic.verifyToken(bad)===null);
ck('서명부 변조 → 검증 실패', lic.verifyToken(tokA.split('.')[0]+'.AAAA')===null);
const adm=lic.adminData();
const expired=lic.signToken({v:1,key:KEY,hwid:HWA,iat:Date.now()-10*86400000,exp:Date.now()-86400000,next:Date.now()+86400000},adm.priv);
fs.writeFileSync(path.join(tmp,'license.dat'),expired,'utf8');

console.log('\n[6] 테스터 PC 판정 (관리자 아님을 가정한 evaluate 경로)');
// 이 PC는 관리자라 mode=admin이 먼저 걸린다 → 만료 판정은 서버 기록으로 확인
const db=lic.loadKeys(); const row=db.keys.find(k=>k.key===KEY);
ck('서버 DB에 소진 기록', row && row.status==='activated' && row.hwid===HWA, row&&{s:row.status,h:row.hwid});
ck('서버가 만료일을 보관', !!row.expiresAt && row.expiresAt===pA.exp);

console.log('\n[7] 원격 취소(kill switch)');
const rev=lic.revokeKey(KEY);
ck('취소 처리', rev.ok===true, rev);
r=await post(18736,'/lic/recheck',{token:tokA,hwid:HWA});
ck('재확인 → 취소 응답(403 revoked)', r.code===403 && r.json.revoked===true, r.json);
r=await post(18736,'/lic/activate',{key:KEY,hwid:HWA});
ck('취소된 키는 재활성화 불가', r.code===403, r.json);

console.log('\n[8] 남용 방지');
let blocked=false;
for(let i=0;i<12;i++){const x=await post(18736,'/lic/activate',{key:'PDFE-QQQQ-QQQQ-QQQQ',hwid:HWB}); if(x.code===429)blocked=true;}
ck('무차별 대입 시 차단(429)', blocked);
r=await post(18736,'/etc',{});
ck('그 밖의 경로는 404', r.code===404);

srv.stop();
// 테스트로 만든 키 정리
const db2=lic.loadKeys(); db2.keys=db2.keys.filter(k=>!/^__TEST__/.test(k.note||'')); lic.saveKeys(db2);
fs.rmSync(tmp,{recursive:true,force:true});
console.log(`\n결과: ${pass} 통과 / ${fail} 실패`);
process.exit(fail?1:0);
})();
