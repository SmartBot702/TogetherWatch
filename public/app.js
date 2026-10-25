(function(){
const $=id=>document.getElementById(id);
const socket=io();
let rtcIceServers=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun.cloudflare.com:3478'}];
fetch('/api/rtc-config',{cache:'no-store'}).then(r=>r.ok?r.json():null).then(c=>{if(c&&Array.isArray(c.iceServers)&&c.iceServers.length)rtcIceServers=c.iceServers}).catch(()=>{});
let roomId=null,myName='',isHost=false,player=null,playerReady=false,media=null,remote=false,remoteUntil=0,roomPeople=[],screenStream=null,callStream=null,siteUrl=null,siteExpanded=false,screenOwner=null,hlsInstance=null,queueItems=[],volume=1,muted=false,seekDuration=0,seeking=false;const peers=new Map(),callPeers=new Map(),callReady=new Set(),pendingScreenIce=new Map(),pendingCallIce=new Map();

socket.on('connect',()=>{
  $('connection').textContent='● Serverga ulandi';
  if(roomId&&myName){$('connection').textContent='● Xonaga qayta ulanmoqda…';socket.emit('room:join',{roomId,name:myName})}
});
socket.on('disconnect',()=>{
  $('connection').textContent='● Aloqa uzildi — qayta ulanish kutilmoqda';
  for(const id of Array.from(peers.keys()))removePeer(id);
  for(const id of Array.from(callPeers.keys()))removeCallPeer(id);
  callReady.clear();
});
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
  $('loadVideo').disabled=false;$('youtubeUrl').disabled=false;$('mediaType').disabled=false;$('screenShare').disabled=!!screenOwner&&screenOwner!==socket.id;$('chat').replaceChildren();
  for(const timer of typingTimers.values())clearTimeout(timer);typingTimers.clear();typingUsers.clear();renderTyping();
  history.replaceState({},'',location.pathname+'?room='+roomId);
  renderQueue(d.queue||[]);
  (d.chatHistory||[]).forEach(renderChatMessage);
  if(d.state&&(d.state.mediaType||d.state.videoId))loadMedia(normalizeState(d.state),d.state);
  if(screenStream){screenOwner=socket.id;socket.emit('screen:started');}
  if(callStream){callReady.clear();callReady.add(socket.id);socket.emit('rtc:ready',{ready:true});}
});
socket.on('room:role',d=>{
  isHost=d.isHost;$('role').textContent=isHost?'Xona egasi':'Ishtirokchi';
  $('loadVideo').disabled=false;$('youtubeUrl').disabled=false;$('mediaType').disabled=false;$('screenShare').disabled=!!screenOwner&&screenOwner!==socket.id;
  ['playPause','back','forward'].forEach(id=>$(id).disabled=!playerReady);
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
function renderChatMessage(m){
  const e=document.createElement('div');e.className='message';
  const header=document.createElement('div');header.className='message-header';
  const b=document.createElement('b');b.textContent=m.name;
  const time=document.createElement('time');time.className='message-time';time.dateTime=new Date(Number(m.at)||Date.now()).toISOString();time.textContent=new Date(Number(m.at)||Date.now()).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  header.append(b,time);
  const p=document.createElement('p');p.textContent=m.text;e.append(header,p);$('chat').append(e);
}
const typingUsers=new Map(),typingTimers=new Map();
function renderTyping(){const names=Array.from(typingUsers.values());$('typingIndicator').textContent=names.length?names.join(', ')+' yozmoqda…':''}
socket.on('chat:typing',d=>{
  if(!d||!d.from||d.from===socket.id)return;
  const previous=typingTimers.get(d.from);if(previous)clearTimeout(previous);
  if(d.typing){
    typingUsers.set(d.from,d.name||'Ishtirokchi');
    const timer=setTimeout(()=>{typingUsers.delete(d.from);typingTimers.delete(d.from);renderTyping()},1800);
    typingTimers.set(d.from,timer);
  }else{typingUsers.delete(d.from);typingTimers.delete(d.from)}
  renderTyping();
});
let typingStopTimer=null,lastTypingSent=0;
$('chatText').addEventListener('input',()=>{
  if(!roomId)return;
  const now=Date.now();
  if($('chatText').value.trim()&&now-lastTypingSent>700){socket.emit('chat:typing',{typing:true});lastTypingSent=now}
  clearTimeout(typingStopTimer);
  typingStopTimer=setTimeout(()=>{if(roomId)socket.emit('chat:typing',{typing:false})},1100);
});
socket.on('chat:message',m=>{renderChatMessage(m);scroll()});
$('chatForm').onsubmit=e=>{e.preventDefault();const text=$('chatText').value.trim();if(text&&roomId){socket.emit('chat:send',{text});socket.emit('chat:typing',{typing:false});$('chatText').value='';clearTimeout(typingStopTimer)}};
let renderedSiteUrl=null;
function renderSharedSite(url,expanded){
  siteUrl=url||null;siteExpanded=Boolean(expanded);
  const wrap=$('sharedSiteWrap');
  if(!siteUrl){wrap.classList.add('hidden');renderedSiteUrl=null;return}
  wrap.classList.remove('hidden');
  if(renderedSiteUrl!==siteUrl){$('sharedSiteFrame').src=siteUrl;$('siteUrlInput').value=siteUrl;renderedSiteUrl=siteUrl}
  wrap.classList.toggle('site-expanded',siteExpanded);
  $('siteExpand').textContent=siteExpanded?'Kichraytirish (hamma uchun)':'Hamma uchun kattalashtirish';
  $('openSite').textContent='Brauzerda ochish';
  $('siteStatus').textContent='Umumiy sahifa: '+siteUrl+'. Agar sayt ichki oynada ochilmasa, “Brauzerda ochish”ni bosing. Har bir ishtirokchi sahifani o‘z brauzerida ochadi; video uchun saytning ochiq MP4/WebM/HLS havolasini ulashsangiz, ijro ham sinxronlanadi.';
}
$('shareSite').onclick=async()=>{
  let u;
  try{u=new URL($('siteUrlInput').value.trim());if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw new Error('protocol')}
  catch(e){$('siteStatus').textContent='To‘liq ochiq https:// yoki http:// havolasini kiriting.';return}
  const direct=parseMedia(u.href);
  if(direct){socket.emit('video:load',direct);$('siteStatus').textContent='Video barcha ishtirokchilar uchun sinxron ulandi.';return}
  $('shareSite').disabled=true;
  $('siteStatus').textContent='Sahifa tekshirilmoqda: video oqimi topilsa, hamma uchun sinxron ijro qilinadi…';
  try{
    const response=await fetch('/api/extract?url='+encodeURIComponent(u.href),{cache:'no-store'});
    const result=await response.json();
    if(result.ok&&result.mediaUrl){
      const found={mediaType:result.mediaType,mediaId:result.mediaUrl,mediaUrl:result.mediaUrl,videoId:null};
      socket.emit('video:load',found);
      $('siteStatus').textContent='Sahifadan video oqimi topildi va sinxron ijro uchun ulandi.';
      return;
    }
    socket.emit('site:share',{url:u.href});
    $('siteStatus').textContent='Sahifa xona bilan ulashildi. Ichki oynada bloklansa, “Brauzerda ochish” orqali har bir ishtirokchi o‘z brauzerida ochishi mumkin. Saytning ichki navigatsiyasi va DRM bilan himoyalangan videosi tashqi sayt ruxsatisiz masofadan boshqarilmaydi.';
  }catch(e){
    socket.emit('site:share',{url:u.href});
    $('siteStatus').textContent='Sahifa havolasi ulashildi. Ichki oynada ochilmasa, “Brauzerda ochish”ni bosing. Video sinxronligi uchun to‘g‘ridan-to‘g‘ri video havolasi kerak bo‘lishi mumkin.';
  }finally{$('shareSite').disabled=false}
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
    if(($('mediaType').value==='auto'||$('mediaType').value==='hls')&&/\.m3u8$/i.test(u.pathname))return{mediaType:'hls',mediaId:u.href,mediaUrl:u.href,videoId:null};
    return null;
  }catch(e){return null}
}
function normalizeState(s){
  if(s.mediaType&&s.mediaId)return{mediaType:s.mediaType,mediaId:s.mediaId,mediaUrl:s.mediaUrl||s.mediaId,videoId:s.videoId||null};
  if(s.videoId)return{mediaType:'youtube',mediaId:s.videoId,mediaUrl:'https://www.youtube.com/watch?v='+s.videoId,videoId:s.videoId};
  return null;
}
function destroyPlayer(){
  if(hlsInstance){try{hlsInstance.destroy()}catch(e){}hlsInstance=null}
  if(player){
    try{if(media&&media.mediaType==='youtube'&&player.destroy)player.destroy();else if(media&&media.mediaType==='vimeo'&&player.destroy)player.destroy();else if(media&&media.mediaType==='file'){player.pause();player.removeAttribute('src');player.load()}}catch(e){}
  }
  $('player').replaceChildren();player=null;playerReady=false;media=null;
  $('placeholder').classList.remove('hidden');
  ['playPause','back','forward','muteToggle','volume','videoFullscreen','seekRange'].forEach(id=>$(id).disabled=true);
  $('seekRange').value='0';$('currentTime').textContent='0:00';$('duration').textContent='0:00';seekDuration=0;seeking=false;
}
function markReady(state){
  playerReady=true;
  ['playPause','back','forward','muteToggle','volume','videoFullscreen'].forEach(k=>$(k).disabled=false);
  $('placeholder').classList.add('hidden');
  $('playState').textContent='Tayyor';
  applyVolume();
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
      onStateChange:e=>{if(remote||Date.now()<remoteUntil)return;if(e.data===YT.PlayerState.ENDED){if(isHost)socket.emit('queue:next');return}if(e.data===YT.PlayerState.PLAYING||e.data===YT.PlayerState.PAUSED)emitPlayback(e.data===YT.PlayerState.PLAYING,getTime())},
      onError:()=>{$('videoError').textContent='YouTube videosini ochib bo‘lmadi.'}
    }});
  }else if(next.mediaType==='vimeo'){
    const frame=document.createElement('iframe');frame.id='vimeoPlayer';frame.src=next.mediaUrl+'?controls=0&title=0&byline=0&portrait=0';frame.allow='autoplay; fullscreen; picture-in-picture';frame.allowFullscreen=true;frame.title='Vimeo video';$('player').append(frame);
    const init=()=>{if(!window.Vimeo||!window.Vimeo.Player){setTimeout(init,150);return}
      player=new Vimeo.Player(frame);
      player.ready().then(()=>markReady(state)).catch(()=>{$('videoError').textContent='Vimeo videosini ochib bo‘lmadi yoki video maxfiy.'});
      player.on('play',()=>{if(!remote&&Date.now()>=remoteUntil)getTimeAsync().then(t=>emitPlayback(true,t))});
      player.on('pause',()=>{if(!remote&&Date.now()>=remoteUntil)getTimeAsync().then(t=>emitPlayback(false,t))});
       player.on('ended',()=>{if(isHost)socket.emit('queue:next')});
    };init();
  }else if(next.mediaType==='file'||next.mediaType==='hls'){
    const video=document.createElement('video');video.id='filePlayer';video.playsInline=true;video.preload='auto';video.controls=false;video.style.width='100%';video.style.height='100%';video.style.position='absolute';video.style.inset='0';if(next.mediaType==='hls')video.crossOrigin='anonymous';$('player').append(video);player=video;
    const ready=()=>markReady(state);
    if(next.mediaType==='hls'&&window.Hls&&Hls.isSupported()){
      hlsInstance=new Hls({enableWorker:true,lowLatencyMode:false,backBufferLength:30});hlsInstance.loadSource(next.mediaUrl);hlsInstance.attachMedia(video);
      hlsInstance.on(Hls.Events.MANIFEST_PARSED,ready);
      hlsInstance.on(Hls.Events.ERROR,(_event,data)=>{if(data&&data.fatal)$('videoError').textContent='HLS oqimini ochib bo‘lmadi. Sayt CORS yoki maxsus token talab qilishi mumkin.'});
    }else{video.src=next.mediaUrl;video.addEventListener('loadedmetadata',ready,{once:true})}
    video.addEventListener('error',()=>{$('videoError').textContent='Videoni ochib bo‘lmadi. Havola ochiq bo‘lishi va sayt CORS orqali ijroga ruxsat berishi kerak.'});
    video.addEventListener('play',()=>{if(!remote&&Date.now()>=remoteUntil)emitPlayback(true,video.currentTime)});
    video.addEventListener('pause',()=>{if(!remote&&Date.now()>=remoteUntil&&!video.ended)emitPlayback(false,video.currentTime)});
    video.addEventListener('seeked',()=>{if(!remote&&Date.now()>=remoteUntil)emitPlayback(!video.paused,video.currentTime)});
     video.addEventListener('ended',()=>{if(isHost)socket.emit('queue:next')});
  }
}
function getTime(){
  if(!player||!playerReady)return 0;
  try{if(media.mediaType==='youtube')return player.getCurrentTime()||0;if(media.mediaType==='file'||media.mediaType==='hls')return player.currentTime||0}catch(e){}
  return 0;
}
async function getTimeAsync(){
  if(!player||!playerReady)return 0;
  try{if(media.mediaType==='vimeo')return await player.getCurrentTime();return getTime()}catch(e){return 0}
}
async function getDurationAsync(){
  if(!player||!playerReady||!media)return 0;
  try{
    if(media.mediaType==='youtube')return Number(player.getDuration())||0;
    if(media.mediaType==='vimeo')return Number(await player.getDuration())||0;
    if(media.mediaType==='file'||media.mediaType==='hls')return Number.isFinite(player.duration)?player.duration:0;
  }catch(e){}
  return 0;
}
function formatTime(value){
  const seconds=Math.max(0,Math.floor(Number(value)||0));
  const h=Math.floor(seconds/3600),m=Math.floor((seconds%3600)/60),s=seconds%60;
  return h?`${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`:`${m}:${String(s).padStart(2,'0')}`;
}
async function updatePlayerTimeline(){
  if(!playerReady||!player||!media)return;
  const [current,total]=await Promise.all([getTimeAsync(),getDurationAsync()]);
  if(!Number.isFinite(total)||total<=0)return;
  seekDuration=total;
  $('duration').textContent=formatTime(total);
  if(!seeking){$('seekRange').value=String(Math.min(100,Math.max(0,current/total*100)));$('currentTime').textContent=formatTime(current)}
  $('seekRange').disabled=false;
}
async function isPlaying(){
  if(!player||!playerReady)return false;
  try{if(media.mediaType==='youtube')return player.getPlayerState()===YT.PlayerState.PLAYING;if(media.mediaType==='file'||media.mediaType==='hls')return !player.paused;if(media.mediaType==='vimeo')return (await player.getPaused())===false}catch(e){}
  return false;
}
async function applyVolume(){
  if(!player||!playerReady||!media)return;
  const value=Math.max(0,Math.min(1,Number(volume)||0));
  try{
    if(media.mediaType==='youtube'){
      player.setVolume(Math.round(value*100));
      if(muted||value===0)player.mute();else player.unMute();
    }else if(media.mediaType==='vimeo'){
      await player.setVolume(value);
      await player.setMuted(Boolean(muted||value===0));
    }else{
      player.volume=value;player.muted=Boolean(muted||value===0);
    }
  }catch(e){}
  $('muteToggle').textContent=(muted||value===0)?'🔇 Ovozni yoqish':'🔊 Ovozni o‘chirish';
  $('volume').value=String(value);
}
$('muteToggle').onclick=()=>{muted=!muted;applyVolume()};
$('seekRange').addEventListener('input',e=>{
  seeking=true;
  const target=seekDuration*(Number(e.target.value)||0)/100;
  $('currentTime').textContent=formatTime(target);
});
$('seekRange').addEventListener('change',async e=>{
  if(!seekDuration){seeking=false;return}
  const target=seekDuration*(Number(e.target.value)||0)/100;
  await seekTo(target);
  emitPlayback(await isPlaying(),target);
  seeking=false;
});
setInterval(updatePlayerTimeline,1000);
$('volume').addEventListener('input',e=>{volume=Math.max(0,Math.min(1,Number(e.target.value)||0));if(volume>0)muted=false;applyVolume()});
$('videoFullscreen').onclick=async()=>{
  try{
    if(document.fullscreenElement)await document.exitFullscreen();
    else if($('video').requestFullscreen)await $('video').requestFullscreen();
    else $('videoError').textContent='Bu brauzer to‘liq ekran rejimini qo‘llamaydi.';
  }catch(e){$('videoError').textContent='To‘liq ekran rejimiga o‘tib bo‘lmadi.'}
};
document.addEventListener('fullscreenchange',()=>{$('videoFullscreen').textContent=document.fullscreenElement?'⤢ Ekrandan chiqish':'⛶ To‘liq ekran'});
function emitPlayback(playing,time){
  if(!media||!roomId)return;
  socket.emit('video:state',{mediaType:media.mediaType,mediaId:media.mediaId,mediaUrl:media.mediaUrl,videoId:media.videoId,isPlaying:!!playing,currentTime:Math.max(0,Number(time)||0)});
}
async function seekTo(t){
  if(!player||!playerReady)return;
  const v=Math.max(0,Number(t)||0);
  try{if(media.mediaType==='youtube')player.seekTo(v,true);else if(media.mediaType==='file'||media.mediaType==='hls')player.currentTime=v;else if(media.mediaType==='vimeo')await player.setCurrentTime(v)}catch(e){}
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
function renderQueue(items){
  queueItems=Array.isArray(items)?items:[];
  const list=$('videoQueue');list.replaceChildren();
  $('queueCount').textContent=String(queueItems.length);
  $('queueNext').disabled=queueItems.length===0;
  if(!queueItems.length){const empty=document.createElement('div');empty.className='muted small';empty.textContent='Navbat hozircha bo‘sh.';list.append(empty);return}
  queueItems.forEach((item,index)=>{
    const row=document.createElement('div');row.className='queue-item';
    const details=document.createElement('div');details.className='queue-details';
    const title=document.createElement('strong');
    let label=(item.mediaType||'video').toUpperCase();
    if(item.mediaType==='youtube')label='YouTube · '+item.mediaId;
    else if(item.mediaType==='vimeo')label='Vimeo · '+item.mediaId;
    else{try{label=(item.mediaType||'VIDEO').toUpperCase()+' · '+new URL(item.mediaUrl).hostname}catch(e){}}
    title.textContent=(index+1)+'. '+label;
    const by=document.createElement('div');by.className='muted small';by.textContent='Qo‘shdi: '+(item.addedBy||'ishtirokchi');
    details.append(title,by);
    const actions=document.createElement('div');actions.className='queue-actions';
    const playButton=document.createElement('button');playButton.className='btn primary';playButton.textContent='▶';playButton.title='Hozir ijro etish';playButton.onclick=()=>socket.emit('queue:play',{queueId:item.queueId});
    const removeButton=document.createElement('button');removeButton.className='btn';removeButton.textContent='×';removeButton.title='Navbatdan olib tashlash';removeButton.onclick=()=>socket.emit('queue:remove',{queueId:item.queueId});
    actions.append(playButton,removeButton);row.append(details,actions);list.append(row);
  });
}
socket.on('queue:updated',renderQueue);
$('queueAdd').onclick=()=>{
  const raw=$('youtubeUrl').value.trim(),next=parseMedia(raw);
  if(!next){$('queueMessage').textContent='Navbatga YouTube, Vimeo, MP4/WebM yoki .m3u8 to‘g‘ridan-to‘g‘ri havolasini kiriting.';return}
  $('queueMessage').textContent='Video navbatga qo‘shilmoqda…';socket.emit('queue:add',next);
};
$('queueNext').onclick=()=>{if(queueItems.length)socket.emit('queue:play',{queueId:queueItems[0].queueId})};
$('loadVideo').onclick=async()=>{
  const raw=$('youtubeUrl').value.trim(),next=parseMedia(raw);
  if(next){socket.emit('video:load',next);return}
  let u;try{u=new URL(raw);if(!['http:','https:'].includes(u.protocol))throw new Error('protocol')}catch(e){$('videoError').textContent='To‘liq https:// yoki http:// havolasini kiriting.';return}
  $('videoError').textContent='Saytdagi video havolasi qidirilmoqda…';$('playState').textContent='Sayt tekshirilmoqda…';$('loadVideo').disabled=true;
  try{
    const response=await fetch('/api/extract?url='+encodeURIComponent(u.href)),result=await response.json();
    if(result.ok&&result.mediaUrl){const found={mediaType:result.mediaType,mediaId:result.mediaUrl,mediaUrl:result.mediaUrl,videoId:null};$('videoError').textContent='Video havolasi topildi. Hamma uchun ulanyapti…';socket.emit('video:load',found);return}
    socket.emit('site:share',{url:u.href});$('videoError').textContent=(result.error?'Sayt server orqali tekshirishga ruxsat bermadi: '+result.error+' ':'Ochiq video oqimi topilmadi. ')+'Havola xona bilan ulashildi. Ichki oyna bloklansa, “Brauzerda ochish”ni bosing. Boshqa saytning ichki navigatsiyasi va himoyalangan videosi har doim ham sinxron boshqarilmaydi.';$('playState').textContent='Tashqi sayt';
  }catch(e){socket.emit('site:share',{url:u.href});$('videoError').textContent='Sayt havolasi ulashildi, ammo video oqimini avtomatik aniqlab bo‘lmadi. “Brauzerda ochish”ni bosing yoki sahifadagi ochiq MP4/WebM/HLS video havolasini kiriting.';}
  finally{$('loadVideo').disabled=false}
};
socket.on('video:loaded',s=>{const next=normalizeState(s);if(next)loadMedia(next,s)});
socket.on('video:state',s=>{const next=normalizeState(s);if(next&&(!media||next.mediaType!==media.mediaType||next.mediaId!==media.mediaId))loadMedia(next,s);else applyState(s)});
$('playPause').onclick=async()=>{
  if(!playerReady)return;
  const playing=await isPlaying(),t=await getTimeAsync();
  if(playing)await pause();else await play();
  emitPlayback(!playing,t);
};
async function seek(d){
  if(!playerReady)return;
  const t=Math.max(0,(await getTimeAsync())+d);
  await seekTo(t);emitPlayback(await isPlaying(),t);
}
$('back').onclick=()=>seek(-10);$('forward').onclick=()=>seek(10);
document.addEventListener('keydown',e=>{
  if(!roomId||!playerReady||e.altKey||e.ctrlKey||e.metaKey)return;
  const target=e.target;
  if(target&&target.closest&&target.closest('input,textarea,select,button,[contenteditable="true"]'))return;
  if(e.code==='Space'){e.preventDefault();$('playPause').click()}
  else if(e.code==='ArrowLeft'){e.preventDefault();seek(-10)}
  else if(e.code==='ArrowRight'){e.preventDefault();seek(10)}
  else if(e.key.toLowerCase()==='m')$('muteToggle').click();
  else if(e.key.toLowerCase()==='f')$('videoFullscreen').click();
});
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
  const pc=new RTCPeerConnection({iceServers:rtcIceServers});
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
  const pc=new RTCPeerConnection({iceServers:rtcIceServers});
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


let authMode='login',currentAccount=null,activeSection='home';
function setSection(section){
  activeSection=section;
  const buttons={home:'navHome',friends:'navFriends',watch:'navWatch',profile:'navProfile'};
  Object.entries(buttons).forEach(([key,id])=>$(id).setAttribute('aria-current',key===section?'true':'false'));
  $('friendsPanel').classList.toggle('hidden',section!=='friends');
  $('accountPanel').classList.toggle('hidden',section!=='profile'&&Boolean(currentAccount));
  $('heroTitle').parentElement.classList.toggle('hidden',section==='friends'||section==='profile');
  $('entry').classList.toggle('hidden',(section!=='home'&&section!=='watch')||Boolean(roomId));
  $('how').classList.toggle('hidden',section!=='home'||Boolean(roomId));
  if(section==='watch'&&!roomId)$('entry').classList.remove('hidden');
  if(section==='profile')$('accountPanel').classList.remove('hidden');
}
$('navHome').onclick=()=>setSection('home');
$('navFriends').onclick=()=>{setSection('friends');if(!currentAccount)$('friendsMessage').textContent='Do‘stlarni qidirish uchun akkauntga kiring.';else refreshFriends()};
$('navWatch').onclick=()=>setSection('watch');
$('navProfile').onclick=()=>setSection('profile');
let activeChatUserId=null,activeChatUser=null,lastMessageSignature='';
async function refreshFriends(){
  if(!currentAccount)return;
  try{
    const r=await fetch('/api/friends',{credentials:'same-origin'}),d=await r.json();
    if(!r.ok||!d.ok)throw new Error(d.error||'Xatolik');
    $('friendLists').replaceChildren();
    const heading=label=>{const h=document.createElement('h4');h.className='muted small';h.style.margin='8px 4px 2px';h.textContent=label;$('friendLists').append(h)};
    heading('DO‘STLAR');
    if(!d.friends.length){const p=document.createElement('div');p.className='muted small';p.textContent='Hozircha do‘st yo‘q.';$('friendLists').append(p)}
    d.friends.forEach(u=>{
      const el=document.createElement('div');el.className='person';
      const info=document.createElement('div');info.className='friend-name';
      const strong=document.createElement('strong');strong.textContent=u.displayName;
      const small=document.createElement('div');small.className='muted small';small.textContent='@'+u.username;
      info.append(strong,small);
      const btn=document.createElement('button');btn.className='btn primary';btn.textContent='Xabar';btn.onclick=()=>openDirectChat(u);
      el.append(info,btn);$('friendLists').append(el);
    });
    heading('KELGAN SO‘ROVLAR');
    if(!d.incoming.length){const p=document.createElement('div');p.className='muted small';p.textContent='Yangi so‘rov yo‘q.';$('friendLists').append(p)}
    d.incoming.forEach(item=>{
      const row=document.createElement('div');row.className='person';
      const label=document.createElement('span');label.textContent=item.user.displayName+' @'+item.user.username;
      const actions=document.createElement('div');actions.className='friend-actions';
      const yes=document.createElement('button');yes.className='btn primary';yes.textContent='Qabul';yes.onclick=()=>respondFriend(item.id,true);
      const no=document.createElement('button');no.className='btn';no.textContent='Rad etish';no.onclick=()=>respondFriend(item.id,false);
      actions.append(yes,no);row.append(label,actions);$('friendLists').append(row);
    });
  }catch(e){$('friendsMessage').textContent=e.message||'Do‘stlar yuklanmadi.'}
}
async function respondFriend(requestId,accept){
  try{const r=await fetch('/api/friends/respond',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({requestId,accept})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Xatolik');$('friendsMessage').textContent=accept?'Do‘st qo‘shildi.':'So‘rov rad etildi.';await refreshFriends()}
  catch(e){$('friendsMessage').textContent=e.message||'Xatolik'}
}
function openDirectChat(user){
  activeChatUserId=user.id;activeChatUser=user;lastMessageSignature='';
  $('dmTitle').textContent=user.displayName;$('dmSubtitle').textContent='@'+user.username;
  $('dmInput').disabled=false;$('dmSend').disabled=false;$('dmInput').focus();
  loadMessages(true);
}
function renderMessages(messages){
  const signature=messages.map(m=>m.id).join('|');
  if(signature===lastMessageSignature)return;
  lastMessageSignature=signature;
  const box=$('dmMessages');box.replaceChildren();
  if(!messages.length){const empty=document.createElement('div');empty.className='chat-empty';empty.textContent='Birinchi xabarni yuboring 👋';box.append(empty);return}
  messages.forEach(m=>{
    const bubble=document.createElement('div');bubble.className='dm-bubble'+(m.from===currentAccount.id?' mine':'');
    const body=document.createElement('div');body.textContent=m.text;
    const meta=document.createElement('span');meta.className='dm-meta';
    const time=new Date(m.createdAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    meta.textContent=(m.from===currentAccount.id?'Siz':'')+' · '+time;
    bubble.append(body,meta);box.append(bubble);
  });
  box.scrollTop=box.scrollHeight;
}
async function loadMessages(force){
  if(!currentAccount||!activeChatUserId)return;
  try{
    const r=await fetch('/api/messages/'+encodeURIComponent(activeChatUserId),{credentials:'same-origin'}),d=await r.json();
    if(!r.ok||!d.ok)throw new Error(d.error||'Xabarlar yuklanmadi.');
    renderMessages(d.messages);
    if(force)$('dmError').textContent='';
  }catch(e){$('dmError').textContent=e.message||'Xabarlar yuklanmadi.'}
}
socket.on('dm:message',message=>{
  if(!currentAccount||!message)return;
  const belongsToOpenChat=activeChatUserId&&((message.from===currentAccount.id&&message.to===activeChatUserId)||(message.from===activeChatUserId&&message.to===currentAccount.id));
  if(belongsToOpenChat){lastMessageSignature='';loadMessages(false)}
  else if(message.to===currentAccount.id){$('dmStatus').textContent='Yangi xabar';}
});
$('dmForm').onsubmit=e=>{
  e.preventDefault();
  const text=$('dmInput').value.trim();if(!text||!activeChatUserId||!currentAccount)return;
  $('dmSend').disabled=true;$('dmError').textContent='';
  socket.emit('dm:send',{to:activeChatUserId,text},result=>{
    if(!result||!result.ok){$('dmError').textContent=result&&result.error?result.error:'Xabar yuborilmadi.';$('dmSend').disabled=false;return}
    $('dmInput').value='';$('dmSend').disabled=false;
  });
}
function showAccount(user){
  currentAccount=user||null;
  $('authState').textContent=user?'Akkaunt faol':'Mehmon';
  $('accountSignedIn').classList.toggle('hidden',!user);
  $('authForm').classList.toggle('hidden',Boolean(user));
  if(user){
    $('accountDisplayName').textContent=user.displayName;
    $('accountUsername').textContent='@'+user.username;
    $('profileDisplayName').value=user.displayName||'';
    $('profileAvatar').value=user.avatar||'';
    $('profileBio').value=user.bio||'';
    $('accountAvatar').textContent=(user.displayName||user.username||'TW').slice(0,2).toUpperCase();
    if(user.avatar){const img=document.createElement('img');img.src=user.avatar;img.alt='';img.onerror=()=>img.remove();$('accountAvatar').replaceChildren(img)}
    else $('accountAvatar').textContent=(user.displayName||user.username||'TW').slice(0,2).toUpperCase();
    $('nickname').value=user.displayName||user.username;
    if(activeSection==='friends')refreshFriends();
  }
}
function setAuthMode(mode){
  authMode=mode;
  $('authDisplayName').classList.toggle('hidden',mode!=='register');
  $('authDisplayName').required=mode==='register';
  $('authPassword').autocomplete=mode==='register'?'new-password':'current-password';
  $('authSubmit').textContent=mode==='register'?'Akkaunt yaratish':'Kirish';
  $('authModeToggle').textContent=mode==='register'?'Kirishga qaytish':'Akkaunt yaratish';
  $('authMessage').textContent='';
}
$('authModeToggle').onclick=()=>setAuthMode(authMode==='login'?'register':'login');
$('authForm').onsubmit=async e=>{
  e.preventDefault();$('authMessage').textContent='Tekshirilmoqda…';
  const payload={username:$('authUsername').value.trim(),password:$('authPassword').value};
  if(authMode==='register')payload.displayName=$('authDisplayName').value.trim();
  try{
    const response=await fetch('/api/auth/'+(authMode==='register'?'register':'login'),{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify(payload)});
    const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Xatolik yuz berdi.');
    showAccount(data.user);socket.disconnect();socket.connect();$('authPassword').value='';$('authMessage').textContent='';setSection('home');
  }catch(err){$('authMessage').textContent=err.message||'Serverga ulanib bo‘lmadi.'}
};
$('logoutButton').onclick=async()=>{
  await fetch('/api/auth/logout',{method:'POST',credentials:'same-origin'}).catch(()=>{});
  showAccount(null);socket.disconnect();socket.connect();activeChatUserId=null;activeChatUser=null;$('dmInput').disabled=true;$('dmSend').disabled=true;$('dmTitle').textContent='Shaxsiy xabarlar';$('dmSubtitle').textContent='Suhbatni boshlash uchun do‘st tanlang.';$('dmMessages').replaceChildren();setAuthMode('login');$('authMessage').textContent='Akkauntdan chiqildi.';
};
$('saveProfile').onclick=async()=>{
  $('authMessage').textContent='Saqlanmoqda…';
  try{
    const response=await fetch('/api/auth/profile',{method:'PATCH',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({displayName:$('profileDisplayName').value,bio:$('profileBio').value,avatar:$('profileAvatar').value})});
    const data=await response.json();if(!response.ok||!data.ok)throw new Error(data.error||'Saqlab bo‘lmadi.');
    showAccount(data.user);$('authMessage').textContent='Profil saqlandi.';
  }catch(err){$('authMessage').textContent=err.message||'Saqlashda xato.'}
};
async function loadAccount(){
  try{const response=await fetch('/api/auth/me',{credentials:'same-origin'});const data=await response.json();if(data.ok&&data.user)showAccount(data.user)}catch(_){}
}
$('searchUsers').onclick=async()=>{
  if(!currentAccount){$('friendsMessage').textContent='Avval akkauntga kiring.';return}
  const q=$('userSearch').value.trim();$('friendsMessage').textContent='Qidirilmoqda…';$('userResults').replaceChildren();
  try{
    const response=await fetch('/api/users/search?q='+encodeURIComponent(q),{credentials:'same-origin'});const data=await response.json();
    if(!response.ok||!data.ok)throw new Error(data.error||'Qidiruv amalga oshmadi.');
    $('friendsMessage').textContent=data.users.length?String(data.users.length)+' ta foydalanuvchi topildi.':'Foydalanuvchi topilmadi.';
    data.users.forEach(user=>{const card=document.createElement('div');card.className='person';card.style.borderRadius='12px';card.style.padding='12px';const strong=document.createElement('strong');strong.textContent=user.displayName;const small=document.createElement('div');small.className='muted small';small.textContent='@'+user.username;const add=document.createElement('button');add.className='btn primary';add.textContent='Do‘st qo‘shish';add.style.marginTop='8px';add.onclick=async()=>{add.disabled=true;try{const r=await fetch('/api/friends/request',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',body:JSON.stringify({username:user.username})});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'Xatolik');$('friendsMessage').textContent='Do‘stlik so‘rovi yuborildi.'}catch(e){$('friendsMessage').textContent=e.message||'So‘rov yuborilmadi.';add.disabled=false}};card.append(strong,small,add);$('userResults').append(card)});
  }catch(err){$('friendsMessage').textContent=err.message||'Qidiruvda xato.'}
};
$('userSearch').addEventListener('keydown',e=>{if(e.key==='Enter')$('searchUsers').click()});
loadAccount();
setInterval(()=>{if(currentAccount&&activeChatUserId&&activeSection==='friends')loadMessages(false)},15000);

const r=new URLSearchParams(location.search).get('room');if(r)$('roomInput').value=r.toUpperCase();
$('year').textContent=new Date().getFullYear();
})();