(function(){
const $=id=>document.getElementById(id);
const socket=io();
let roomId=null,myName='',isHost=false,player=null,playerReady=false,media=null,remote=false,remoteUntil=0,roomPeople=[],screenStream=null,callStream=null,siteUrl=null,siteExpanded=false,screenOwner=null;const peers=new Map(),callPeers=new Map(),callReady=new Set(),pendingScreenIce=new Map(),pendingCallIce=new Map();

socket.on('connect',()=>{$('connection').textContent='● Serverga ulandi'});
socket.on('disconnect',()=>{$('connection').textContent='● Aloqa uzildi'});
function name(){return $('nickname').value.trim().replace(/[<>]/g,'').slice(0,24)}
function enter(kind){
  myName=name();
  if(!myName){$('entryError').textContent='Ismingizni kiriting.';return}
  if(kind==='create')socket.emit('room:create',{name:myName});
  else socket.emit('room:join',{roomId:$('roomInput').value.trim().toUpperCase(),name:myName});
}
$('createRoom').onclick=()=>enter('create');
$('joinRoom').onclick=()=>{
  if(!/^[A-Z0-9]{6}$/.test($('roomInput').value.trim().toUpperCase())){$('entryError').textContent='Xona kodi 6 ta harf yoki raqam bo‘lishi kerak.';return}
  enter('join');
};
$('roomInput').oninput=e=>e.target.value=e.target.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,6);
socket.on('room:error',m=>{$('entryError').textContent=m;$('videoError').textContent=m});
socket.on('room:joined',d=>{
  roomId=d.roomId;isHost=d.isHost;siteUrl=d.siteUrl||null;siteExpanded=Boolean(d.siteExpanded);screenOwner=d.screenOwner||null;renderSharedSite(siteUrl,siteExpanded);
  $('entry').classList.add('hidden');$('how').classList.add('hidden');$('workspace').classList.remove('hidden');
  $('roomCode').textContent=roomId;$('role').textContent=isHost?'Xona egasi':'Ishtirokchi';
  $('loadVideo').disabled=!isHost;$('youtubeUrl').disabled=!isHost;$('mediaType').disabled=!isHost;$('screenShare').disabled=!!screenOwner&&screenOwner!==socket.id;$('chat').innerHTML='';
  history.replaceState({},'',location.pathname+'?room='+roomId);
  if(d.state&&(d.state.mediaType||d.state.videoId))loadMedia(normalizeState(d.state),d.state);
});
socket.on('room:role',d=>{
  isHost=d.isHost;$('role').textContent=isHost?'Xona egasi':'Ishtirokchi';
  $('loadVideo').disabled=!isHost;$('youtubeUrl').disabled=!isHost;$('mediaType').disabled=!isHost;$('screenShare').disabled=!!screenOwner&&screenOwner!==socket.id;
  ['playPause','back','forward'].forEach(id=>$(id).disabled=!isHost||!playerReady);
});
socket.on('room:people',list=>{
  roomPeople=list;
  const memberIds=new Set(list.map(p=>p.id));
  for(const id of Array.from(peers.keys()))if(!memberIds.has(id))removePeer(id);
  for(const id of Array.from(callPeers.keys()))if(!memberIds.has(id))removeCallPeer(id);
  for(const id of Array.from(callReady))if(!memberIds.has(id))callReady.delete(id);
  if(screenStream&&screenOwner===socket.id)syncScreenPeers();
  if(callStream)syncCallPeers();
  $('peopleCount').textContent=list.length;$('people').replaceChildren();
  list.forEach(p=>{const el=document.createElement('span');el.className='person';el.textContent=p.name+(p.isHost?' ★':'');$('people').append(el)});
});
function system(t){const e=document.createElement('div');e.className='system';e.textContent=t;$('chat').append(e);scroll()}
function scroll(){$('chat').scrollTop=$('chat').scrollHeight}
socket.on('room:system',system);
socket.on('chat:message',m=>{
  const e=document.createElement('div');e.className='message';const b=document.createElement('b');b.textContent=m.name;
  const p=document.createElement('p');p.textContent=m.text;e.append(b,p);$('chat').append(e);scroll();
});
$('chatForm').onsubmit=e=>{e.preventDefault();const text=$('chatText').value.trim();if(text&&roomId){socket.emit('chat:send',{text});$('chatText').value=''}};
let renderedSiteUrl=null;
function renderSharedSite(url,expanded){
  siteUrl=url||null;siteExpanded=Boolean(expanded);
  const wrap=$('sharedSiteWrap');
  if(!siteUrl){wrap.classList.add('hidden');renderedSiteUrl=null;return}
  wrap.classList.remove('hidden');
  if(renderedSiteUrl!==siteUrl){$('sharedSiteFrame').src=siteUrl;$('siteUrlInput').value=siteUrl;renderedSiteUrl=siteUrl}
  wrap.classList.toggle('site-expanded',siteExpanded);
  $('siteExpand').textContent=siteExpanded?'Kichraytirish (hamma uchun)':'Hamma uchun kattalashtirish';
  $('siteStatus').textContent='Sayt '+siteUrl+' — ichki oynada ochilmasa, “Yangi oynada ochish” yoki ekran ulashishdan foydalaning.';
}
$('shareSite').onclick=()=>{
  try{const u=new URL($('siteUrlInput').value.trim());if(!['http:','https:'].includes(u.protocol))throw new Error('protocol');socket.emit('site:share',{url:u.href})}
  catch(e){$('siteStatus').textContent='To‘liq http:// yoki https:// havolasini kiriting.'}
};
$('siteExpand').onclick=()=>{if(siteUrl)socket.emit('site:expand',{expanded:!siteExpanded})};
$('siteFullscreen').onclick=()=>{const el=$('sharedSiteFrameWrap');if(el.requestFullscreen)el.requestFullscreen().catch(()=>{$('siteStatus').textContent='To‘liq ekran rejimi brauzer tomonidan ruxsat etilmadi.'})};
$('openSite').onclick=()=>{if(siteUrl)window.open(siteUrl,'_blank','noopener,noreferrer')};
socket.on('site:shared',d=>{if(d&&d.url)renderSharedSite(d.url,d.expanded)});
$('copyInvite').onclick=async()=>{
  const u=location.origin+location.pathname+'?room='+roomId;
  try{await navigator.clipboard.writeText(u);$('copyInvite').textContent='Nusxalandi ✓';setTimeout(()=>$('copyInvite').textContent='Havolani nusxalash',1500)}
  catch(e){prompt('Havolani nusxalang',u)}
};
$('leaveRoom').onclick=()=>{
  if(screenStream)stopScreenShare();
  if(callStream)stopCall();
  for(const id of Array.from(peers.keys()))removePeer(id);
  for(const id of Array.from(callPeers.keys()))removeCallPeer(id);
  socket.emit('room:leave');destroyPlayer();roomId=null;history.replaceState({},'',location.pathname);
  $('workspace').classList.add('hidden');$('entry').classList.remove('hidden');$('how').classList.remove('hidden');
};
function parseMedia(raw){
  try{
    const u=new URL(raw);
    if(!['http:','https:'].includes(u.protocol))return null;
    const host=u.hostname.toLowerCase().replace(/^www\./,'');
    let id=null;
    if(host==='youtu.be')id=u.pathname.split('/').filter(Boolean)[0]||null;
    else if(host==='youtube.com'||host.endsWith('.youtube.com')){
      if(u.pathname==='/watch')id=u.searchParams.get('v');
      else if(u.pathname.startsWith('/embed/')||u.pathname.startsWith('/shorts/'))id=u.pathname.split('/')[2]||null;
    }
    const requested=$('mediaType').value;
    if(id&&/^[A-Za-z0-9_-]{11}$/.test(id)&&(requested==='auto'||requested==='youtube'))return{mediaType:'youtube',mediaId:id,mediaUrl:'https://www.youtube.com/watch?v='+id,videoId:id};
    if((host==='vimeo.com'||host==='player.vimeo.com')&&($('mediaType').value==='auto'||$('mediaType').value==='vimeo')){
      const parts=u.pathname.split('/').filter(Boolean);id=parts.find(x=>/^\d{1,15}$/.test(x))||null;
      if(id)return{mediaType:'vimeo',mediaId:id,mediaUrl:'https://player.vimeo.com/video/'+id,videoId:null};
    }
    if(($('mediaType').value==='auto'||$('mediaType').value==='file')&&/\.(mp4|webm)$/i.test(u.pathname))return{mediaType:'file',mediaId:u.href,mediaUrl:u.href,videoId:null};
    return null;
  }catch(e){return null}
}
function normalizeState(s){
  if(s.mediaType&&s.mediaId)return{mediaType:s.mediaType,mediaId:s.mediaId,mediaUrl:s.mediaUrl||s.mediaId,videoId:s.videoId||null};
  if(s.videoId)return{mediaType:'youtube',mediaId:s.videoId,mediaUrl:'https://www.youtube.com/watch?v='+s.videoId,videoId:s.videoId};
  return null;
}
function destroyPlayer(){
  if(player){
    try{if(media&&media.mediaType==='youtube'&&player.destroy)player.destroy();else if(media&&media.mediaType==='vimeo'&&player.destroy)player.destroy();else if(media&&media.mediaType==='file'){player.pause();player.removeAttribute('src');player.load()}}catch(e){}
  }
  $('player').replaceChildren();player=null;playerReady=false;media=null;
  $('placeholder').classList.remove('hidden');
  $('playPause').disabled=true;$('back').disabled=true;$('forward').disabled=true;
}
function markReady(state){
  playerReady=true;
  ['playPause','back','forward'].forEach(k=>$(k).disabled=!isHost);
  $('placeholder').classList.add('hidden');
  $('playState').textContent='Tayyor';
  if(state)applyState(state);
}
function loadMedia(next,state){
  if(!next)return;
  destroyPlayer();media=next;$('videoError').textContent='';$('placeholder').classList.add('hidden');
  $('playState').textContent='Video yuklanmoqda…';
  if(next.mediaType==='youtube'){
    if(!window.YT||!YT.Player){setTimeout(()=>loadMedia(next,state),200);return}
    const el=document.createElement('div');el.id='ytPlayer';$('player').append(el);
    player=new YT.Player('ytPlayer',{videoId:next.mediaId,playerVars:{playsinline:1,rel:0,controls:0,disablekb:1,origin:location.origin},events:{
      onReady:()=>markReady(state),
      onStateChange:e=>{if(remote||Date.now()<remoteUntil||!isHost)return;if(e.data===YT.PlayerState.PLAYING||e.data===YT.PlayerState.PAUSED)emitPlayback(e.data===YT.PlayerState.PLAYING,getTime())},
      onError:()=>{$('videoError').textContent='YouTube videosini ochib bo‘lmadi.'}
    }});
  }else if(next.mediaType==='vimeo'){
    const frame=document.createElement('iframe');frame.id='vimeoPlayer';frame.src=next.mediaUrl+'?controls=0&title=0&byline=0&portrait=0';frame.allow='autoplay; fullscreen; picture-in-picture';frame.allowFullscreen=true;frame.title='Vimeo video';$('player').append(frame);
    const init=()=>{if(!window.Vimeo||!window.Vimeo.Player){setTimeout(init,150);return}
      player=new Vimeo.Player(frame);
      player.ready().then(()=>markReady(state)).catch(()=>{$('videoError').textContent='Vimeo videosini ochib bo‘lmadi yoki video maxfiy.'});
      player.on('play',()=>{if(!remote&&Date.now()>=remoteUntil&&isHost)getTimeAsync().then(t=>emitPlayback(true,t))});
      player.on('pause',()=>{if(!remote&&Date.now()>=remoteUntil&&isHost)getTimeAsync().then(t=>emitPlayback(false,t))});
    };init();
  }else if(next.mediaType==='file'){
    const video=document.createElement('video');video.id='filePlayer';video.src=next.mediaUrl;video.playsInline=true;video.preload='auto';video.controls=false;video.style.width='100%';video.style.height='100%';video.style.position='absolute';video.style.inset='0';$('player').append(video);player=video;
    video.addEventListener('loadedmetadata',()=>markReady(state),{once:true});
    video.addEventListener('error',()=>{$('videoError').textContent='Videoni ochib bo‘lmadi. Havola ochiq va MP4/WebM formatida ekanini tekshiring.'});
    video.addEventListener('play',()=>{if(!remote&&Date.now()>=remoteUntil&&isHost)emitPlayback(true,video.currentTime)});
    video.addEventListener('pause',()=>{if(!remote&&Date.now()>=remoteUntil&&isHost&&!video.ended)emitPlayback(false,video.currentTime)});
    video.addEventListener('seeked',()=>{if(!remote&&Date.now()>=remoteUntil&&isHost)emitPlayback(!video.paused,video.currentTime)});
  }
}
function getTime(){
  if(!player||!playerReady)return 0;
  try{if(media.mediaType==='youtube')return player.getCurrentTime()||0;if(media.mediaType==='file')return player.currentTime||0}catch(e){}
  return 0;
}
async function getTimeAsync(){
  if(!player||!playerReady)return 0;
  try{if(media.mediaType==='vimeo')return await player.getCurrentTime();return getTime()}catch(e){return 0}
}
async function isPlaying(){
  if(!player||!playerReady)return false;
  try{if(media.mediaType==='youtube')return player.getPlayerState()===YT.PlayerState.PLAYING;if(media.mediaType==='file')return !player.paused;if(media.mediaType==='vimeo')return (await player.getPaused())===false}catch(e){}
  return false;
}
function emitPlayback(playing,time){
  if(!media||!roomId||!isHost)return;
  socket.emit('video:state',{mediaType:media.mediaType,mediaId:media.mediaId,mediaUrl:media.mediaUrl,videoId:media.videoId,isPlaying:!!playing,currentTime:Math.max(0,Number(time)||0)});
}
async function seekTo(t){
  if(!player||!playerReady)return;
  const v=Math.max(0,Number(t)||0);
  try{if(media.mediaType==='youtube')player.seekTo(v,true);else if(media.mediaType==='file')player.currentTime=v;else if(media.mediaType==='vimeo')await player.setCurrentTime(v)}catch(e){}
}
async function play(){if(!player||!playerReady)return;try{if(media.mediaType==='youtube')player.playVideo();else await player.play()}catch(e){$('videoError').textContent='Ijro etish uchun videoni sahifada ishga tushiring.'}}
async function pause(){if(!player||!playerReady)return;try{if(media.mediaType==='youtube')player.pauseVideo();else await player.pause()}catch(e){}}
async function applyState(s){
  if(!playerReady||!player||!s)return;
  const normalized=normalizeState(s);
  if(normalized&&(!media||normalized.mediaType!==media.mediaType||normalized.mediaId!==media.mediaId)){loadMedia(normalized,s);return}
  remote=true;remoteUntil=Date.now()+1200;
  const t=Math.max(0,Number(s.currentTime)||0)+(s.isPlaying?Math.max(0,Date.now()-(s.updatedAt||Date.now()))/1000:0);
  try{
    const current=await getTimeAsync();
    if(Math.abs(current-t)>2)await seekTo(t);
    if(s.isPlaying)await play();else await pause();
    $('playState').textContent=s.isPlaying?'▶ Ijro etilmoqda':'Ⅱ Pauza';
  }catch(e){}
  setTimeout(()=>{remote=false},1300);
}
$('loadVideo').onclick=()=>{
  const next=parseMedia($('youtubeUrl').value.trim());
  if(!next){$('videoError').textContent='Manbani tanlang va shu manbaga mos to‘liq havolani kiriting. MP4/WebM uchun video faylning bevosita URL manzili kerak.';return}
  socket.emit('video:load',next);
};
socket.on('video:loaded',s=>{const next=normalizeState(s);if(next)loadMedia(next,s)});
socket.on('video:state',s=>{const next=normalizeState(s);if(next&&(!media||next.mediaType!==media.mediaType||next.mediaId!==media.mediaId))loadMedia(next,s);else applyState(s)});
$('playPause').onclick=async()=>{
  if(!playerReady||!isHost)return;
  const playing=await isPlaying(),t=await getTimeAsync();
  if(playing)await pause();else await play();
  emitPlayback(!playing,t);
};
async function seek(d){
  if(!playerReady||!isHost)return;
  const t=Math.max(0,(await getTimeAsync())+d);
  await seekTo(t);emitPlayback(await isPlaying(),t);
}
$('back').onclick=()=>seek(-10);$('forward').onclick=()=>seek(10);
setInterval(async()=>{
  if(isHost&&roomId&&playerReady&&media&&await isPlaying())emitPlayback(true,await getTimeAsync());
},2500);
socket.on('room:state',s=>{const next=s&&normalizeState(s);if(next){$('youtubeUrl').value=next.mediaUrl;loadMedia(next,s)}});

function queueIce(kind,peerId,pc,candidate){
  const store=kind==='call'?pendingCallIce:pendingScreenIce;
  if(!pc.remoteDescription||!pc.remoteDescription.type){const q=store.get(peerId)||[];q.push(candidate);store.set(peerId,q);return}
  pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(()=>{});
}
async function flushIce(kind,peerId,pc){
  const store=kind==='call'?pendingCallIce:pendingScreenIce;const q=store.get(peerId)||[];store.delete(peerId);
  for(const candidate of q){try{await pc.addIceCandidate(new RTCIceCandidate(candidate))}catch(e){}}
}
function createPeer(peerId,initiator){
  if(peers.has(peerId))return peers.get(peerId);
  const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
  peers.set(peerId,pc);
  if(screenStream&&initiator)screenStream.getTracks().forEach(track=>pc.addTrack(track,screenStream));
  pc.onicecandidate=e=>{if(e.candidate&&roomId)socket.emit('rtc:ice',{to:peerId,kind:'screen',candidate:e.candidate})};
  pc.ontrack=e=>{
    if(e.streams&&e.streams[0]){
      $('sharedScreen').srcObject=e.streams[0];
      $('sharedScreenWrap').classList.remove('hidden');
      $('screenStatus').textContent='Xona egasining ekrani uzatilmoqda.';
    }
  };
  pc.onconnectionstatechange=()=>{
    if(['failed','closed'].includes(pc.connectionState))removePeer(peerId);
  };
  return pc;
}
async function syncScreenPeers(){
  if(!screenStream||screenOwner!==socket.id||!roomId)return;
  for(const person of roomPeople){
    if(person.id===socket.id||peers.has(person.id))continue;
    try{
      const pc=createPeer(person.id,true);
      const offer=await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.emit('rtc:offer',{to:person.id,kind:'screen',offer:pc.localDescription});
    }catch(e){removePeer(person.id)}
  }
}
function removePeer(peerId){
  const pc=peers.get(peerId);
  if(pc){try{pc.close()}catch(e){}peers.delete(peerId)}
  pendingScreenIce.delete(peerId);
}
socket.on('rtc:offer',async p=>{
  if(p&&p.kind==='call'){await answerCallOffer(p);return;}
  if(!roomId||!p||!p.from||!p.offer)return;
  try{
    const pc=createPeer(p.from,false);
    await pc.setRemoteDescription(new RTCSessionDescription(p.offer));
    await flushIce('screen',p.from,pc);
    const answer=await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('rtc:answer',{to:p.from,kind:'screen',answer:pc.localDescription});
  }catch(e){removePeer(p.from);$('videoError').textContent='Ekran ulanishida xatolik. Qayta urinib ko‘ring.'}
});
socket.on('rtc:answer',async p=>{
  const pc=p&&p.kind==='call'?callPeers.get(p.from):p&&peers.get(p.from);if(!pc||!p.answer)return;
  try{await pc.setRemoteDescription(new RTCSessionDescription(p.answer));await flushIce(p.kind==='call'?'call':'screen',p.from,pc)}catch(e){}
});
socket.on('rtc:ice',async p=>{
  const pc=p&&p.kind==='call'?callPeers.get(p.from):p&&peers.get(p.from);if(!pc||!p.candidate)return;
  queueIce(p.kind==='call'?'call':'screen',p.from,pc,p.candidate);
});

function callPeer(peerId,initiator){
  if(callPeers.has(peerId))return callPeers.get(peerId);
  const pc=new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
  callPeers.set(peerId,pc);
  if(callStream&&initiator)callStream.getTracks().forEach(track=>pc.addTrack(track,callStream));
  pc.onicecandidate=e=>{if(e.candidate)socket.emit('rtc:ice',{to:peerId,kind:'call',candidate:e.candidate})};
  pc.ontrack=e=>{
    if(!e.streams||!e.streams[0])return;
    let video=document.getElementById('call-'+peerId);
    if(!video){
      const person=roomPeople.find(p=>p.id===peerId);
      const wrap=document.createElement('div');wrap.className='person';wrap.style.width='min(220px,100%)';wrap.style.padding='8px';
      const label=document.createElement('div');label.textContent=person?person.name:'Ishtirokchi';label.style.marginBottom='5px';
      video=document.createElement('video');video.id='call-'+peerId;video.autoplay=true;video.playsInline=true;video.style.width='100%';video.style.borderRadius='8px';video.style.background='#000';
      wrap.append(label,video);$('callGrid').append(wrap);
    }
    video.srcObject=e.streams[0];video.play().catch(()=>{});
  };
  pc.onconnectionstatechange=()=>{if(['failed','closed'].includes(pc.connectionState))removeCallPeer(peerId)};
  return pc;
}
async function syncCallPeers(){
  if(!callStream||!roomId)return;
  for(const person of roomPeople){
    if(person.id===socket.id||!callReady.has(person.id)||callPeers.has(person.id))continue;
    if(socket.id.localeCompare(person.id)<=0)continue;
    try{
      const pc=callPeer(person.id,true);
      const offer=await pc.createOffer();await pc.setLocalDescription(offer);
      socket.emit('rtc:offer',{to:person.id,kind:'call',offer:pc.localDescription});
    }catch(e){removeCallPeer(person.id)}
  }
}
async function answerCallOffer(p){
  if(!roomId||!p.from||!p.offer)return;
  try{
    const pc=callPeer(p.from,false);
    await pc.setRemoteDescription(new RTCSessionDescription(p.offer));
    await flushIce('call',p.from,pc);
    if(callStream)callStream.getTracks().forEach(track=>{if(!pc.getSenders().some(s=>s.track===track))pc.addTrack(track,callStream)});
    const answer=await pc.createAnswer();await pc.setLocalDescription(answer);
    socket.emit('rtc:answer',{to:p.from,kind:'call',answer:pc.localDescription});
  }catch(e){removeCallPeer(p.from);$('callStatus').textContent='Qo‘ng‘iroqqa ulanishda xatolik yuz berdi.'}
}
function removeCallPeer(peerId){
  const pc=callPeers.get(peerId);if(pc){try{pc.close()}catch(e){}callPeers.delete(peerId)}
  pendingCallIce.delete(peerId);
  const video=document.getElementById('call-'+peerId);if(video&&video.parentElement)video.parentElement.remove();
}
socket.on('rtc:ready',p=>{
  if(!p||!p.from)return;
  if(p.ready)callReady.add(p.from);else{callReady.delete(p.from);removeCallPeer(p.from)}
  if(callStream)syncCallPeers();
});
function updateCallControls(){
  const audio=callStream&&callStream.getAudioTracks()[0],video=callStream&&callStream.getVideoTracks()[0];
  $('toggleMic').disabled=!audio;$('toggleCamera').disabled=!video;
  $('toggleMic').textContent=audio&&audio.enabled?'🎙 Mikrofonni o‘chirish':'🔇 Mikrofonni yoqish';
  $('toggleCamera').textContent=video&&video.enabled?'📷 Kamerani o‘chirish':'📷 Kamerani yoqish';
}
$('toggleMic').onclick=()=>{const t=callStream&&callStream.getAudioTracks()[0];if(t){t.enabled=!t.enabled;updateCallControls()}};
$('toggleCamera').onclick=()=>{const t=callStream&&callStream.getVideoTracks()[0];if(t){t.enabled=!t.enabled;updateCallControls()}};
$('startCall').onclick=async()=>{
  if(!roomId)return;
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){$('callStatus').textContent='Bu brauzer kamera/mikrofon ruxsatini qo‘llamaydi. HTTPS orqali oching.';return}
  try{callStream=await navigator.mediaDevices.getUserMedia({audio:true,video:true})}
  catch(e){try{callStream=await navigator.mediaDevices.getUserMedia({audio:true,video:false})}
    catch(err){$('callStatus').textContent='Kamera yoki mikrofon uchun ruxsat berilmadi.';return}}
  $('localCallVideo').srcObject=callStream;
  $('callControls').classList.remove('hidden');updateCallControls();
  $('localCallWrap').classList.remove('hidden');
  $('startCall').classList.add('hidden');$('stopCall').classList.remove('hidden');
  $('callStatus').textContent='Suhbat yoqildi. Boshqa ishtirokchilar ham suhbatga qo‘shilganda ulanadi.';
  callReady.add(socket.id);socket.emit('rtc:ready',{ready:true});
  await syncCallPeers();
};
$('stopCall').onclick=stopCall;
function stopCall(){
  socket.emit('rtc:ready',{ready:false});callReady.delete(socket.id);
  if(callStream){callStream.getTracks().forEach(t=>{try{t.stop()}catch(e){}});callStream=null}
  for(const id of Array.from(callPeers.keys()))removeCallPeer(id);
  $('localCallVideo').srcObject=null;$('localCallWrap').classList.add('hidden');$('callControls').classList.add('hidden');updateCallControls();
  $('startCall').classList.remove('hidden');$('stopCall').classList.add('hidden');
  $('callStatus').textContent='Suhbatdan chiqdingiz.';
}

socket.on('screen:started',p=>{
  if(!p||!p.from)return;screenOwner=p.from;
  $('screenShare').disabled=screenOwner!==socket.id;
  $('screenStatus').textContent=screenOwner===socket.id?'Ekraningiz ulashilmoqda.':'Ekran '+(p.name||'ishtirokchi')+' tomonidan ulashilmoqda.';
});
socket.on('screen:error',message=>{
  if(screenStream){screenStream.getTracks().forEach(t=>{try{t.stop()}catch(e){}});screenStream=null}
  screenOwner=null;$('screenShare').disabled=false;$('screenShare').classList.remove('hidden');$('stopScreenShare').classList.add('hidden');
  $('screenStatus').textContent=typeof message==='string'?message:'Ekran ulashilmadi.';
});
socket.on('screen:stop',p=>{
  if(!p||p.from===socket.id)return;
  removePeer(p.from);screenOwner=null;$('screenShare').disabled=false;
  $('sharedScreen').srcObject=null;
  $('sharedScreenWrap').classList.add('hidden');
  $('screenStatus').textContent='Ekran ulashish to‘xtatildi.';
});
async function stopScreenShare(){
  if(screenStream){
    socket.emit('screen:stop');
    screenStream.getTracks().forEach(t=>{try{t.stop()}catch(e){}});
    screenStream=null;screenOwner=null;$('screenShare').disabled=false;
  }
  for(const id of Array.from(peers.keys()))removePeer(id);
  $('sharedScreen').srcObject=null;
  $('sharedScreenWrap').classList.add('hidden');
  $('screenShare').classList.remove('hidden');
  $('stopScreenShare').classList.add('hidden');
  $('screenStatus').textContent='Ekran ulashish to‘xtatildi.';
}
$('screenShare').onclick=async()=>{
  if(screenOwner&&screenOwner!==socket.id){$('screenStatus').textContent='Boshqa ishtirokchi hozir ekran ulashyapti.';return}
  if(!navigator.mediaDevices||!navigator.mediaDevices.getDisplayMedia){$('screenStatus').textContent='Bu brauzer ekran ulashishni qo‘llamaydi. Kompyuterdagi Chrome yoki Edge’da urinib ko‘ring.';return}
  try{
    screenStream=await navigator.mediaDevices.getDisplayMedia({video:true,audio:true});
    $('sharedScreen').srcObject=screenStream;
    $('sharedScreenWrap').classList.remove('hidden');
    $('screenShare').classList.add('hidden');
    $('stopScreenShare').classList.remove('hidden');
    screenOwner=socket.id;socket.emit('screen:started');
    $('screenStatus').textContent='Ekraningiz ulashilmoqda. Ovoz uzatilishi brauzer va tanlangan tabga bog‘liq.';
    screenStream.getTracks().forEach(t=>t.addEventListener('ended',stopScreenShare,{once:true}));
    await syncScreenPeers();
  }catch(e){
    screenStream=null;
    $('screenStatus').textContent='Ekran ulashish bekor qilindi yoki ruxsat berilmadi.';
  }
};
$('stopScreenShare').onclick=stopScreenShare;

const r=new URLSearchParams(location.search).get('room');if(r)$('roomInput').value=r.toUpperCase();
$('year').textContent=new Date().getFullYear();
})();