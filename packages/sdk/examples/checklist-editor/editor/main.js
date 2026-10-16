(()=>{var D="openchamber.sdk",W=1;var lS=`
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [data-oc-scrolling] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [data-oc-scrolling] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [data-oc-scrolling]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [data-oc-scrolling] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;function aS(S){let _=S.documentElement;if(_.hasAttribute("data-oc-scrollbar-activity"))return;_.setAttribute("data-oc-scrollbar-activity","");let M=new WeakMap;S.addEventListener("scroll",(A)=>{let O=A.target===S?_:A.target;if(!(O instanceof Element))return;if(!O.hasAttribute("data-oc-scrolling"))O.setAttribute("data-oc-scrolling","");let F=M.get(O);if(F!==void 0)clearTimeout(F);M.set(O,setTimeout(()=>{M.delete(O),O.removeAttribute("data-oc-scrolling")},1000))},{capture:!0,passive:!0})}var kT=`(${aS.toString()})(document);`;var oS=128,nS=65536;var QS=128;var ZS=65536;var pG=/^[a-z][a-z0-9-]{0,39}$/;var dG=(S)=>Object(S)===S&&!Array.isArray(S),iS=(S,_)=>Object.keys(S).every((M)=>_.includes(M)),uG=(S)=>String(S)===S&&S.length>=1&&S.length<=60,vG=(S)=>String(S)===S&&S.length>=1&&S.length<=80,lG=(S)=>{if(!Array.isArray(S)||S.length>4)return!1;let _=new Set;for(let M of S){if(!dG(M)||!pG.test(M.id)||!uG(M.label))return!1;if(M.disabled!==void 0&&M.disabled!==!0&&M.disabled!==!1)return!1;if(_.has(M.id))return!1;if(_.add(M.id),M.kind==="button"){if(!iS(M,["kind","id","label","disabled"]))return!1;continue}if(M.kind!=="select"||!iS(M,["kind","id","label","value","options","disabled"]))return!1;if(!vG(M.value)||!Array.isArray(M.options)||M.options.length<1||M.options.length>16)return!1;let A=new Set;for(let O of M.options){if(!dG(O)||!iS(O,["value","label"])||!vG(O.value)||!uG(O.label)||A.has(O.value))return!1;A.add(O.value)}if(!A.has(M.value))return!1}return!0};var zS=20000000,VS=256;var rS=(S)=>("bytes"in S)?S.bytes.byteLength:S.content.length,aG=(S,_)=>{if(S.path!==_.path||S.readOnly!==_.readOnly)return!1;if(S.encoding==="text"||_.encoding==="text")return S.encoding==="text"&&_.encoding==="text"&&S.content===_.content;if(S.bytes.byteLength!==_.bytes.byteLength)return!1;for(let M=0;M<S.bytes.byteLength;M+=1)if(S.bytes[M]!==_.bytes[M])return!1;return!0},JS=(S)=>{let _=S,M=S;return{observe:(A)=>{let O=A!==M;return M=A,{edited:O,dirty:A!==_}},markSaved:(A)=>{return _=A,M!==A}}};var oG=/^[A-Za-z0-9_-]{1,80}$/;var nG=["left","right","top","bottom"];var iG=(S,_=0,M={remaining:16000})=>{if(--M.remaining<0||_>=32)return!1;if(S===null)return!0;let A=Array.isArray(S)?S:Object(S)===S?Object.values(S):[];for(let O of A)if(!iG(O,_+1,M))return!1;return!0},sS=(S)=>{if(S===null||S===!0||S===!1)return!0;if(Array.isArray(S))return Object.keys(S).every((_)=>/^(0|[1-9]\d*)$/.test(_)&&Number(_)<S.length)&&S.every(sS);if(Object(S)===S){let _=Object.getPrototypeOf(S);return(_===null||_===Object.prototype)&&Object.values(S).every(sS)}return String(S)===S||Number.isFinite(S)},tS=(S)=>{try{if(String(S.id)!==S.id||!oG.test(S.id)||!Number.isFinite(S.anchor.x)||Math.abs(S.anchor.x)>1e5||!Number.isFinite(S.anchor.y)||Math.abs(S.anchor.y)>1e5||!Number.isFinite(S.anchor.width)||!Number.isFinite(S.anchor.height)||S.anchor.width<=0||S.anchor.height<=0||S.anchor.width>1e5||S.anchor.height>1e5||!Number.isInteger(S.width)||S.width<160||S.width>640||!Number.isInteger(S.height)||S.height<48||S.height>480||S.side!==void 0&&!nG.includes(S.side)||S.focus!==void 0&&S.focus!==!0&&S.focus!==!1||!iG(S.data)||!sS(S.data))return!1;return JSON.stringify(S.data).length<=16000}catch{return!1}};var sG=["file","directory","other","missing"],SG=(S)=>Boolean(S&&"sessionId"in S),GG=(S)=>Boolean(S&&"sent"in S&&!("sessionId"in S));var tG=/^[0-9a-f]{7,64}$/i,TG=(S)=>tG.test(S),jS=500,RS=32000,eG=16000,ST=128,GT=200,TT=2000,_T=16000,MT=80,UT=200,ET=16000;var AT=2000;var _G=20000,fS=1024,KS=2000000;var LS=64000,IS=8000,MG=4000;var UG=90000;var XT=999,OT=1e4,OS=500,PT=["HOST_UNAVAILABLE","HOST_TIMEOUT","HOST_REJECTED","DISCONNECTED","DISABLED","BAD_PATH","NO_INTEGRATION","NO_SERVICE","SERVICE_FAILED","REQUEST_FAILED","RESPONSE_TOO_LARGE","NO_SESSION","SESSION_BUSY","NOT_GRANTED","NO_DIRECTORY","NOT_FOUND","FILE_TOO_LARGE","DENIED","NO_MODEL","MODEL_FAILED","UNSUPPORTED"],CT=["stopped","starting","ready","failed"],wT=new Set(PT),BT=(S)=>wT.has(S),DT=(S)=>S&&BT(S)?S:"HOST_REJECTED",t=(S)=>{if(S===void 0)return!1;if(S===null||S===!0||S===!1)return!0;if(String(S)===S)return!0;if(Number(S)===S)return Number.isFinite(S);if(Array.isArray(S))return S.every(t);if(Object(S)===S)return Object.values(S).every(t);return!1},WT=(S)=>t(S)&&JSON.stringify(S).length<=ET,rG=(S)=>S?.trim().slice(0,UT)??"",e=(S)=>{let _=S.id.trim().slice(0,ST),M=S.title.trim().slice(0,GT),A=S.url.trim().slice(0,TT),O=S.text?.trim().slice(0,_T),F=S.author?.trim().slice(0,MT),Q=S.kind==="pull"?"pull":"issue",$={providerId:S.providerId.trim(),id:_,title:M||_,url:A,kind:Q};if(O)$.text=O;if(F)$.author=F;if(Q==="pull"){let I=rG(S.branches?.head),w=rG(S.branches?.base);if(I&&w)$.branches={head:I,base:w}}if(WT(S.data))$.data=S.data;return $},EG=(S)=>{let _=e(S);if(S.projectId)_.projectId=S.projectId;if(S.navigation)_.navigation=S.navigation;if(S.worktree)_.worktree=S.worktree;return _},AG=(S)=>{let _={text:S.text.trim().slice(0,eG)};if(S.send)_.send=!0;return _},XG=(S)=>{if(S===null||!Number.isFinite(S))return null;return Math.min(XT,Math.max(0,Math.round(S)))},OG=(S)=>{if(!Number.isFinite(S))return 0;return Math.min(OT,Math.max(0,Math.ceil(S)))};var SS=(S)=>S.length>0&&S.length<=fS&&!S.includes("\x00")&&!S.includes("\\");var HS=(S)=>{if(!S.startsWith("/")||S.includes("\x00")||S.includes("\\")||S.includes("://"))return!1;if(S.length>AT)return!1;return!S.split("/").some((M)=>M==="."||M==="..")},bT=new Set(CT),PG=(S)=>Boolean(S&&"status"in S&&bT.has(String(S.status))&&!("body"in S)),NS=(S)=>Boolean(S&&"status"in S&&"body"in S&&Number.isInteger(S.status)),CG=(S)=>Boolean(S&&"content"in S&&String(S.content)===S.content),BG=(S)=>Boolean(S&&"written"in S&&S.written===!0),DG=(S)=>Boolean(S&&"entries"in S&&Array.isArray(S.entries)),xT=new Set(sG),WG=(S)=>Boolean(S&&"kind"in S&&"size"in S&&xT.has(String(S.kind))&&Number.isFinite(S.size)),FG=(S)=>Boolean(S&&"text"in S&&String(S.text)===S.text&&!("status"in S)),qT=new Set(["workspace","shells","ready","directory","session","connection","settings","session-lifecycle","item","resolve","action","status-control-event","popover-closed","file-open","file-snapshot","file-saved"]),yT=(S)=>Object(S)===S?S:null,eS=(S)=>String(S)===S&&S.length>0,gT=(S)=>{if(!eS(S.id))return null;if(S.ok===!0){let _={channel:D,v:W,type:"result",id:S.id,ok:!0};if(Object(S.payload)===S.payload)_.payload=S.payload;return _}if(S.ok===!1&&eS(S.error))return{channel:D,v:W,type:"result",id:S.id,ok:!1,error:S.error,code:DT(eS(S.code)?S.code:void 0)};return null},$G=(S)=>{let _=yT(S);if(!_||_.channel!==D||_.v!==W)return null;if(_.type==="result")return gT(_);if(!qT.has(String(_.type))||Object(_.payload)!==_.payload)return null;return _};var FT=(S)=>("key"in S)&&("metaKey"in S)&&("ctrlKey"in S),hT=(S)=>(S.metaKey||S.ctrlKey)&&!S.altKey&&!S.shiftKey&&S.key.toLowerCase()==="s";class X extends Error{code;constructor(S,_){super(_);this.name="HostRequestError",this.code=S}}var $T=()=>Promise.reject(new X("BAD_PATH",'Request path must start with "/" and stay on the declared origin.')),kS=()=>Promise.reject(new X("BAD_PATH",`File path must be 1 to ${fS} characters without NUL or backslash.`)),wS=(S)=>{if(S===void 0)return;if(Object(S)!==S||Array.isArray(S)||S.scope!==void 0&&S.scope!=="instance"&&S.scope!=="device")throw new X("HOST_REJECTED",'Storage scope must be "instance" or "device".');return S.scope==="device"?"device":void 0},B=(S)=>{return S.value+=1,`oc-${S.value}`},YG=(S={})=>{let _=S.target??("window"in globalThis?window:null);if(!_)throw new X("HOST_UNAVAILABLE","No window. connectHost runs in a browser frame.");let M=S.acceptSource??((G)=>G===_.parent),A=S.requestTimeoutMs??_G,O=new Set,F=new Set,Q=new Set,$=new Set,I=new Set,w=new Set,TS=new Set,CS=new Set,BS=new Set,_S=null,MS=null,DS=new Set,WS=new Set,US=null,ES=null,dS=!1,i=new Map,r=new Map,s=new Map,h=!1,C={value:0},P=null,m=null,AS=!1,XS=!1,NG=null,kG=(G)=>{if(!G)return null;return{sessionId:G.id,phase:G.busy?"started":"completed"}},q=(G)=>{_.parent.postMessage(G,"*")},K=(G,T)=>{for(let U of G)try{U(T)}catch(E){console.error(E)}},wG=(G)=>{if(!(G instanceof MessageEvent))return;if(!M(G.source))return;let T=$G(G.data);if(!T)return;if(T.type==="workspace"){let E=r.get(T.payload.subscriptionId);if(E)K([E],T.payload.snapshot);return}if(T.type==="shells"){let E=s.get(T.payload.subscriptionId);if(E)K([E],T.payload.snapshot);return}if(T.type==="ready"){if(P=T.payload,m=kG(T.payload.session),K(O,T.payload),K(F,T.payload.directory),K(Q,T.payload.session),m)K($,m);K(I,T.payload.connection),K(w,T.payload.settings),K(TS,T.payload.item);return}if(T.type==="directory"){if(P)P={...P,directory:T.payload.directory};K(F,T.payload.directory);return}if(T.type==="session"){if(P)P={...P,session:T.payload.session};if(!T.payload.session)m=null;else if(m?.sessionId!==T.payload.session.id)m=kG(T.payload.session);K(Q,T.payload.session);return}if(T.type==="session-lifecycle"){m=T.payload,K($,T.payload);return}if(T.type==="connection"){if(P)P={...P,connection:T.payload.connection};K(I,T.payload.connection);return}if(T.type==="settings"){if(P)P={...P,settings:T.payload.settings};K(w,T.payload.settings);return}if(T.type==="item"){if(P)P={...P,item:T.payload.item};K(TS,T.payload.item);return}if(T.type==="status-control-event"){K(CS,T.payload);return}if(T.type==="popover-closed"){K(BS,T.payload);return}if(T.type==="action"){let E=(Y)=>{if(!h)q({channel:D,v:W,type:"action-result",id:T.id,payload:Y})},Z=MS;if(!Z){E({ok:!1,error:"This extension does not handle background actions."});return}Promise.resolve().then(()=>Z(T.payload)).then(()=>E({ok:!0}),(Y)=>{let R=(Y instanceof Error?Y.message:String(Y)).trim();E({ok:!1,error:(R||"Action failed.").slice(0,OS)})});return}if(T.type==="file-open"){let E=T.payload;if(ES&&aG(ES,E))return;ES=E,K(DS,T.payload);return}if(T.type==="file-saved"){K(WS,T.payload.version);return}if(T.type==="file-snapshot"){let E=(R)=>{if(!h)q({channel:D,v:W,type:"file-snapshot-result",id:T.id,payload:R})},Z=(R)=>E({error:(R.trim()||"Could not read the edited file.").slice(0,OS)}),Y=US;if(!Y){Z("This extension does not edit files.");return}Promise.resolve().then(()=>Y(T.payload.purpose)).then((R)=>{if(rS(R)>zS){Z(`The file is over ${zS} ${"bytes"in R?"bytes":"characters"}.`);return}if(R.version.length>VS){Z(`The snapshot version is over ${VS} characters.`);return}E({snapshot:"bytes"in R?{bytes:R.bytes,version:R.version}:{content:R.content,version:R.version}})},(R)=>Z(R instanceof Error?R.message:String(R)));return}if(T.type==="resolve"){let E=(Y)=>{q({channel:D,v:W,type:"resolve-result",id:T.id,payload:Y})},Z=_S;if(!Z){E({error:"This extension does not resolve commands."});return}Promise.resolve().then(()=>Z(T.payload)).then((Y)=>E({item:Y?e(Y):null}),(Y)=>{let R=(Y instanceof Error?Y.message:String(Y)).trim();E({error:(R||"Command failed.").slice(0,OS)})});return}let U=i.get(T.id);if(!U)return;if(clearTimeout(U.timer),i.delete(T.id),T.ok){U.resolve(T.payload);return}U.reject(new X(T.code,T.error))};_.addEventListener("message",wG),q({channel:D,v:W,type:"hello"});let k=(G,T=A)=>{if(h||_.parent===_)return Promise.reject(new X("HOST_UNAVAILABLE","No host frame. This page is not in an iframe."));return new Promise((U,E)=>{let Z=setTimeout(()=>{i.delete(G.id),E(new X("HOST_TIMEOUT","Host did not answer in time."))},T);i.set(G.id,{resolve:U,reject:E,timer:Z}),q(G)})},J=(G)=>k(G).then(()=>{return}),j={channel:D,v:W},uS=(G)=>{if(!h&&_.parent!==_)q(G)},bG=()=>uS({...j,type:"file-save"}),xG=(G)=>{if(!FT(G)||!hT(G))return;G.preventDefault(),bG()},qG=(G)=>{if(!FT(G)||G.key!=="Escape"||P?.surface!=="popover"||!P.popover)return;G.preventDefault(),mG(P.popover.id,"escape").catch(()=>{return})},FS=()=>{let G=P?.surface==="popover"?P.popover:void 0;if(!G)return;let T=AS||XS;if(NG===T)return;NG=T,cG(G.id,T).catch(()=>{return})},$S=()=>{if(P?.surface!=="popover"||AS)return;AS=!0,FS()},yG=(G)=>{if(P?.surface!=="popover"||G.relatedTarget!==null||!AS)return;AS=!1,FS()},gG=()=>{if(P?.surface!=="popover"||XS)return;XS=!0,FS()},hG=()=>{if(P?.surface!=="popover"||!XS)return;XS=!1,FS()},g=(G,T=1024)=>{if(!G.trim()||G.length>T)throw new X("HOST_REJECTED",`Identity must contain 1 to ${T} characters.`)},vS=async(G)=>{if(G.kind!=="projects")g(G.projectId);let T=await k({...j,type:"workspace-read",id:B(C),payload:G});if(!T||!("kind"in T)||!("state"in T)||T.kind!==G.kind)throw new X("HOST_REJECTED","Host did not return workspace data.");return T},pS=async(G,T)=>{if(G.kind!=="projects")g(G.projectId);let U=B(C);r.set(U,T);try{await J({...j,type:"workspace-subscribe",id:B(C),payload:{subscriptionId:U,query:G}})}catch(E){if(r.delete(U),!h)q({...j,type:"workspace-unsubscribe",id:B(C),payload:{subscriptionId:U}});throw E}return()=>{if(!r.delete(U)||h)return;q({...j,type:"workspace-unsubscribe",id:B(C),payload:{subscriptionId:U}})}},NT=async(G,T)=>{if(G.kind==="session")g(G.sessionId);if(G.kind==="project")g(G.projectId);let U=B(C);s.set(U,T);try{await J({...j,type:"shells-subscribe",id:B(C),payload:{subscriptionId:U,scope:G}})}catch(E){if(s.delete(U),!h)q({...j,type:"shells-unsubscribe",id:B(C),payload:{subscriptionId:U}});throw E}return()=>{if(!s.delete(U)||h)return;q({...j,type:"shells-unsubscribe",id:B(C),payload:{subscriptionId:U}})}},YS=async(G)=>{if("key"in G&&(G.key.length===0||G.key.length>oS))throw new X("HOST_REJECTED","Storage key must contain 1 to 128 characters.");if(G.op==="set"&&!t(G.value))throw new X("HOST_REJECTED","Storage values must be JSON.");if(G.op==="set"&&new TextEncoder().encode(JSON.stringify(G.value)).length>nS)throw new X("HOST_REJECTED","Storage value exceeds 64 KiB.");if(G.scope==="device"&&P?.features?.deviceStorage!==!0)throw new X("UNSUPPORTED","This host does not support device storage.");let T=await k({...j,type:"storage",id:B(C),payload:G});if(!T||!("storage"in T)||T.op!==G.op)throw new X("HOST_REJECTED","Host did not return storage data.");return T},mG=(G,T)=>P?.features?.popovers!==!0&&!(P?.surface==="popover"&&P.popover?.id===G)?Promise.reject(new X("UNSUPPORTED","This host does not support popovers.")):J({...j,type:"popover-close",id:B(C),payload:T?{id:G,reason:T}:{id:G}}),cG=(G,T)=>P?.features?.popovers!==!0&&!(P?.surface==="popover"&&P.popover?.id===G)?Promise.reject(new X("UNSUPPORTED","This host does not support popovers.")):J({...j,type:"popover-anchor",id:B(C),payload:{id:G,active:T}});return _.addEventListener("keydown",qG,!0),_.addEventListener("pointerover",$S),_.addEventListener("pointermove",$S),_.addEventListener("pointerout",yG),_.addEventListener("focus",gG),_.addEventListener("blur",hG),{onAction:(G)=>{return MS=G,()=>{if(MS===G)MS=null}},listProjects:async()=>{let G=await vS({kind:"projects"});if(G.kind!=="projects")throw new X("HOST_REJECTED","Expected projects.");return G},listWorktrees:async(G)=>{let T=await vS({kind:"worktrees",projectId:G});if(T.kind!=="worktrees")throw new X("HOST_REJECTED","Expected worktrees.");return T},listSessions:async(G)=>{let T=await vS({kind:"sessions",projectId:G});if(T.kind!=="sessions")throw new X("HOST_REJECTED","Expected sessions.");return T},onProjects:(G)=>pS({kind:"projects"},(T)=>{if(T.kind==="projects")G(T)}),onWorktrees:(G,T)=>pS({kind:"worktrees",projectId:G},(U)=>{if(U.kind==="worktrees")T(U)}),onSessions:(G,T)=>pS({kind:"sessions",projectId:G},(U)=>{if(U.kind==="sessions")T(U)}),onRunningShells:(G,T)=>NT(G,T),readShellOutput:async(G,T)=>{g(G,QS);let U=T?.cursor;if(U!==void 0&&(!Number.isInteger(U)||U<0))throw new X("HOST_REJECTED","Shell output cursor must be a non-negative integer.");let E=T?.tailBytes;if(E!==void 0&&(!Number.isInteger(E)||E<1||E>ZS))throw new X("HOST_REJECTED",`Shell output tailBytes must be an integer between 1 and ${ZS}.`);let Y=await k({...j,type:"shell-output",id:B(C),payload:{shellId:G,cursor:U,tailBytes:E}});if(!Y||typeof Y.output!=="string"||!Number.isFinite(Y.cursor))throw new X("HOST_REJECTED","Host did not return shell output.");return Y},stopShell:async(G)=>{if(g(G,QS),(await k({...j,type:"shell-stop",id:B(C),payload:{shellId:G}}))?.stopped!==!0)throw new X("HOST_REJECTED","Host did not stop the shell.");return{stopped:!0}},openSession:async(G)=>{g(G),await J({...j,type:"open-session",id:B(C),payload:{sessionId:G}})},storage:{get:async(G,T)=>{let U=wS(T),E={op:"get",key:G};if(U)E.scope=U;let Z=await YS(E);return Z.op==="get"&&Z.found?Z.value:void 0},set:async(G,T,U)=>{let E=wS(U),Z={op:"set",key:G,value:T};if(E)Z.scope=E;await YS(Z)},delete:async(G,T)=>{let U=wS(T),E={op:"delete",key:G};if(U)E.scope=U;await YS(E)},keys:async(G)=>{let T=wS(G),U={op:"keys"};if(T)U.scope=T;let E=await YS(U);if(E.op!=="keys")throw new X("HOST_REJECTED","Expected storage keys.");return E.keys}},onReady:(G)=>{if(O.add(G),P)G(P);return()=>{O.delete(G)}},onDirectory:(G)=>{if(F.add(G),P)G(P.directory);return()=>{F.delete(G)}},onSession:(G)=>{if(Q.add(G),P)G(P.session);return()=>{Q.delete(G)}},onSessionLifecycle:(G)=>{if($.add(G),m)G(m);return()=>{$.delete(G)}},onConnection:(G)=>{if(I.add(G),P)G(P.connection);return()=>{I.delete(G)}},onSettings:(G)=>{if(w.add(G),P)G(P.settings);return()=>{w.delete(G)}},onItem:(G)=>{if(TS.add(G),P)G(P.item);return()=>{TS.delete(G)}},onStatusControl:(G)=>{return CS.add(G),()=>{CS.delete(G)}},onPopoverClosed:(G)=>{return BS.add(G),()=>{BS.delete(G)}},setStatusControls:(G)=>{if(P?.features?.statusControls!==!0)return Promise.reject(new X("UNSUPPORTED","This host does not support status controls."));if(!lG(G))return Promise.reject(new X("HOST_REJECTED","Status controls must have unique bounded ids and valid selected options."));return J({...j,type:"status-controls",id:B(C),payload:{controls:G}})},openPopover:(G)=>{if(P?.features?.popovers!==!0)return Promise.reject(new X("UNSUPPORTED","This host does not support popovers."));if(!tS(G))return Promise.reject(new X("HOST_REJECTED","Popover requests need bounded geometry and JSON data."));return J({...j,type:"popover-open",id:B(C),payload:G})},closePopover:mG,setPopoverAnchorActive:cG,onResolve:(G)=>{return _S=G,()=>{if(_S===G)_S=null}},toast:(G)=>{let T=G.message.trim();if(!T||T.length>jS)return Promise.reject(new X("HOST_REJECTED",`Toast message must contain 1 to ${jS} characters.`));if(G.copy&&G.copy!==!0&&(!G.copy.text.length||G.copy.text.length>RS))return Promise.reject(new X("HOST_REJECTED",`Toast copy text must contain 1 to ${RS} characters.`));return J({channel:D,v:W,type:"toast",id:B(C),payload:{...G,message:T}})},openUrl:(G)=>J({channel:D,v:W,type:"open-url",id:B(C),payload:{url:G}}),openCommit:(G)=>TG(G)?J({channel:D,v:W,type:"open-commit",id:B(C),payload:{sha:G}}):Promise.reject(new X("HOST_REJECTED","Commit id must be 7 to 64 hex characters.")),openSurface:(G)=>J({channel:D,v:W,type:"open-surface",id:B(C),payload:{surfaceId:G}}),writeClipboard:(G)=>J({channel:D,v:W,type:"clipboard-write",id:B(C),payload:{text:G}}),compose:(G)=>J({channel:D,v:W,type:"compose",id:B(C),payload:G}),attach:(G)=>J({channel:D,v:W,type:"attach",id:B(C),payload:e(G)}),startSession:async(G)=>{if(G.projectId!==void 0)g(G.projectId);let T=G.worktree;if(T&&T!==!0)if(T.kind==="existing")g(T.directory);else{if(T.name!==void 0)g(T.name,200);if(T.baseBranch!==void 0)g(T.baseBranch,200)}let U=await k({channel:D,v:W,type:"start-session",id:B(C),payload:EG(G)},S.requestTimeoutMs??180000);if(!SG(U))throw new X("HOST_REJECTED","Host did not return a session.");return U},prompt:(G)=>k({channel:D,v:W,type:"prompt",id:B(C),payload:AG(G)}).then((T)=>{if(!GG(T))throw new X("HOST_REJECTED","Host did not return a prompt result.");return T}),sessionLink:(G)=>J({channel:D,v:W,type:"session-link",id:B(C),payload:e(G)}),close:()=>J({channel:D,v:W,type:"close",id:B(C)}),oauthStart:()=>J({channel:D,v:W,type:"oauth-start",id:B(C)}),oauthDisconnect:()=>J({channel:D,v:W,type:"oauth-disconnect",id:B(C)}),request:(G)=>(HS(G.path)?k({channel:D,v:W,type:"request",id:B(C),payload:G}):$T()).then((T)=>{if(!NS(T))throw new X("HOST_REJECTED","Host request result was empty.");return T}),serviceRequest:(G)=>(HS(G.path)?k({channel:D,v:W,type:"service-request",id:B(C),payload:G}):$T()).then((T)=>{if(!NS(T))throw new X("HOST_REJECTED","Host service request result was empty.");return T}),serviceStatus:()=>k({channel:D,v:W,type:"service-status",id:B(C)}).then((G)=>{if(!PG(G))throw new X("HOST_REJECTED","Host did not return service status.");return G}),readFile:(G)=>(SS(G)?k({channel:D,v:W,type:"file-read",id:B(C),payload:{path:G}}):kS()).then((T)=>{if(!CG(T))throw new X("HOST_REJECTED","Host did not return file content.");return T}),writeFile:(G,T)=>{if(!SS(G))return kS();if(T.length>KS)return Promise.reject(new X("FILE_TOO_LARGE",`Content is over ${KS} characters.`));return k({channel:D,v:W,type:"file-write",id:B(C),payload:{path:G,content:T}}).then((U)=>{if(!BG(U))throw new X("HOST_REJECTED","Host did not confirm the write.");return U})},listDir:(G)=>(SS(G)?k({channel:D,v:W,type:"file-list",id:B(C),payload:{path:G}}):kS()).then((T)=>{if(!DG(T))throw new X("HOST_REJECTED","Host did not return directory entries.");return T}),stat:(G)=>(SS(G)?k({channel:D,v:W,type:"file-stat",id:B(C),payload:{path:G}}):kS()).then((T)=>{if(!WG(T))throw new X("HOST_REJECTED","Host did not return file status.");return T}),generate:(G)=>{let T=G.prompt.trim(),U=G.system?.trim();if(T.length===0||T.length>LS)return Promise.reject(new X("HOST_REJECTED",`Prompt must be 1 to ${LS} characters.`));if(U!==void 0&&(U.length===0||U.length>IS))return Promise.reject(new X("HOST_REJECTED",`System prompt must be 1 to ${IS} characters.`));let E=G.maxOutputTokens===void 0?void 0:Math.min(MG,Math.max(1,Math.floor(G.maxOutputTokens)));if(E!==void 0&&!Number.isFinite(E))return Promise.reject(new X("HOST_REJECTED","maxOutputTokens must be a number."));let Z={prompt:T};if(U!==void 0)Z.system=U;if(E!==void 0)Z.maxOutputTokens=E;return k({channel:D,v:W,type:"generate",id:B(C),payload:Z},S.requestTimeoutMs??UG).then((Y)=>{if(!FG(Y))throw new X("HOST_REJECTED","Host did not return generated text.");return Y})},setBadge:(G)=>J({channel:D,v:W,type:"badge",id:B(C),payload:{count:XG(G)}}),setHeight:(G)=>J({channel:D,v:W,type:"resize",id:B(C),payload:{height:OG(G)}}),onFileOpen:(G)=>{if(DS.add(G),!dS)dS=!0,_.addEventListener("keydown",xG,!0);if(ES)G(ES);return()=>{DS.delete(G)}},onFileSnapshot:(G)=>{return US=G,()=>{if(US===G)US=null}},onFileSaved:(G)=>{return WS.add(G),()=>{WS.delete(G)}},reportFileChange:(G)=>uS({...j,type:"file-change",payload:{dirty:G.dirty,edited:G.edited}}),requestFileSave:bG,reportFileUnsupported:()=>uS({...j,type:"file-unsupported"}),dispose:()=>{for(let G of r.keys())q({...j,type:"workspace-unsubscribe",id:B(C),payload:{subscriptionId:G}});r.clear();for(let G of s.keys())q({...j,type:"shells-unsubscribe",id:B(C),payload:{subscriptionId:G}});if(s.clear(),h=!0,_S=null,MS=null,US=null,DS.clear(),WS.clear(),dS)_.removeEventListener("keydown",xG,!0);_.removeEventListener("message",wG),_.removeEventListener("keydown",qG,!0),_.removeEventListener("pointerover",$S),_.removeEventListener("pointermove",$S),_.removeEventListener("pointerout",yG),_.removeEventListener("focus",gG),_.removeEventListener("blur",hG);for(let G of i.values())clearTimeout(G.timer),G.reject(new X("HOST_UNAVAILABLE","Host client was disposed."));i.clear(),O.clear(),F.clear(),Q.clear(),$.clear(),I.clear(),w.clear(),TS.clear(),CS.clear(),BS.clear()}}};var YT=["browser.open","browser.snapshot","browser.click","browser.type","browser.scroll","browser.back","browser.forward","browser.inspect","browser.capture","browser.resize"];var Y_=new Set(YT);var QT=["none","agent","user"];var Z_=new Set(QT);var mT=[["--oc-bg","background"],["--oc-elevated","elevated"],["--oc-fg","foreground"],["--oc-muted","muted"],["--oc-subtle","subtle"],["--oc-border","border"],["--oc-hover","hover"],["--oc-selection","selection"],["--oc-focus","focus"],["--oc-primary","primary"],["--oc-muted-surface","mutedSurface"],["--oc-elevated-fg","elevatedForeground"],["--oc-active","active"],["--oc-selection-fg","selectionForeground"],["--oc-primary-fg","primaryForeground"],["--oc-primary-text","primaryText"],["--oc-success-text","successText"],["--oc-warning-text","warningText"],["--oc-error-text","errorText"],["--oc-info-text","infoText"],["--oc-success","success"],["--oc-warning","warning"],["--oc-error","error"],["--oc-info","info"],["--oc-font","font"],["--oc-mono","mono"],["--oc-radius","radius"],["--surface-background","background"],["--surface-elevated","elevated"],["--surface-foreground","foreground"],["--surface-muted-foreground","muted"],["--surface-subtle","subtle"],["--interactive-border","border"],["--interactive-hover","hover"],["--interactive-selection","selection"],["--interactive-focus-ring","focus"],["--primary","primary"],["--surface-muted","mutedSurface"],["--surface-elevated-foreground","elevatedForeground"],["--interactive-active","active"],["--interactive-selection-foreground","selectionForeground"],["--primary-foreground","primaryForeground"],["--primary-text","primaryText"],["--success-text","successText"],["--warning-text","warningText"],["--error-text","errorText"],["--info-text","infoText"],["--status-success","success"],["--status-warning","warning"],["--status-error","error"],["--status-info","info"],["--font-sans","font"],["--font-mono","mono"],["--radius","radius"]],cT=[["--oc-syntax-keyword","--syntax-keyword","syntaxKeyword"],["--oc-syntax-string","--syntax-string","syntaxString"],["--oc-syntax-number","--syntax-number","syntaxNumber"],["--oc-syntax-function","--syntax-function","syntaxFunction"],["--oc-syntax-type","--syntax-type","syntaxType"],["--oc-syntax-comment","--syntax-comment","syntaxComment"],["--oc-syntax-variable","--syntax-variable","syntaxVariable"],["--oc-syntax-operator","--syntax-operator","syntaxOperator"]],ZT=(S,_)=>{_.style.colorScheme=S.mode;for(let[M,A]of mT)_.style.setProperty(M,S.tokens[A]);for(let[M,A,O]of cT){let F=S.tokens[O]??"";_.style.setProperty(M,F),_.style.setProperty(A,F)}_.style.setProperty("font-family",S.tokens.font),_.style.setProperty("font-size","0.875rem"),_.style.setProperty("line-height","1.45"),_.style.setProperty("color",S.tokens.foreground)},QG=(S,_)=>{if(ZT(S.theme,_),_.dataset)_.dataset.ocSurface=S.surface,_.dataset.ocTheme=S.theme.mode};var dT={"surface-background":"bg","surface-elevated":"elevated","surface-elevated-foreground":"elevated-fg","surface-foreground":"fg","surface-muted-foreground":"muted","surface-muted":"muted-surface","surface-subtle":"subtle","interactive-border":"border","interactive-hover":"hover","interactive-active":"active","interactive-selection":"selection","interactive-selection-foreground":"selection-fg","interactive-focus-ring":"focus",primary:"primary","primary-foreground":"primary-fg","primary-text":"primary-text","success-text":"success-text","warning-text":"warning-text","error-text":"error-text","info-text":"info-text","status-success":"success","status-warning":"warning","status-error":"error","status-info":"info","font-sans":"font","font-mono":"mono",radius:"radius"},z=(S,_)=>`var(--${S}, var(--oc-${dT[S]}, ${_}))`,l=z("surface-background","transparent"),bS=z("surface-elevated","transparent"),PS=z("surface-elevated-foreground","inherit"),d=z("surface-foreground","inherit"),V=z("surface-muted-foreground","gray"),uT=z("surface-muted","transparent"),y=z("interactive-border","currentColor"),b=z("interactive-hover","transparent"),a=z("interactive-active","transparent"),ZG=z("interactive-selection","transparent"),zG=z("interactive-selection-foreground","inherit"),JT=z("interactive-focus-ring","currentColor"),c=z("primary","currentColor"),VG=z("primary-text","inherit"),JG=z("error-text","inherit"),vT=z("font-sans","inherit"),jG=z("font-mono","monospace"),jT=z("radius","9px"),RG=`calc(${jT} - 2px)`,zT=`calc(${jT} - 4px)`,L=(S,_,M="transparent")=>`color-mix(in srgb, ${S} ${_}%, ${M})`,VT=`box-shadow: 0 0 0 2px ${JT};`,xS=(S)=>{let _=z(`status-${S}`,"currentColor");return`
.oc-sdk[data-tone="${S}"], .oc-sdk [data-tone="${S}"] { --oc-sdk-tone: ${_}; --oc-sdk-tone-text: ${z(`${S}-text`,"inherit")}; }`},pT=`
.oc-sdk { box-sizing: border-box; font-size: 0.875rem; line-height: 1.45; }
.oc-sdk *, .oc-sdk *::before, .oc-sdk *::after { box-sizing: border-box; }
/* :where() keeps the reset at zero specificity so every primitive class below overrides it. */
:where(.oc-sdk) :where(button, input, textarea), :where(button.oc-sdk, input.oc-sdk, textarea.oc-sdk) { font: inherit; color: inherit; margin: 0; }
:where(.oc-sdk) :where(button), :where(button.oc-sdk) { cursor: pointer; background: none; border: 0; padding: 0; }
.oc-sdk button:disabled, button.oc-sdk:disabled, .oc-sdk[aria-disabled="true"], .oc-sdk [aria-disabled="true"] { opacity: .5; pointer-events: none; }

.oc-sdk-btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 32px; padding: 0 12px; border: 1px solid transparent; font-size: 0.875rem; font-weight: 500; line-height: 1; white-space: nowrap; }
.oc-sdk-btn[data-size="sm"] { gap: 6px; height: 28px; padding: 0 10px; font-size: 0.8125rem; }
.oc-sdk-btn[data-size="xs"] { gap: 4px; height: 24px; padding: 0 8px; font-size: 0.75rem; }
.oc-sdk-btn[data-loading="true"] { opacity: .5; pointer-events: none; }
.oc-sdk-btn > .oc-sdk-spinner-ring { width: 14px; height: 14px; }

.oc-sdk-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-field-label { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-field-note { font-size: 0.75rem; }
.oc-sdk-input { display: block; width: 100%; min-width: 0; height: 32px; padding: 0 10px; border: 0; font-size: 0.875rem; line-height: 1.45; appearance: none; }
textarea.oc-sdk-input { height: auto; padding: 8px 10px; resize: vertical; }

.oc-sdk-search { position: relative; min-width: 0; }
.oc-sdk-search .oc-sdk-input { padding-left: 34px; padding-right: 34px; }
.oc-sdk-search-icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); pointer-events: none; }
.oc-sdk-search-clear { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: none; align-items: center; justify-content: center; width: 24px; height: 24px; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-clear { display: inline-flex; }

.oc-sdk-select { position: relative; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-trigger { display: inline-flex; align-items: center; gap: 6px; width: 100%; min-width: 0; height: 28px; padding: 0 10px; border: 1px solid transparent; font-size: 0.8125rem; text-align: left; }
.oc-sdk-trigger-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-trigger-chevron { flex: 0 0 auto; }
.oc-sdk-popup { position: fixed; z-index: 50; display: flex; flex-direction: column; gap: 2px; min-width: 160px; max-width: calc(100vw - 16px); max-height: min(320px, calc(100vh - 16px)); overflow: auto; padding: 4px; border: 1px solid transparent; }
.oc-sdk-popup-search { flex: 0 0 auto; padding: 2px 2px 4px; }
.oc-sdk-popup-search .oc-sdk-input { height: 28px; font-size: 0.8125rem; }
.oc-sdk-option { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; font-size: 0.8125rem; text-align: left; }
.oc-sdk-option-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-option-hint { flex: 0 0 auto; font-size: 0.75rem; }
.oc-sdk-option-check { flex: 0 0 auto; display: inline-flex; width: 14px; visibility: hidden; }
.oc-sdk-option[aria-selected="true"] > .oc-sdk-option-check { visibility: visible; }
.oc-sdk-popup-empty { padding: 8px; font-size: 0.8125rem; }

.oc-sdk-check { display: inline-flex; align-items: flex-start; gap: 8px; width: 100%; text-align: left; }
.oc-sdk-check-box { flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; width: 14px; height: 14px; margin-top: 3px; border: 1px solid transparent; }
.oc-sdk-check-box > svg { display: none; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box > svg { display: block; }
.oc-sdk-check-thumb { flex: 0 0 auto; position: relative; width: 36px; height: 20px; }
.oc-sdk-check-thumb::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; }
.oc-sdk-check-text { display: flex; flex-direction: column; min-width: 0; }
.oc-sdk-check-label { font-size: 0.875rem; }
.oc-sdk-check-desc { font-size: 0.75rem; }

.oc-sdk-tabs { display: inline-flex; gap: 2px; padding: 2px; max-width: 100%; overflow: auto; }
.oc-sdk-tab { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid transparent; font-size: 0.8125rem; font-weight: 500; white-space: nowrap; }
.oc-sdk-tab-count { font-size: 0.75rem; font-variant-numeric: tabular-nums; }

.oc-sdk-badge { display: inline-flex; align-items: center; padding: 1px 6px; font-size: 11px; font-weight: 500; line-height: 16px; white-space: nowrap; }

.oc-sdk-list { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.oc-sdk-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 8px; text-align: left; }
.oc-sdk-row-lead { flex: 0 0 auto; width: 64px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-main { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.oc-sdk-row-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.oc-sdk-row-sub { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 0.75rem; }
.oc-sdk-row-meta { flex: 0 0 auto; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-list-empty { padding: 16px 8px; text-align: center; font-size: 0.8125rem; }

.oc-sdk-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; padding: 40px 16px; text-align: center; }
.oc-sdk-empty-title { margin: 0; font-size: 0.8125rem; font-weight: 600; }
.oc-sdk-empty-body { margin: 0; max-width: 32rem; font-size: 0.8125rem; }
.oc-sdk-empty-action { margin-top: 12px; }

@keyframes oc-sdk-spin { to { transform: rotate(360deg); } }
.oc-sdk-spinner { display: inline-flex; align-items: center; gap: 8px; font-size: 0.8125rem; }
.oc-sdk-spinner-ring { width: 16px; height: 16px; border: 2px solid transparent; animation: oc-sdk-spin .8s linear infinite; }
.oc-sdk-spinner[data-size="sm"] .oc-sdk-spinner-ring { width: 12px; height: 12px; }

.oc-sdk-banner { display: flex; align-items: flex-start; gap: 12px; padding: 8px 12px; border: 1px solid transparent; }
.oc-sdk-banner-text { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.oc-sdk-banner-title { font-size: 0.8125rem; font-weight: 500; }
.oc-sdk-banner-body { font-size: 0.8125rem; }
.oc-sdk-banner-action { flex: 0 0 auto; }

.oc-sdk-separator { display: flex; align-items: center; gap: 8px; width: 100%; margin: 8px 0; font-size: 0.75rem; }
.oc-sdk-separator::before, .oc-sdk-separator::after { content: ""; flex: 1 1 auto; height: 1px; }
.oc-sdk-separator[data-labeled="false"]::after { display: none; }
.oc-sdk-popup > .oc-sdk-separator { margin: 4px 0; }

.oc-sdk-progress { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.oc-sdk-progress-label { display: flex; justify-content: space-between; font-size: 0.75rem; font-variant-numeric: tabular-nums; }
.oc-sdk-progress-track { height: 6px; overflow: hidden; }
.oc-sdk-progress-fill { height: 100%; transform-origin: left; transition: transform 200ms ease-out; }

.oc-sdk-menu { position: relative; display: inline-flex; }

.oc-sdk-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.oc-sdk-text img { display: block; max-width: 100%; margin: 8px 0; }
`,RT=`
.oc-sdk { color: ${d}; font-family: ${vT}; }
.oc-sdk :focus-visible { outline: none; ${VT} }
.oc-sdk-mono { font-family: ${jG}; }
.oc-sdk-muted { color: ${V}; }
${xS("success")}${xS("warning")}${xS("error")}${xS("info")}
.oc-sdk[data-tone="primary"], .oc-sdk [data-tone="primary"] { --oc-sdk-tone: ${c}; --oc-sdk-tone-text: ${VG}; }

.oc-sdk-btn { border-radius: ${RG}; transition: background 150ms ease-out, color 150ms ease-out; }
.oc-sdk-btn[data-size="xs"] { border-radius: ${zT}; }
.oc-sdk-btn[data-variant="default"] { color: ${VG}; background: ${L(c,10,l)}; border-color: ${L(c,12)}; }
.oc-sdk-btn[data-variant="default"]:hover { background: ${L(c,16,l)}; }
.oc-sdk-btn[data-variant="default"]:active { background: ${L(c,22,l)}; }
.oc-sdk-btn[data-variant="secondary"] { background: ${uT}; color: var(--oc-fg); }
.oc-sdk-btn[data-variant="secondary"]:hover { background-image: linear-gradient(${b}, ${b}); }
.oc-sdk-btn[data-variant="secondary"]:active { background-image: linear-gradient(${a}, ${a}); }
.oc-sdk-btn[data-variant="outline"] { background: ${bS}; color: ${PS}; border-color: ${y}; }
.oc-sdk-btn[data-variant="outline"]:hover { background-image: linear-gradient(${b}, ${b}); }
.oc-sdk-btn[data-variant="outline"]:active { background-image: linear-gradient(${a}, ${a}); }
.oc-sdk-btn[data-variant="ghost"] { background: transparent; }
.oc-sdk-btn[data-variant="ghost"]:hover { background: ${b}; }
.oc-sdk-btn[data-variant="ghost"]:active { background: ${a}; }
.oc-sdk-btn[data-variant="destructive"] { --oc-sdk-tone: ${z("status-error","red")}; color: ${JG}; background: ${L("var(--oc-sdk-tone)",7,l)}; border-color: ${L("var(--oc-sdk-tone)",12)}; }
.oc-sdk-btn[data-variant="destructive"]:hover { background: ${L("var(--oc-sdk-tone)",9,l)}; }
.oc-sdk-btn[data-variant="destructive"]:active { background: ${L("var(--oc-sdk-tone)",11,l)}; }

.oc-sdk-field-note { color: ${V}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-field-note { color: ${JG}; }
.oc-sdk-input { border-radius: ${RG}; background: ${bS}; color: ${PS}; box-shadow: inset 0 0 0 1px ${L(y,60)}; transition: background 150ms ease-out, box-shadow 150ms ease-out; }
.oc-sdk-input::placeholder { color: ${V}; }
.oc-sdk-input:hover:not(:focus) { background-image: linear-gradient(${b}, ${b}); }
.oc-sdk-input:focus, .oc-sdk-input:focus-visible { box-shadow: inset 0 0 0 2px ${JT}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input { box-shadow: inset 0 0 0 1px ${z("status-error","red")}; }
.oc-sdk-field[data-invalid="true"] .oc-sdk-input:focus { box-shadow: inset 0 0 0 2px ${z("status-error","red")}; }
.oc-sdk-input[data-mono="true"] { font-family: ${jG}; }

.oc-sdk-search-icon { color: ${V}; }
.oc-sdk-search[data-active="true"] .oc-sdk-search-icon { color: ${c}; }
.oc-sdk-search-clear { border-radius: ${zT}; color: ${V}; }
.oc-sdk-search-clear:hover { background: ${b}; color: ${d}; }

.oc-sdk-trigger { border-color: ${y}; border-radius: ${RG}; background: ${bS}; color: ${PS}; transition: background 150ms ease-out; }
.oc-sdk-trigger:hover { background-image: linear-gradient(${b}, ${b}); }
.oc-sdk-trigger[aria-expanded="true"] { background-image: linear-gradient(${a}, ${a}); }
.oc-sdk-trigger-value[data-empty="true"] { color: ${V}; }
.oc-sdk-trigger-chevron { color: ${V}; }
.oc-sdk-popup { --surface-foreground: ${PS}; border-color: ${L(y,60)}; border-radius: 12px; background: ${bS}; color: ${PS}; box-shadow: 0 8px 24px ${L(d,12)}; }
.oc-sdk-option { border-radius: 8px; }
.oc-sdk-option[data-active="true"] { background: ${b}; }
/* A selected option shows a check mark in the text colour, like the app's own pickers. Options without the mark come
   from bundles built before it existed and keep the selection fill as their only sign of the choice. */
.oc-sdk-option[aria-selected="true"]:not([data-mark]) { background: ${ZG}; color: ${zG}; }
.oc-sdk-option-check { color: ${d}; }
.oc-sdk-option[data-destructive="true"] { color: ${JG}; }
.oc-sdk-option[data-destructive="true"][data-active="true"] { background: ${L(z("status-error","red"),10)}; }
.oc-sdk-option-hint { color: ${V}; }
.oc-sdk-popup-empty { color: ${V}; }

/* Checked stays neutral: the mark carries the state, and the primary colour stays with primary actions. */
.oc-sdk-check-box { border-color: ${y}; border-radius: 4px; color: ${d}; transition: border-color 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-box { border-color: ${L(d,60,y)}; }
.oc-sdk-check-thumb { border-radius: 9999px; background: ${y}; transition: background 150ms ease-out; }
.oc-sdk-check-thumb::after { border-radius: 9999px; background: ${l}; transition: transform 150ms ease-out; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb { background: ${c}; }
.oc-sdk-check[aria-checked="true"] .oc-sdk-check-thumb::after { transform: translateX(16px); }
.oc-sdk-check:focus-visible { box-shadow: none; }
.oc-sdk-check:focus-visible .oc-sdk-check-box, .oc-sdk-check:focus-visible .oc-sdk-check-thumb { ${VT} }
.oc-sdk-check-desc { color: ${V}; }

.oc-sdk-tabs { border-radius: 10px; }
.oc-sdk-tabs[data-track="true"] { background: ${L(d,4)}; }
.oc-sdk-tab { border-radius: 8px; color: ${V}; transition: color 150ms ease-out, background 150ms ease-out; }
.oc-sdk-tab:hover { color: ${d}; }
.oc-sdk-tab[aria-selected="true"] { color: ${zG}; background: ${ZG}; border-color: ${y}; }
.oc-sdk-tab-count { color: ${V}; }

.oc-sdk-badge { border-radius: 9999px; background: ${b}; color: ${V}; }
.oc-sdk-badge[data-tone] { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); background: ${L("var(--oc-sdk-tone)",15)}; }

.oc-sdk-row { border-radius: 6px; transition: background 120ms ease-out; }
.oc-sdk-row:hover, .oc-sdk-row[data-active="true"] { background: ${b}; }
.oc-sdk-row[aria-selected="true"] { background: ${ZG}; color: ${zG}; }
.oc-sdk-row-lead { font-family: ${jG}; color: ${V}; }
.oc-sdk-row-sub { color: ${V}; }
.oc-sdk-row-meta { color: ${V}; }
.oc-sdk-row[aria-selected="true"] .oc-sdk-row-lead, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-sub, .oc-sdk-row[aria-selected="true"] .oc-sdk-row-meta { color: inherit; opacity: .75; }
.oc-sdk-list-empty { color: ${V}; }

.oc-sdk-empty-body { color: ${V}; }

.oc-sdk-spinner { color: ${V}; }
.oc-sdk-spinner-ring { border-color: ${y}; border-top-color: ${c}; border-radius: 9999px; }

.oc-sdk-banner { border-color: ${L("var(--oc-sdk-tone)",40)}; border-radius: 8px; background: ${L("var(--oc-sdk-tone)",10)}; }
.oc-sdk-banner-title { color: var(--oc-sdk-tone-text, var(--oc-sdk-tone)); }
.oc-sdk-banner-body { color: ${V}; }

.oc-sdk-separator { color: ${V}; }
.oc-sdk-separator::before, .oc-sdk-separator::after { background: ${L(y,40)}; }

.oc-sdk-progress-label { color: ${V}; }
.oc-sdk-progress-track { border-radius: 9999px; background: ${y}; }
.oc-sdk-progress-fill { border-radius: 9999px; background: var(--oc-sdk-tone, ${c}); }

.oc-sdk-text a { color: ${VG}; text-decoration: underline; text-underline-offset: 2px; }
.oc-sdk-text img { border-radius: 8px; border: 1px solid ${L(y,60)}; }
`,H=`
${lS}
${pT}
${RT}`;var fT="oc-sdk-ui-style";var N=(S)=>{let _=document.getElementById(fT);if(_ instanceof HTMLStyleElement){if(_.textContent!==S)_.textContent=S;return}aS(document);let M=document.createElement("style");M.id=fT,M.textContent=S,document.head.appendChild(M)},f=(S,_)=>{let M=document.createElement(S);if(_)M.className=_;return M},u=(S)=>{let _=f("button",S);return _.type="button",_},x=(S,_)=>{let M=_??"";if(S.textContent!==M)S.textContent=M};var lT=()=>{let S=document.createElement("span");return S.className="oc-sdk-spinner-ring",S.setAttribute("aria-hidden","true"),S},v=(S,_)=>{N(H);let M=_,A=u("oc-sdk oc-sdk-btn"),O=lT(),F=document.createElement("span");A.append(F),S.append(A);let Q=()=>{if(A.dataset.variant=M.variant??"default",A.dataset.size=M.size??"default",A.disabled=Boolean(M.disabled)||Boolean(M.loading),A.dataset.loading=M.loading?"true":"false",A.setAttribute("aria-busy",M.loading?"true":"false"),M.loading&&O.parentNode!==A)A.prepend(O);else if(!M.loading&&O.parentNode===A)O.remove();x(F,M.label)},$=()=>{if(M.disabled||M.loading)return;M.onClick()};return A.addEventListener("click",$),Q(),{update:(I)=>{M={...M,...I},Q()},dispose:()=>{A.removeEventListener("click",$),A.remove()}}};var KG=(S,_)=>{N(H);let M=_,A=f("div","oc-sdk oc-sdk-empty"),O=f("h2","oc-sdk-empty-title"),F=f("p","oc-sdk-empty-body"),Q=f("div","oc-sdk-empty-action");A.append(O,F,Q),S.append(A);let $=null,I=()=>{if(x(O,M.title),x(F,M.body),F.hidden=!M.body,Q.hidden=!M.action,!M.action){$?.dispose(),$=null;return}let w={label:M.action.label,onClick:M.action.onClick};if($)$.update(w);else $=v(Q,{...w,variant:"outline",size:"sm"})};return I(),{update:(w)=>{M={...M,...w},I()},dispose:()=>{$?.dispose(),$=null,A.remove()}}};var rT=/^(\s*[-*+] )\[( |x|X)\] ?(.*)$/,KT=(S)=>S.split(`
`).map((_)=>{let M=rT.exec(_);return M?{kind:"item",prefix:M[1]??"- ",done:M[2]!==" ",text:M[3]??""}:{kind:"text",text:_}}),LT=(S)=>S.map((_)=>_.kind==="text"?_.text:`${_.prefix}[${_.done?"x":" "}] ${_.text}`).join(`
`),mS=(S)=>{let _=2166136261;for(let M=0;M<S.length;M+=1)_^=S.charCodeAt(M),_=Math.imul(_,16777619);return`${S.length}:${(_>>>0).toString(16)}`},IT=(S,_)=>{let M=-1,A="- ";S.forEach(($,I)=>{if($.kind!=="item")return;M=I,A=$.prefix});let O={kind:"item",prefix:A,done:!1,text:_};if(M>=0)return[...S.slice(0,M+1),O,...S.slice(M+1)];return[...S.at(-1)?.kind==="text"&&S.at(-1)?.text===""?S.slice(0,-1):[...S],O,{kind:"text",text:""}]};var n=YG(),o=document.querySelector("#root");if(!o)throw Error("Missing root");var HT=document.createElement("style");HT.textContent=`
  html, body { margin: 0; height: 100%; background: var(--oc-bg); color: var(--oc-fg); font-family: var(--oc-font); font-size: 13px; }
  #root { box-sizing: border-box; height: 100%; overflow: auto; padding: 16px 20px; }
  .note { margin: 2px 0; color: var(--oc-muted); white-space: pre-wrap; min-height: 1em; }
  .item { display: flex; align-items: center; gap: 8px; margin: 2px 0; }
  .item input[type="checkbox"] { width: 16px; height: 16px; margin: 0; accent-color: var(--oc-primary); }
  .item input[type="text"] { flex: 1; min-width: 0; border: 1px solid transparent; border-radius: var(--oc-radius); padding: 4px 6px;
    background: transparent; color: inherit; font: inherit; }
  .item input[type="text"]:hover { border-color: var(--oc-border); }
  .item input[type="text"]:focus { outline: none; border-color: var(--oc-focus); background: var(--oc-elevated); }
  .item.done input[type="text"] { color: var(--oc-muted); text-decoration: line-through; }
  .item .remove { visibility: hidden; }
  .item:hover .remove, .item:focus-within .remove { visibility: visible; }
  .actions { margin-top: 12px; }
`;document.head.append(HT);n.onReady((S)=>QG(S,document.documentElement));var p=[],GS=!1,IG=JS(null),HG=()=>LT(p),cS=()=>{n.reportFileChange(IG.observe(mS(HG())))},LG=()=>{if(o.replaceChildren(),!p.some((_)=>_.kind==="item")&&GS){KG(o,{title:"No items",body:"This checklist is empty."});return}if(p.forEach((_,M)=>{if(_.kind==="text"){let Q=document.createElement("p");Q.className="note",Q.textContent=_.text,o.append(Q);return}let A=document.createElement("div");A.className=_.done?"item done":"item";let O=document.createElement("input");O.type="checkbox",O.checked=_.done,O.disabled=GS,O.addEventListener("change",()=>{_.done=O.checked,A.className=_.done?"item done":"item",cS()});let F=document.createElement("input");if(F.type="text",F.value=_.text,F.readOnly=GS,F.setAttribute("aria-label","Item"),F.addEventListener("input",()=>{_.text=F.value,cS()}),A.append(O,F),!GS){let Q=document.createElement("span");Q.className="remove",v(Q,{label:"Remove",variant:"ghost",size:"xs",onClick:()=>{p=p.filter(($,I)=>I!==M),cS(),LG()}}),A.append(Q)}o.append(A)}),GS)return;let S=document.createElement("div");S.className="actions",v(S,{label:"Add item",variant:"secondary",size:"sm",onClick:()=>{p=IT(p,""),cS(),LG();let _=o.querySelectorAll('.item input[type="text"]');_.item(_.length-1)?.focus()}}),o.append(S)};n.onFileOpen((S)=>{if(S.encoding!=="text"){n.reportFileUnsupported();return}p=KT(S.content),GS=S.readOnly,IG=JS(mS(HG())),LG()});n.onFileSnapshot(()=>{let S=HG();return{content:S,version:mS(S)}});n.onFileSaved((S)=>{n.reportFileChange({dirty:IG.markSaved(S),edited:!1})});})();
