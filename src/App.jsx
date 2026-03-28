import { useState, useRef, useEffect, useCallback } from "react";
import { Volume2, VolumeX } from "lucide-react";

const MAX_SLOTS = 5;
const LOOP_DURATION = 5;
const SERVER = "http://localhost:3001";

const COLORS = [
  { bg: "#7F77DD", light: "#EEEDFE", dark: "#3C3489" },
  { bg: "#1D9E75", light: "#E1F5EE", dark: "#085041" },
  { bg: "#D85A30", light: "#FAECE7", dark: "#4A1B0C" },
  { bg: "#D4537E", light: "#FBEAF0", dark: "#4B1528" },
  { bg: "#BA7517", light: "#FAEEDA", dark: "#412402" },
];
const DEMO_USERS = [
  { name: "Ava",   sound: { type: "sawtooth", freq: 80,  dur: 0.3  } },
  { name: "Bilal", sound: { type: "square",   freq: 220, dur: 0.15 } },
  { name: "Cleo",  sound: { type: "sine",     freq: 440, dur: 0.4  } },
  { name: "Dev",   sound: { type: "triangle", freq: 660, dur: 0.2  } },
];

function makeCode(name) {
  const hash = [...name.toUpperCase()].reduce((a,c) => (a*31 + c.charCodeAt(0)) & 0xffff, 0);
  return `${name.toUpperCase().replace(/[^A-Z]/g,"").slice(0,5)||"USER"}-${String(hash).padStart(4,"0").slice(-4)}`;
}

function synthBuffer(ctx, type, freq, dur) {
  const sr = ctx.sampleRate, len = Math.ceil(sr * dur);
  const buf = ctx.createBuffer(1, len, sr);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) {
    const t = i/sr, phase = (t*freq)%1;
    let s = type==="sine" ? Math.sin(2*Math.PI*t*freq)
          : type==="square" ? (phase<0.5?1:-1)
          : type==="sawtooth" ? 2*phase-1
          : phase<0.5 ? 4*phase-1 : 3-4*phase;
    data[i] = s * Math.exp(-t*6) * 0.4;
  }
  return buf;
}

function trimSilence(ctx, buf, threshold=0.01) {
  const data = buf.getChannelData(0);
  let first = 0;
  for (let i=0; i<data.length; i++) { if (Math.abs(data[i])>threshold) { first=i; break; } }
  if (first===0) return buf;
  const out = ctx.createBuffer(buf.numberOfChannels, buf.length-first, buf.sampleRate);
  for (let c=0; c<buf.numberOfChannels; c++) out.copyToChannel(buf.getChannelData(c).slice(first), c);
  return out;
}

function encodeWAV(audioBuf) {
  const numCh = audioBuf.numberOfChannels, numSamples = audioBuf.length, sr = audioBuf.sampleRate;
  const buf = new ArrayBuffer(44 + numSamples * numCh * 2);
  const view = new DataView(buf);
  const str = (off, s) => { for (let i=0;i<s.length;i++) view.setUint8(off+i, s.charCodeAt(i)); };
  str(0,"RIFF"); view.setUint32(4,36+numSamples*numCh*2,true);
  str(8,"WAVE"); str(12,"fmt ");
  view.setUint32(16,16,true); view.setUint16(20,1,true);
  view.setUint16(22,numCh,true); view.setUint32(24,sr,true);
  view.setUint32(28,sr*numCh*2,true); view.setUint16(32,numCh*2,true);
  view.setUint16(34,16,true); str(36,"data");
  view.setUint32(40,numSamples*numCh*2,true);
  let off=44;
  for (let i=0;i<numSamples;i++) for (let ch=0;ch<numCh;ch++) {
    const s=Math.max(-1,Math.min(1,audioBuf.getChannelData(ch)[i]));
    view.setInt16(off,s<0?s*0x8000:s*0x7FFF,true); off+=2;
  }
  return buf;
}

function RecordModal({ onClose, onAudioReady }) {
  const [phase, setPhase] = useState("idle");
  const [countdown, setCountdown] = useState(null);
  const [error, setError] = useState(null);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const countdownRef = useRef(null);
  const streamRef = useRef(null);
  const blobRef = useRef(null);
  const canvasRef = useRef(null);
  const animFrameRef = useRef(null);
  const audioCtxRef = useRef(null);

  const stopWaveform = () => {
    cancelAnimationFrame(animFrameRef.current);
    if (audioCtxRef.current) { try { audioCtxRef.current.close(); } catch {} audioCtxRef.current = null; }
  };

  const drawWaveform = (stream) => {
    audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtxRef.current.createMediaStreamSource(stream);
    const analyser = audioCtxRef.current.createAnalyser();
    analyser.fftSize = 256;
    src.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    const COLS = 48;
    const levels = new Array(COLS).fill(0);
    let col = 0;
    const draw = () => {
      if (!canvasRef.current) return;
      animFrameRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a,v)=>a+v,0) / data.length / 255;
      levels[col % COLS] = avg;
      col++;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      const w = canvas.width, h = canvas.height;
      ctx.clearRect(0,0,w,h);
      const colW = Math.floor((w - (COLS-1)*2) / COLS);
      for (let i = 0; i < COLS; i++) {
        const idx = ((col - 1 - (COLS-1-i)) % COLS + COLS) % COLS;
        const level = levels[idx];
        const barH = Math.max(3, level * h * 0.95);
        const x = i * (colW + 2);
        const y = (h - barH) / 2;
        ctx.fillStyle = COLORS[0].bg;
        ctx.globalAlpha = 0.4 + (i / COLS) * 0.6;
        ctx.beginPath();
        if (ctx.roundRect) ctx.roundRect(x, y, colW, barH, 2);
        else { ctx.rect(x, y, colW, barH); }
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };
    draw();
  };

  const doStart = async () => {
    setError(null);
    // stop any existing recording first
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    streamRef.current?.getTracks().forEach(t=>t.stop());
    stopWaveform();
    clearInterval(countdownRef.current);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio:true, video:false });
      streamRef.current = stream;
      chunksRef.current = [];
      const mimeType = ["audio/webm;codecs=opus","audio/webm","audio/mp4","audio/ogg"].find(t=>MediaRecorder.isTypeSupported(t)) || "";
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      mr.ondataavailable = e => { if (e.data?.size>0) chunksRef.current.push(e.data); };
      mr.onstop = () => {
        streamRef.current?.getTracks().forEach(t=>t.stop());
        stopWaveform();
        if (chunksRef.current.length) {
          blobRef.current = new Blob(chunksRef.current, { type: mimeType||"audio/webm" });
          setPhase("recorded");
        } else {
          setError("No audio captured. Try again.");
          setPhase("idle");
        }
      };
      mr.start(100);
      mediaRecorderRef.current = mr;
      setPhase("recording");
      drawWaveform(stream);
      let t=10; setCountdown(t);
      countdownRef.current = setInterval(()=>{
        t--;
        if (t<=0) { clearInterval(countdownRef.current); setCountdown(null); mr.stop(); }
        else setCountdown(t);
      }, 1000);
    } catch { setError("Mic access denied. Please allow microphone access."); setPhase("idle"); }
  };

  const reRecord = () => { blobRef.current=null; doStart(); };
  const submit = () => { if (blobRef.current) onAudioReady(blobRef.current); };

  useEffect(() => () => {
    clearInterval(countdownRef.current);
    streamRef.current?.getTracks().forEach(t=>t.stop());
    stopWaveform();
  }, []);

  return (
    <div onClick={e=>{ if(e.target===e.currentTarget) onClose(); }}
      style={{ position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",display:"flex",alignItems:"flex-end",justifyContent:"center",zIndex:1000,padding:"0 0 24px" }}>
      <div className="record-modal-sheet" style={{ borderRadius:20,padding:"24px 20px 20px",width:"100%",maxWidth:480,display:"flex",flexDirection:"column",gap:16,boxShadow:"0 -4px 32px rgba(0,0,0,0.18)" }}>

        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between" }}>
          <h2 style={{ fontSize:17,fontWeight:500,margin:0 }}>
            {phase==="idle"?"Record your sound":phase==="recording"?"Recording…":"Review recording"}
          </h2>
          <button onClick={onClose} style={{ background:"none",border:"none",fontSize:22,cursor:"pointer",color:"var(--color-text-tertiary)",lineHeight:1 }}>×</button>
        </div>

        {/* Waveform / status display */}
        <div style={{ background:"var(--color-background-secondary)",borderRadius:12,overflow:"hidden",height:200,display:"flex",alignItems:"center",justifyContent:"center",border:"1px solid var(--color-border-tertiary)",position:"relative" }}>
          <canvas ref={canvasRef} width={440} height={200}
            style={{ width:"100%",height:"100%",display:phase==="recording"?"block":"none" }} />
          {phase==="recorded" && (
            <div style={{ position:"absolute",display:"flex",alignItems:"center",gap:8,color:"#1D9E75",fontSize:13,fontWeight:500 }}>
              <div style={{ width:10,height:10,borderRadius:"50%",background:"#1D9E75" }} />
              Recording ready
            </div>
          )}
          {phase==="idle" && (
            <div style={{ position:"absolute",color:"var(--color-text-tertiary)",fontSize:13 }}>Waveform will appear here</div>
          )}
        </div>

        {phase==="recording" && countdown!==null && (
          <div style={{ textAlign:"center",fontSize:13,color:"var(--color-text-tertiary)" }}>
            Auto-stops in {countdown}s
          </div>
        )}

        {error && (
          <div style={{ fontSize:12,color:"var(--color-text-danger)",background:"var(--color-background-danger)",border:"1px solid var(--color-border-danger)",borderRadius:7,padding:"8px 12px" }}>{error}</div>
        )}

        <div style={{ display:"flex",gap:10 }}>
          <button onClick={reRecord}
            disabled={phase==="idle"}
            style={{ flex:1,padding:"14px",fontSize:14,fontWeight:500,background:"var(--color-background-secondary)",color:phase==="idle"?"var(--color-text-tertiary)":"var(--color-text-primary)",border:"1px solid var(--color-border-secondary)",borderRadius:10,cursor:phase==="idle"?"default":"pointer",opacity:phase==="idle"?0.4:1 }}>
            {phase==="idle" ? "RE-RECORD" : "RE-RECORD"}
          </button>
          {phase==="idle" ? (
            <button onClick={doStart}
              style={{ flex:1,padding:"14px",fontSize:15,fontWeight:500,background:"#E24B4A",color:"#fff",border:"none",borderRadius:10,cursor:"pointer",letterSpacing:"0.03em" }}>
              RECORD
            </button>
          ) : (
            <button onClick={submit} disabled={phase==="recording"}
              style={{ flex:1,padding:"14px",fontSize:14,fontWeight:500,background:phase==="recorded"?COLORS[0].bg:"var(--color-background-secondary)",color:phase==="recorded"?"#fff":"var(--color-text-tertiary)",border:"none",borderRadius:10,cursor:phase==="recorded"?"pointer":"default",opacity:phase==="recording"?0.4:1 }}>
              SUBMIT
            </button>
          )}
        </div>

        <div style={{ textAlign:"center",borderTop:"1px solid var(--color-border-tertiary)",paddingTop:14 }}>
          <span style={{ fontSize:12,color:"var(--color-text-tertiary)" }}>Or </span>
          <label style={{ fontSize:12,color:COLORS[0].bg,cursor:"pointer",fontWeight:500,textDecoration:"underline" }}>
            upload an audio file
            <input type="file" accept="audio/*,video/*,.m4a,.mp3,.wav,.ogg,.aac,.mp4" style={{display:"none"}}
              onChange={e=>{ if(e.target.files[0]) onAudioReady(e.target.files[0]); e.target.value=""; }} />
          </label>
        </div>

      </div>
    </div>
  );
}

// ── MyCopyCode ────────────────────────────────────────────────
function MyCopyCode({ username, notify }) {
  const code = makeCode(username);
  const [copied, setCopied] = useState(false);
  const fallback = (text) => {
    const ta = document.createElement("textarea");
    ta.value=text; ta.style.cssText="position:fixed;top:0;left:0;opacity:0";
    document.body.appendChild(ta); ta.focus(); ta.select();
    try { document.execCommand("copy"); } catch {}
    document.body.removeChild(ta);
  };
  const copy = () => {
    const finish = () => { setCopied(true); notify("Code copied!",1500); setTimeout(()=>setCopied(false),2000); };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(code).then(finish).catch(()=>{fallback(code);finish();});
    else { fallback(code); finish(); }
  };
  return (
    <div style={{ display:"flex",alignItems:"center",gap:8,padding:"9px 12px",background:"var(--color-background-primary)",border:"1px solid var(--color-border-tertiary)",borderRadius:8 }}>
      <span style={{ fontSize:12,color:"var(--color-text-secondary)",flexShrink:0 }}>My code:</span>
      <span style={{ fontSize:14,fontWeight:500,fontFamily:"var(--font-mono)",letterSpacing:"0.08em",color:"var(--color-text-primary)",flex:1 }}>{code}</span>
      <button onClick={copy} style={{ fontSize:11,padding:"4px 10px",borderRadius:6,border:"1px solid var(--color-border-secondary)",background:copied?COLORS[1].light:"transparent",color:copied?COLORS[1].dark:"var(--color-text-secondary)",cursor:"pointer",flexShrink:0,transition:"all 0.2s" }}>
        {copied?"Copied!":"Copy"}
      </button>
    </div>
  );
}

// ── LoginScreen ───────────────────────────────────────────────
function LoginScreen({ onEnter, prefillLink }) {
  const [name, setName] = useState("");
  const submit = () => { const n=name.trim(); if(n) onEnter(n); };
  return (
    <div style={{ minHeight:"100vh",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",padding:"32px 24px",fontFamily:"var(--font-sans)",color:"var(--color-text-primary)" }}>
      <div style={{ width:"100%",maxWidth:360,display:"flex",flexDirection:"column",alignItems:"center" }}>
        <div style={{ display:"flex",gap:6,marginBottom:20 }}>
          {COLORS.map((c,i)=><div key={i} style={{ width:10,height:18+i%3*8,borderRadius:5,background:c.bg }} />)}
        </div>
        <h1 style={{ fontSize:28,fontWeight:500,margin:"0 0 6px",textAlign:"center",letterSpacing:"-0.3px" }}>Community Orchestra</h1>
        <p style={{ fontSize:14,color:"var(--color-text-secondary)",margin:"0 0 36px",textAlign:"center",lineHeight:1.6 }}>
          {prefillLink?<><strong style={{fontWeight:500}}>{prefillLink}</strong> wants to link with you!<br/>Enter your name to join.</>:<>Record your sound. Link with others.<br/>Play together.</>}
        </p>
        <div style={{ width:"100%",display:"flex",flexDirection:"column",gap:12 }}>
          <input autoFocus placeholder="Enter your name" value={name} onChange={e=>setName(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()} maxLength={24}
            style={{ width:"100%",boxSizing:"border-box",padding:"13px 16px",fontSize:16,border:"1.5px solid var(--color-border-secondary)",borderRadius:10,background:"var(--color-background-secondary)",color:"var(--color-text-primary)",outline:"none",fontFamily:"var(--font-sans)" }} />
          <button onClick={submit} disabled={!name.trim()}
            style={{ width:"100%",padding:"13px",fontSize:15,fontWeight:500,background:name.trim()?COLORS[0].bg:"var(--color-background-secondary)",color:name.trim()?"#fff":"var(--color-text-tertiary)",border:"none",borderRadius:10,cursor:name.trim()?"pointer":"default",transition:"background 0.2s" }}>
            {prefillLink?`Link with ${prefillLink}`:"Join the orchestra"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Track ─────────────────────────────────────────────────────
function Track({ slotIdx, slot, getBuffer, getCtx, globalPlaying, globalPhase, onUnlink, isOwn, onRecordingChange, anyRecording }) {
  const eventsRef = useRef([]);
  const [events, setEvents] = useState([]);
  const [recording, setRecording] = useState(false);
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const pendingHoldRef = useRef(null);
  const autoStopRef = useRef(null);
  const recordStartRef = useRef(null);
  const loopNodesRef = useRef({});
  const lastCycleRef = useRef({});
  const progIntervalRef = useRef(null);
  const [recProgress, setRecProgress] = useState(0);
  const gridCols = 28;

  const stopNote = useCallback((node, fadeDur=0.12) => {
    if (!node) return;
    const ctx = getCtx();
    try {
      node.gain.gain.cancelScheduledValues(ctx.currentTime);
      node.gain.gain.setValueAtTime(node.gain.gain.value, ctx.currentTime);
      node.gain.gain.linearRampToValueAtTime(0, ctx.currentTime+fadeDur);
      node.src.stop(ctx.currentTime+fadeDur+0.01);
    } catch {}
  }, [getCtx]);

  const startNoteFromBuf = useCallback((buf, vol=0.75) => {
    const ctx = getCtx();
    if (!buf) return null;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(vol, ctx.currentTime+0.03);
    gain.connect(ctx.destination);
    const src = ctx.createBufferSource();
    src.buffer=buf; src.loop=true; src.loopStart=0; src.loopEnd=buf.duration;
    src.connect(gain); src.start();
    return { src, gain };
  }, [getCtx]);

  useEffect(() => {
    if (!globalPlaying || eventsRef.current.length===0) return;
    const elapsed = globalPhase * LOOP_DURATION;
    const cycle = Math.floor(Date.now()/(LOOP_DURATION*1000));
    eventsRef.current.forEach((ev,i) => {
      const dist = (elapsed - ev.start + LOOP_DURATION) % LOOP_DURATION;
      if (dist < 0.055 && lastCycleRef.current[i] !== cycle) {
        lastCycleRef.current[i] = cycle;
        if (loopNodesRef.current[i]) stopNote(loopNodesRef.current[i], 0.04);
        if (!mutedRef.current) {
          const playIdx = ev.pressedSlot !== undefined ? ev.pressedSlot : slotIdx;
          const buf = getBuffer(playIdx);
          const node = startNoteFromBuf(buf);
          if (node) {
            loopNodesRef.current[i] = node;
            setTimeout(()=>{ stopNote(loopNodesRef.current[i]); delete loopNodesRef.current[i]; }, (ev.end-ev.start)*1000);
          }
        }
      }
    });
  }, [globalPhase, globalPlaying, startNoteFromBuf, stopNote, getBuffer, slotIdx]);

  useEffect(() => {
    if (!globalPlaying) {
      Object.values(loopNodesRef.current).forEach(n=>stopNote(n,0.05));
      loopNodesRef.current={}; lastCycleRef.current={};
    }
  }, [globalPlaying, stopNote]);

  const onPressDown = useCallback((pressedSlotIdx) => {
    const t = (performance.now()/1000-recordStartRef.current)%LOOP_DURATION;
    if (loopNodesRef.current["live"]) stopNote(loopNodesRef.current["live"],0.03);
    const buf = getBuffer(pressedSlotIdx);
    const node = startNoteFromBuf(buf, 0.8);
    if (node) loopNodesRef.current["live"] = node;
    pendingHoldRef.current = { start:t, pressedSlot:pressedSlotIdx };
  }, [getBuffer, startNoteFromBuf, stopNote]);

  const onPressUp = useCallback((pressedSlotIdx) => {
    stopNote(loopNodesRef.current["live"]); delete loopNodesRef.current["live"];
    if (pendingHoldRef.current !== null) {
      const { start:startT, pressedSlot } = pendingHoldRef.current;
      const endT = Math.min((performance.now()/1000-recordStartRef.current)%LOOP_DURATION, LOOP_DURATION-0.01);
      if (endT > startT) { eventsRef.current=[...eventsRef.current,{start:startT,end:endT,pressedSlot}]; setEvents([...eventsRef.current]); }
      pendingHoldRef.current = null;
    }
  }, [stopNote]);

  const startRecord = () => {
    if (anyRecording && !recording) return;
    eventsRef.current=[]; setEvents([]);
    pendingHoldRef.current=null;
    recordStartRef.current=performance.now()/1000;
    setRecording(true); setRecProgress(0);
    onRecordingChange?.({ recording:true, onPressDown, onPressUp, trackSlotIdx:slotIdx });
    clearTimeout(autoStopRef.current); clearInterval(progIntervalRef.current);
    autoStopRef.current = setTimeout(()=>finishRecord(true), LOOP_DURATION*1000);
    progIntervalRef.current = setInterval(()=>{
      setRecProgress(Math.min((performance.now()/1000-recordStartRef.current)/LOOP_DURATION,1));
    }, 50);
  };

  const finishRecord = (auto=false) => {
    clearTimeout(autoStopRef.current); clearInterval(progIntervalRef.current);
    const now = (performance.now()/1000-recordStartRef.current)%LOOP_DURATION;
    if (pendingHoldRef.current !== null) {
      const { start:startT, pressedSlot } = pendingHoldRef.current;
      const endT = Math.min(auto?LOOP_DURATION-0.01:now, LOOP_DURATION-0.01);
      if (endT > startT) eventsRef.current=[...eventsRef.current,{start:startT,end:endT,pressedSlot}];
      pendingHoldRef.current=null;
    }
    setEvents([...eventsRef.current]);
    setRecording(false); setRecProgress(0);
    onRecordingChange?.({ recording:false });
    if (loopNodesRef.current["live"]) { stopNote(loopNodesRef.current["live"]); delete loopNodesRef.current["live"]; }
  };

  const clearTrack = () => {
    eventsRef.current=[]; setEvents([]);
    Object.values(loopNodesRef.current).forEach(n=>stopNote(n,0.05));
    loopNodesRef.current={}; clearTimeout(autoStopRef.current); clearInterval(progIntervalRef.current);
    setRecording(false); setRecProgress(0); mutedRef.current=false; setMuted(false);
  };

  const toggleMute = () => {
    const next=!muted; mutedRef.current=next; setMuted(next);
    if (next) Object.entries(loopNodesRef.current).forEach(([k,n])=>{ if(k!=="live"){stopNote(n,0.1);delete loopNodesRef.current[k];} });
  };

  const hasEvents = events.length > 0;
  const grid = Array.from({length:gridCols},(_,ci)=>{
    const cS=(ci/gridCols)*LOOP_DURATION, cE=((ci+1)/gridCols)*LOOP_DURATION;
    const match = events.find(e=>e.start<cE&&e.end>cS);
    if (!match) return null;
    return match.pressedSlot !== undefined ? match.pressedSlot : slotIdx;
  });
  const phHead = Math.round(globalPhase*gridCols);

  return (
    <div style={{ display:"flex",alignItems:"center",gap:8,opacity:muted?0.5:1,transition:"opacity 0.2s" }}>
      <div style={{ width:22,height:22,borderRadius:"50%",background:slot.color.bg,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontSize:10,fontWeight:500,flexShrink:0 }}>{slotIdx+1}</div>
      <div style={{ flex:1,display:"flex",flexDirection:"column",gap:3,minWidth:0 }}>
        <div style={{ position:"relative",height:3,background:"var(--color-border-tertiary)",borderRadius:2 }}>
          {globalPlaying&&<div style={{ position:"absolute",top:-2,left:`${globalPhase*100}%`,width:2,height:7,background:"#E24B4A",borderRadius:1,transform:"translateX(-50%)" }} />}
          {[0.2,0.4,0.6,0.8].map(p=><div key={p} style={{ position:"absolute",top:0,left:`${p*100}%`,width:1,height:3,background:"var(--color-border-secondary)",opacity:0.5 }} />)}
          {recording&&<div style={{ position:"absolute",top:0,left:0,height:"100%",background:slot.color.bg,opacity:0.35,width:`${recProgress*100}%`,borderRadius:2 }} />}
        </div>
        <div style={{ display:"flex",gap:2 }}>
          {grid.map((slotSource,ci)=>{
            const lit=slotSource!==null;
            const cellColor=lit?COLORS[slotSource%COLORS.length].bg:null;
            const isHead=ci===phHead&&globalPlaying;
            return <div key={ci} style={{ flex:1,height:18,borderRadius:3,background:lit?cellColor:isHead?`${slot.color.bg}44`:"var(--color-border-tertiary)",opacity:lit?(muted?0.25:1):0.4,transition:"background 0.04s" }} />;
          })}
        </div>
      </div>
      <div style={{ display:"flex",alignItems:"center",gap:4,flexShrink:0 }}>
        {!recording?(
          <button onClick={startRecord} disabled={muted}
            style={{ width:28,height:28,borderRadius:"50%",border:"none",background:(anyRecording&&!recording)||muted?"var(--color-border-secondary)":slot.color.bg,cursor:(anyRecording&&!recording)||muted?"default":"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,opacity:(anyRecording&&!recording)||muted?0.4:1 }}>
            {hasEvents?<span style={{ fontSize:13,color:"#fff",lineHeight:1 }}>↺</span>:<div style={{ width:9,height:9,borderRadius:"50%",background:"#fff" }} />}
          </button>
        ):(
          <button onClick={()=>finishRecord(false)}
            style={{ width:28,height:28,borderRadius:"50%",border:"none",background:"#E24B4A",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,animation:"pulse 0.7s ease-in-out infinite" }}>
            <div style={{ width:9,height:9,borderRadius:2,background:"#fff" }} />
          </button>
        )}
        {hasEvents&&!recording&&(
          <>
            <button onClick={clearTrack} style={{ fontSize:11,width:24,height:24,borderRadius:5,border:"1px solid var(--color-border-secondary)",background:"transparent",color:"var(--color-text-tertiary)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}>✕</button>
            <button onClick={toggleMute} title={muted?"Unmute":"Mute"}
              style={{ fontSize:13,width:24,height:24,borderRadius:5,border:"1px solid var(--color-border-secondary)",background:muted?slot.color.bg:"transparent",color:muted?"#fff":"var(--color-text-tertiary)",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center" }}>
              {muted?<VolumeX size={14}/>:<Volume2 size={14}/>}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ── Instrument ────────────────────────────────────────────────
function Instrument({ username, autoLinkWith }) {
  const ctxRef = useRef(null);
  const getCtx = useCallback(() => {
    if (!ctxRef.current || ctxRef.current.state==="closed")
      ctxRef.current = new (window.AudioContext||window.webkitAudioContext)();
    if (ctxRef.current.state==="suspended") ctxRef.current.resume();
    return ctxRef.current;
  }, []);

  const audioBuffersRef = useRef({});
  const heldNodesRef = useRef({});
  const playheadRafRef = useRef(null);
  const globalPlayingRef = useRef(false);

  const [slots, setSlots] = useState([{ owner:username, color:COLORS[0], hasSound:false }]);
  const [activeBtn, setActiveBtn] = useState(null);
  const [linkedUsers, setLinkedUsers] = useState([false,false,false,false]);
  const [linkRequests, setLinkRequests] = useState([]);
  const [notification, setNotification] = useState(null);
  const [uploadError, setUploadError] = useState(null);
  const [globalPlaying, setGlobalPlaying] = useState(false);
  const [globalPhase, setGlobalPhase] = useState(0);
  const [activeRecording, setActiveRecording] = useState(null);
  const [linkCodeInput, setLinkCodeInput] = useState("");
  const [linkCodeError, setLinkCodeError] = useState(null);
  const [showRecordModal, setShowRecordModal] = useState(false);

  const notify = (msg,dur=2500) => { setNotification(msg); setTimeout(()=>setNotification(null),dur); };
  const handleRecordingChange = useCallback((state) => { setActiveRecording(state.recording?state:null); }, []);

  const getDemoBuffer = useCallback((userName) => {
    const ctx=getCtx(), key=`demo_${userName}`;
    if (!audioBuffersRef.current[key]) {
      const user=DEMO_USERS.find(u=>u.name===userName);
      if (!user) return null;
      audioBuffersRef.current[key]=synthBuffer(ctx,user.sound.type,user.sound.freq,user.sound.dur);
    }
    return audioBuffersRef.current[key];
  }, [getCtx]);

  const getBuffer = useCallback((slotIdx) => {
    if (slotIdx===0) return audioBuffersRef.current[0]||null;
    const slot=slots[slotIdx];
    if (!slot) return null;
    if (slot.customKey) return audioBuffersRef.current[slot.customKey]||null;
    return getDemoBuffer(slot.owner);
  }, [getDemoBuffer, slots]);

  useEffect(() => {
    if (!globalPlaying) { globalPlayingRef.current=false; cancelAnimationFrame(playheadRafRef.current); setGlobalPhase(0); return; }
    globalPlayingRef.current=true;
    const startWall=performance.now()/1000;
    const tick=()=>{ if (!globalPlayingRef.current) return; setGlobalPhase(((performance.now()/1000-startWall)%LOOP_DURATION)/LOOP_DURATION); playheadRafRef.current=requestAnimationFrame(tick); };
    playheadRafRef.current=requestAnimationFrame(tick);
    return ()=>{ globalPlayingRef.current=false; cancelAnimationFrame(playheadRafRef.current); };
  }, [globalPlaying]);

  const startHold = useCallback((idx) => {
    const ctx=getCtx(), buf=getBuffer(idx);
    if (!buf) return;
    if (heldNodesRef.current[idx]) { try { heldNodesRef.current[idx].gain.gain.linearRampToValueAtTime(0,ctx.currentTime+0.05); heldNodesRef.current[idx].src.stop(ctx.currentTime+0.06); } catch {} }
    const gain=ctx.createGain();
    gain.gain.setValueAtTime(0,ctx.currentTime); gain.gain.linearRampToValueAtTime(0.8,ctx.currentTime+0.03);
    gain.connect(ctx.destination);
    const src=ctx.createBufferSource();
    src.buffer=buf; src.loop=true; src.loopStart=0; src.loopEnd=buf.duration;
    src.connect(gain); src.start();
    heldNodesRef.current[idx]={src,gain}; setActiveBtn(idx);
  }, [getCtx,getBuffer]);

  const stopHold = useCallback((idx) => {
    const node=heldNodesRef.current[idx]; if (!node) return;
    const ctx=getCtx();
    try { node.gain.gain.cancelScheduledValues(ctx.currentTime); node.gain.gain.setValueAtTime(node.gain.gain.value,ctx.currentTime); node.gain.gain.linearRampToValueAtTime(0,ctx.currentTime+0.12); node.src.stop(ctx.currentTime+0.13); } catch {}
    delete heldNodesRef.current[idx]; setActiveBtn(null);
  }, [getCtx]);

  const processAudioBlob = useCallback(async (blob) => {
    try {
      const ab=await blob.arrayBuffer(), ctx=getCtx();
      if (ctx.state==="suspended") await ctx.resume();
      const raw=await ctx.decodeAudioData(ab);
      const trimmed=trimSilence(ctx,raw);
      audioBuffersRef.current[0]=trimmed;
      setSlots(s=>{const n=[...s];n[0]={...n[0],hasSound:true};return n;});
      notify("Sound ready! Uploading…");
      const wav=encodeWAV(trimmed);
      const wavBlob=new Blob([wav],{type:"audio/wav"});
      try {
        const form=new FormData();
        form.append("audio",wavBlob,`${makeCode(username)}.wav`);
        const res=await fetch(`${SERVER}/audio/${makeCode(username)}`,{method:"POST",body:form});
        if (res.ok) notify("Sound uploaded! Others can now link with your code.");
        else notify("Sound ready locally, but server upload failed.");
      } catch { notify("Sound ready locally. Server unavailable."); }
    } catch { setUploadError("Couldn't decode audio. Please try again."); }
  }, [getCtx, username]);

  const handleAudioReady = useCallback(async (blob) => {
    setShowRecordModal(false);
    setUploadError(null);
    await processAudioBlob(blob);
  }, [processAudioBlob]);

  const unlinkSlot = useCallback((ownerName) => {
    setSlots(prev=>prev.filter(s=>s.owner!==ownerName));
    const demoIdx=DEMO_USERS.findIndex(u=>u.name===ownerName);
    if (demoIdx>=0) setLinkedUsers(prev=>{const n=[...prev];n[demoIdx]=false;return n;});
    notify(`Unlinked from ${makeCode(ownerName)}.`);
  }, []);

  const sendLinkRequest = (i) => {
    if (linkedUsers[i-1]||slots.length>=MAX_SLOTS) return;
    setLinkRequests(r=>[...r,i]);
    setTimeout(()=>{
      setLinkRequests(r=>r.filter(x=>x!==i));
      setLinkedUsers(prev=>{const n=[...prev];n[i-1]=true;return n;});
      setSlots(prev=>{
        if (prev.length>=MAX_SLOTS) return prev;
        return [...prev,{owner:DEMO_USERS[i-1].name,color:COLORS[prev.length%COLORS.length],hasSound:true}];
      });
      notify(`${makeCode(DEMO_USERS[i-1].name)} linked! Button ${Math.min(slots.length+1,MAX_SLOTS)} unlocked 🎵`,3000);
    },1500);
  };

  const submitLinkCode = async () => {
    const raw=linkCodeInput.trim().toUpperCase(); setLinkCodeError(null);
    if (!raw) return;
    if (!/^[A-Z]+-\d{4}$/.test(raw)) { setLinkCodeError("Invalid format. Should look like NAME-1234."); return; }
    if (slots.length>=MAX_SLOTS) { setLinkCodeError("Already at maximum of 5 sounds."); return; }
    const prefix=raw.split("-")[0];
    const ownerName=prefix.charAt(0)+prefix.slice(1).toLowerCase();
    if (slots.some(s=>s.owner.toUpperCase().startsWith(prefix))) { setLinkCodeError(`Already linked with ${ownerName}.`); return; }
    const matchIdx=DEMO_USERS.findIndex(u=>u.name.toUpperCase().startsWith(prefix));
    const color=COLORS[slots.length%COLORS.length];
    if (matchIdx>=0) {
      const demoName=DEMO_USERS[matchIdx].name;
      setLinkedUsers(prev=>{const n=[...prev];n[matchIdx]=true;return n;});
      setSlots(prev=>[...prev,{owner:demoName,color,hasSound:true}]);
      notify(`${makeCode(demoName)} added as button ${slots.length+1}! 🎵`,3000);
    } else {
      notify(`Looking up ${raw}…`,1500);
      try {
        const res=await fetch(`${SERVER}/audio/${raw}`);
        if (res.ok) {
          const blob=await res.blob(), ab=await blob.arrayBuffer(), ctx=getCtx();
          if (ctx.state==="suspended") await ctx.resume();
          const audioBuf=await ctx.decodeAudioData(ab);
          const key=`custom_${ownerName}`;
          audioBuffersRef.current[key]=trimSilence(ctx,audioBuf);
          setSlots(prev=>[...prev,{owner:ownerName,color,hasSound:true,customKey:key}]);
          notify(`${raw} linked! Their sound added as button ${slots.length+1}! 🎵`,3000);
        } else {
          const ctx=getCtx(), hash=[...ownerName].reduce((a,c)=>(a*31+c.charCodeAt(0))&0xffff,0);
          const buf=synthBuffer(ctx,["sine","square","sawtooth","triangle"][hash%4],110+(hash%8)*55,0.35);
          const key=`custom_${ownerName}`; audioBuffersRef.current[key]=buf;
          setSlots(prev=>[...prev,{owner:ownerName,color,hasSound:true,customKey:key}]);
          notify(`${raw} linked with demo sound (they haven't uploaded yet).`,3000);
        }
      } catch {
        const ctx=getCtx(), hash=[...ownerName].reduce((a,c)=>(a*31+c.charCodeAt(0))&0xffff,0);
        const buf=synthBuffer(ctx,["sine","square","sawtooth","triangle"][hash%4],110+(hash%8)*55,0.35);
        const key=`custom_${ownerName}`; audioBuffersRef.current[key]=buf;
        setSlots(prev=>[...prev,{owner:ownerName,color,hasSound:true,customKey:key}]);
        notify(`${raw} linked with demo sound (server unreachable).`,3000);
      }
    }
    setLinkCodeInput("");
  };

  useEffect(()=>{
    if (!autoLinkWith) return;
    const matchIdx=DEMO_USERS.findIndex(u=>u.name.toLowerCase()===autoLinkWith.toLowerCase());
    setTimeout(()=>{
      if (matchIdx>=0) {
        setLinkedUsers(prev=>{const n=[...prev];n[matchIdx]=true;return n;});
        setSlots(prev=>{ if(prev.some(s=>s.owner===autoLinkWith)||prev.length>=MAX_SLOTS) return prev; return [...prev,{owner:autoLinkWith,color:COLORS[prev.length%COLORS.length],hasSound:true}]; });
      } else {
        const ctx=getCtx(), hash=[...autoLinkWith].reduce((a,c)=>(a*31+c.charCodeAt(0))&0xffff,0);
        const buf=synthBuffer(ctx,["sine","square","sawtooth","triangle"][hash%4],110+(hash%8)*55,0.35);
        const key=`custom_${autoLinkWith}`; audioBuffersRef.current[key]=buf;
        setSlots(prev=>{ if(prev.some(s=>s.owner===autoLinkWith)||prev.length>=MAX_SLOTS) return prev; return [...prev,{owner:autoLinkWith,color:COLORS[prev.length%COLORS.length],hasSound:true,customKey:key}]; });
      }
      notify(`${makeCode(autoLinkWith)}'s sound added!`,3500);
    },500);
  },[]);

  const customLinked=slots.slice(1).filter(s=>!DEMO_USERS.some(d=>d.name===s.owner));

  return (
    <div style={{ minHeight:"100vh",padding:"20px 16px",fontFamily:"var(--font-sans)",color:"var(--color-text-primary)",maxWidth:580,margin:"0 auto" }}>
      {showRecordModal && <RecordModal onClose={()=>setShowRecordModal(false)} onAudioReady={handleAudioReady} username={username} />}

      <div style={{ marginBottom:20 }}>
        <h1 style={{ fontSize:22,fontWeight:500,margin:0 }}>Community Orchestra</h1>
        <p style={{ fontSize:13,color:"var(--color-text-secondary)",margin:"3px 0 0" }}>Playing as <strong style={{fontWeight:500}}>{username}</strong></p>
      </div>

      {notification&&<div style={{ background:"var(--color-background-info)",color:"var(--color-text-info)",border:"1px solid var(--color-border-info)",borderRadius:8,padding:"9px 13px",fontSize:13,marginBottom:16 }}>{notification}</div>}

      {/* Sound buttons */}
      <div style={{ marginBottom:20 }}>
        <div style={{ fontSize:11,color:activeRecording?"#E24B4A":"var(--color-text-tertiary)",marginBottom:8,letterSpacing:"0.05em",textTransform:"uppercase",transition:"color 0.2s" }}>
          {activeRecording?`Recording track ${activeRecording.trackSlotIdx+1} — hold a sound`:"Sounds — hold to sustain"}
        </div>
        <div style={{ display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8 }}>
          {slots.map((slot,i)=>{
            const isActive=activeBtn===i;
            return (
              <button key={i}
                onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);if(activeRecording)activeRecording.onPressDown(i);else startHold(i);}}
                onPointerUp={()=>{if(activeRecording)activeRecording.onPressUp(i);else stopHold(i);}}
                onPointerLeave={()=>{if(activeRecording)activeRecording.onPressUp(i);else stopHold(i);}}
                style={{ background:isActive?slot.color.bg:slot.color.light,border:`2px solid ${slot.color.bg}66`,borderRadius:12,padding:"14px 4px 10px",cursor:"pointer",transition:"all 0.07s",transform:isActive?"scale(0.91)":"scale(1)",display:"flex",flexDirection:"column",alignItems:"center",gap:5,touchAction:"none",userSelect:"none",boxShadow:activeRecording?`0 0 0 2px ${slot.color.bg}44`:"none" }}>
                <div style={{ width:32,height:32,borderRadius:"50%",background:slot.color.bg,display:"flex",alignItems:"center",justifyContent:"center",color:"#fff",fontWeight:500,fontSize:15 }}>{i+1}</div>
                <div style={{ fontSize:9,color:slot.color.dark,fontWeight:500,textAlign:"center",lineHeight:1.3,fontFamily:"var(--font-mono)" }}>{makeCode(slot.owner).split("-")[0]}</div>
              </button>
            );
          })}
          {Array.from({length:MAX_SLOTS-slots.length}).map((_,i)=>(
            <div key={`e${i}`} style={{ border:"2px dashed var(--color-border-tertiary)",borderRadius:12,padding:"14px 4px 10px",display:"flex",flexDirection:"column",alignItems:"center",gap:5,opacity:0.3 }}>
              <div style={{ width:32,height:32,borderRadius:"50%",background:"var(--color-background-secondary)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,color:"var(--color-text-tertiary)" }}>{slots.length+i+1}</div>
              <div style={{ fontSize:10,color:"var(--color-text-tertiary)" }}>Locked</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tracks */}
      <div style={{ background:"var(--color-background-secondary)",border:"1px solid var(--color-border-tertiary)",borderRadius:12,padding:16,marginBottom:16 }}>
        <div style={{ display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10 }}>
          <div><span style={{ fontSize:13,fontWeight:500 }}>Tracks</span><span style={{ fontSize:11,color:"var(--color-text-tertiary)",marginLeft:6 }}>{LOOP_DURATION}s each</span></div>
          <button onClick={()=>{getCtx();setGlobalPlaying(p=>{globalPlayingRef.current=!p;return !p;});}}
            style={{ fontSize:12,fontWeight:500,padding:"6px 18px",borderRadius:7,border:"none",background:globalPlaying?"#E24B4A":COLORS[0].bg,color:"#fff",cursor:"pointer" }}>
            {globalPlaying?"Pause":"Play all"}
          </button>
        </div>
        <div style={{ position:"relative",height:3,background:"var(--color-border-tertiary)",borderRadius:2,marginBottom:12 }}>
          {globalPlaying&&<div style={{ position:"absolute",top:-3,left:`${globalPhase*100}%`,width:2,height:9,background:"#E24B4A",borderRadius:1,transform:"translateX(-50%)" }} />}
          {[0.2,0.4,0.6,0.8].map(p=><div key={p} style={{ position:"absolute",top:0,left:`${p*100}%`,width:1,height:3,background:"var(--color-border-secondary)" }} />)}
        </div>
        <div style={{ display:"flex",flexDirection:"column",gap:10 }}>
          {slots.map((slot,i)=>(
            <Track key={slot.owner} slotIdx={i} slot={slot} getBuffer={getBuffer} getCtx={getCtx}
              globalPlaying={globalPlaying} globalPhase={globalPhase}
              isOwn={i===0} onUnlink={()=>unlinkSlot(slot.owner)}
              onRecordingChange={handleRecordingChange} anyRecording={!!activeRecording} />
          ))}
        </div>
      </div>

      {/* Your sound */}
      <div style={{ background:"var(--color-background-secondary)",border:"1px solid var(--color-border-tertiary)",borderRadius:12,padding:16,marginBottom:16 }}>
        <div style={{ fontSize:13,fontWeight:500,marginBottom:4 }}>Your sound</div>
        <p style={{ fontSize:12,color:"var(--color-text-tertiary)",margin:"0 0 12px" }}>
          {slots[0].hasSound?"Your sound is ready. You can replace it below.":"Record or upload a short sound — a clap, hum, voice, anything."}
        </p>
        {uploadError&&<div style={{ fontSize:12,color:"var(--color-text-danger)",background:"var(--color-background-danger)",border:"1px solid var(--color-border-danger)",borderRadius:7,padding:"8px 12px",marginBottom:10 }}>{uploadError}</div>}
        <button onClick={()=>setShowRecordModal(true)}
          style={{ width:"100%",padding:"12px",fontSize:14,fontWeight:500,background:COLORS[0].bg,color:"#fff",border:"none",borderRadius:9,cursor:"pointer" }}>
          {slots[0].hasSound?"Replace sound":"Record audio"}
        </button>
      </div>

      {/* Link with another artist */}
      <div style={{ background:"var(--color-background-secondary)",border:"1px solid var(--color-border-tertiary)",borderRadius:12,padding:16,marginBottom:16 }}>
        <div style={{ fontSize:13,fontWeight:500,marginBottom:4 }}>Link with another artist</div>
        <p style={{ fontSize:12,color:"var(--color-text-tertiary)",margin:"0 0 10px" }}>Enter someone else's code to add their sound.</p>
        {linkCodeError&&<div style={{ fontSize:12,color:"var(--color-text-danger)",background:"var(--color-background-danger)",border:"1px solid var(--color-border-danger)",borderRadius:7,padding:"8px 12px",marginBottom:10 }}>{linkCodeError}</div>}
        <div style={{ display:"flex",gap:8,marginBottom:12 }}>
          <input placeholder="e.g. AVA-3821" value={linkCodeInput} onChange={e=>setLinkCodeInput(e.target.value.toUpperCase())} onKeyDown={e=>e.key==="Enter"&&submitLinkCode()} maxLength={12}
            autoCorrect="off" autoCapitalize="characters" spellCheck={false}
            style={{ flex:1,padding:"10px 12px",fontSize:13,border:"1.5px solid var(--color-border-secondary)",borderRadius:8,background:"var(--color-background-primary)",color:"var(--color-text-primary)",outline:"none",fontFamily:"var(--font-mono)",letterSpacing:"0.05em" }} />
          <button onClick={submitLinkCode} style={{ padding:"10px 18px",fontSize:13,fontWeight:500,background:COLORS[0].bg,color:"#fff",border:"none",borderRadius:8,cursor:"pointer" }}>Link</button>
        </div>
        <MyCopyCode username={username} notify={notify} />
      </div>

      {/* Linked artists */}
      {customLinked.length>0&&(
        <div style={{ background:"var(--color-background-secondary)",border:"1px solid var(--color-border-tertiary)",borderRadius:12,padding:16,marginBottom:16 }}>
          <div style={{ fontSize:13,fontWeight:500,marginBottom:4 }}>Linked artists</div>
          <p style={{ fontSize:12,color:"var(--color-text-secondary)",margin:"0 0 12px" }}>Players you've linked with via code.</p>
          <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
            {customLinked.map((slot,i)=>(
              <div key={i} style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 12px",borderRadius:8,background:slot.color.light,border:`1px solid ${slot.color.bg}55` }}>
                <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                  <div style={{ width:30,height:30,borderRadius:"50%",background:slot.color.bg,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:500,color:"#fff",fontFamily:"var(--font-mono)" }}>{makeCode(slot.owner).split("-")[0].slice(0,2)}</div>
                  <div>
                    <div style={{ fontSize:13,fontWeight:500,fontFamily:"var(--font-mono)",letterSpacing:"0.05em" }}>{makeCode(slot.owner)}</div>
                    <div style={{ fontSize:11,color:"var(--color-text-tertiary)" }}>Button {slots.indexOf(slot)+1}</div>
                  </div>
                </div>
                <button onClick={()=>unlinkSlot(slot.owner)} style={{ background:"transparent",color:"var(--color-text-tertiary)",border:"1px solid var(--color-border-secondary)",borderRadius:7,padding:"5px 11px",fontSize:11,cursor:"pointer" }}>Unlink</button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Demo artists */}
      <div style={{ background:"var(--color-background-secondary)",border:"1px solid var(--color-border-tertiary)",borderRadius:12,padding:16 }}>
        <div style={{ fontSize:13,fontWeight:500,marginBottom:4 }}>Demo artists</div>
        <p style={{ fontSize:12,color:"var(--color-text-secondary)",margin:"0 0 12px" }}>Demo players to try out the linking feature.</p>
        <div style={{ display:"flex",flexDirection:"column",gap:8 }}>
          {[0,1,2,3].map(i=>{
            const linked=linkedUsers[i],pending=linkRequests.includes(i+1),full=slots.length>=MAX_SLOTS&&!linked;
            const uname=DEMO_USERS[i].name, ucode=makeCode(uname);
            return (
              <div key={i} style={{ display:"flex",alignItems:"center",justifyContent:"space-between",padding:"9px 12px",borderRadius:8,background:linked?COLORS[i+1].light:"var(--color-background-primary)",border:`1px solid ${linked?COLORS[i+1].bg+"55":"var(--color-border-tertiary)"}` }}>
                <div style={{ display:"flex",alignItems:"center",gap:10 }}>
                  <div style={{ width:30,height:30,borderRadius:"50%",background:linked?COLORS[i+1].bg:"var(--color-background-secondary)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,fontWeight:500,color:linked?"#fff":"var(--color-text-tertiary)",fontFamily:"var(--font-mono)" }}>{ucode.split("-")[0].slice(0,2)}</div>
                  <div>
                    <div style={{ fontSize:13,fontWeight:500,fontFamily:"var(--font-mono)",letterSpacing:"0.05em" }}>{ucode}</div>
                    <div style={{ fontSize:11,color:"var(--color-text-tertiary)" }}>{linked?`Button ${slots.findIndex(s=>s.owner===uname)+1}`:"Nearby"}</div>
                  </div>
                </div>
                <div style={{ display:"flex",gap:6 }}>
                  {linked&&<button onClick={()=>unlinkSlot(uname)} style={{ background:"transparent",color:"var(--color-text-tertiary)",border:"1px solid var(--color-border-secondary)",borderRadius:7,padding:"5px 11px",fontSize:11,cursor:"pointer" }}>Unlink</button>}
                  {!linked&&<button onClick={()=>!pending&&!full&&sendLinkRequest(i+1)} disabled={pending||full} style={{ background:pending||full?"var(--color-background-secondary)":COLORS[i+1].bg,color:pending||full?"var(--color-text-tertiary)":"#fff",border:"none",borderRadius:7,padding:"5px 13px",fontSize:12,fontWeight:500,cursor:pending||full?"default":"pointer" }}>{pending?"Linking…":full?"Full":"Link"}</button>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <style>{`
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.6}}
        @keyframes bounce{0%,100%{transform:scaleY(1)}50%{transform:scaleY(1.9)}}
        .record-modal-sheet { background: #ffffff; }
        @media (prefers-color-scheme: dark) { .record-modal-sheet { background: #1c1c1e; } }
      `}</style>
    </div>
  );
}

export default function App() {
  const params=new URLSearchParams(window.location.search);
  const linkParam=params.get("link");
  const [username,setUsername]=useState(null);
  return username?<Instrument username={username} autoLinkWith={linkParam}/>:<LoginScreen onEnter={setUsername} prefillLink={linkParam}/>;
}
