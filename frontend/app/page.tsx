'use client';
import { useEffect, useState, useRef } from 'react';
import {
  Play, CheckCircle, XCircle, Clock, Plus, Settings, Terminal,
  Shield, Search, Sparkles, Command, Lock, FileCode, Loader2,
  GitCommit, X, Send, FolderOpen, Folder, ChevronDown,
  Trash2, GitBranch, Zap, Activity, ChevronRight
} from 'lucide-react';
import { pageApi as api, Project } from '@/lib/api';
import { formatDuration, timeAgo, statusStyles } from '@/lib/utils';

// Local Build type — compatible with both the API response and demo data
type Build = {
  id: string; project_id: string; status: string; branch: string;
  commit_sha: string; commit_message: string;
  duration: number; duration_ms: number; number: number;
  created_at: string; started_at: string; finished_at: string;
};

type View = 'dashboard' | 'builds' | 'pipeline' | 'secrets' | 'settings' | 'llm-config';
type ChatMsg = { role: 'user' | 'assistant'; content: string };
type FolderItem = { id: string; name: string; expanded: boolean; projects: Project[] };

/* ─── exact demo data ─────────────────────────────────────────────────────── */
const DEMO: Project[] = [];
const DEMO_BUILDS: Build[] = [
];

/* ─── status badge ────────────────────────────────────────────────────────── */
function Badge({ status }: { status: string }) {
  const map: Record<string, { bg: string; color: string; border: string }> = {
    success:   { bg:'rgba(0,229,160,0.1)',  color:'#00e5a0', border:'rgba(0,229,160,0.25)' },
    running:   { bg:'rgba(0,212,255,0.1)',  color:'#00d4ff', border:'rgba(0,212,255,0.25)' },
    failed:    { bg:'rgba(255,68,85,0.1)',  color:'#ff4455', border:'rgba(255,68,85,0.25)' },
    pending:   { bg:'rgba(245,197,66,0.1)', color:'#f5c542', border:'rgba(245,197,66,0.25)' },
    cancelled: { bg:'rgba(84,95,114,0.15)', color:'#545f72', border:'rgba(84,95,114,0.2)' },
  };
  const s = map[status] ?? map.cancelled;
  const dot = status === 'running';
  return (
    <span style={{ display:'inline-flex', alignItems:'center', gap:6, padding:'3px 10px', borderRadius:5,
      background:s.bg, color:s.color, border:`1px solid ${s.border}`,
      fontFamily:"'IBM Plex Mono', monospace", fontSize:11, fontWeight:500, letterSpacing:'0.04em' }}>
      {dot
        ? <span style={{ width:6, height:6, borderRadius:'50%', background:'#00d4ff',
            boxShadow:'0 0 6px #00d4ff', display:'inline-block', animation:'blink 1.5s ease-in-out infinite' }} />
        : status === 'success' ? <CheckCircle size={11}/>
        : status === 'failed'  ? <XCircle size={11}/>
        : <Clock size={11}/>}
      {status}
    </span>
  );
}

/* ─── logo — exactly matches website ─────────────────────────────────────── */
function Logo({ size = 28 }: { size?: number }) {
  return (
    <div style={{ width:size, height:size, background:'#00d4ff', borderRadius:Math.round(size*0.214),
      display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0 }}>
      <svg width={Math.round(size*0.571)} height={Math.round(size*0.571)} viewBox="0 0 16 16" fill="none">
        <rect x="2" y="2" width="5" height="5" rx="1" fill="#000"/>
        <rect x="9" y="2" width="5" height="5" rx="1" fill="#000" opacity="0.5"/>
        <rect x="2" y="9" width="5" height="5" rx="1" fill="#000" opacity="0.5"/>
        <rect x="9" y="9" width="5" height="5" rx="1" fill="#000"/>
      </svg>
    </div>
  );
}

/* ─── card ────────────────────────────────────────────────────────────────── */
function Card({ children, style = {}, onClick }: { children: React.ReactNode; style?: React.CSSProperties; onClick?: () => void }) {
  const [hov, setHov] = useState(false);
  return (
    <div onClick={onClick}
      onMouseEnter={() => onClick && setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{ background:'#0d1117', border:`1px solid ${hov ? 'rgba(0,212,255,0.25)' : 'rgba(255,255,255,0.12)'}`,
        borderRadius:10, padding:20, transition:'border-color 0.2s', cursor: onClick ? 'pointer' : 'default', ...style }}>
      {children}
    </div>
  );
}

 /* ─── real live build log via WebSocket ──────────────────────────────────── */
 function RunningLog({ build, onStop }: { build: Build; onStop: ()=>void }) {
   const [lines, setLines] = useState<{msg:string;color:string}[]>([]);
   const [stopped, setStopped] = useState(false);
   const [stopping, setStopping] = useState(false);
   const [elapsed, setElapsed] = useState(0);
   const [currentStep, setCurrentStep] = useState('Connecting…');
   const bottomRef = useRef<HTMLDivElement>(null);
   const wsRef = useRef<WebSocket|null>(null);
   const stoppedRef = useRef(false);
   const startRef = useRef(Date.now());

   // Elapsed timer
   useEffect(() => {
     const t = setInterval(() => {
       if (!stoppedRef.current) setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
     }, 1000);
     return () => clearInterval(t);
   }, []);

   useEffect(() => {
     if (stoppedRef.current) return;
     const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
     const ws = new WebSocket(`${proto}://localhost:8080/ws?build_id=${build.id}`);
     wsRef.current = ws;

     ws.onmessage = (ev) => {
       try {
         const msg = JSON.parse(ev.data);
         if (msg.type === 'log' && msg.payload.build_id === build.id) {
           const { line, stream } = msg.payload;
           const color = stream === 'stderr' ? '#ff4455'
             : line.startsWith('✔') || line.startsWith('└─ Job completed') ? '#00e5a0'
             : line.startsWith('✖') || line.startsWith('└─ Job FAILED') ? '#ff4455'
             : line.startsWith('▶') || line.startsWith('│ ▶') || line.startsWith('┌') || line.startsWith('╔') || line.startsWith('╚') ? '#00d4ff'
             : line.startsWith('│ ✔') ? '#00e5a0'
             : line.startsWith('│ ✖') ? '#ff4455'
             : line.startsWith('  [AI]') || line.includes('🤖') ? '#a078ff'
            : line.includes('🛡') || line.includes('[CRITICAL]') || line.includes('[HIGH]') ? '#ff4455'
            : line.includes('[MEDIUM]') ? '#f5c542'
            : line.includes('[LOW]') || line.includes('[INFO]') ? '#545f72'
            : line.includes('💡') ? '#a078ff'
            : line.includes('🔍') || line.startsWith('  Summary:') ? '#00d4ff'
            : line.includes('🏷') ? '#a078ff'
             : line.startsWith('  ⏳') ? '#f5c542'
             : '#8892a4';
           setLines(l => [...l, { msg: line, color }]);
           // Track current step name
           if (line.includes('│ ▶')) {
             setCurrentStep(line.replace('│ ▶', '').trim());
           } else if (line.includes('┌─ Job:')) {
             setCurrentStep(line.replace('┌─ Job:', '').trim());
           } else if (line.startsWith('Cloning')) {
             setCurrentStep('Cloning repository…');
           }
         }
         if (msg.type === 'build_status' && msg.payload.build_id === build.id) {
           const s = msg.payload.status;
           if (s === 'success' || s === 'failed' || s === 'cancelled') {
             stoppedRef.current = true;
             setStopped(true);
             onStop();
           }
         }
       } catch {}
     };

    let hasConnected = false;
    ws.onopen = () => { hasConnected = true; };

    ws.onerror = () => {};
    ws.onclose = () => {};

     return () => { ws.close(); };
   // eslint-disable-next-line react-hooks/exhaustive-deps
   }, [build.id]);

   useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:'smooth', block:'nearest' }); }, [lines]);

   const stop = async () => {
     if (stopping || stopped) return;
     setStopping(true);
     stoppedRef.current = true;
     wsRef.current?.close();
     try {
       await fetch(`http://localhost:8080/api/v1/builds/${build.id}/cancel`, { method:'POST' });
     } catch {}
     setStopped(true);
     setStopping(false);
     onStop();
   };

   const fmt = (s: number) => `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;

   return (
     <div>
       {/* Status bar */}
       {!stopped && (
         <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
           padding:'8px 12px', background:'rgba(0,212,255,0.05)',
           border:'1px solid rgba(0,212,255,0.15)', borderRadius:7, marginBottom:10 }}>
           <div style={{ display:'flex', alignItems:'center', gap:10 }}>
             <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%',
               background:'#00d4ff', animation:'blink 1s ease-in-out infinite', flexShrink:0 }}/>
             <span style={{ fontFamily:"'Figtree',sans-serif", fontSize:12, color:'#e8eaf0', fontWeight:500 }}>
               {currentStep}
             </span>
           </div>
           <div style={{ display:'flex', alignItems:'center', gap:12 }}>
             <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#00d4ff' }}>
               {fmt(elapsed)}
             </span>
             <button onClick={stop} disabled={stopping}
               style={{ display:'flex', alignItems:'center', gap:5,
                 padding:'4px 10px', background:'rgba(255,68,85,0.1)', border:'1px solid rgba(255,68,85,0.25)',
                 borderRadius:5, color:'#ff4455', cursor: stopping ? 'wait' : 'pointer', fontSize:11,
                 fontFamily:"'Figtree',sans-serif", fontWeight:600, opacity: stopping ? 0.6 : 1 }}>
               ■ {stopping ? 'Stopping…' : 'Stop'}
             </button>
           </div>
         </div>
       )}

       <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
         <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
           letterSpacing:'0.1em', textTransform:'uppercase' }}>
           {stopped ? 'Build Log' : 'Build Log — Live'}
         </span>
         {stopped && (
           <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72' }}>
             {fmt(elapsed)} total
           </span>
         )}
       </div>

       <div style={{ background:'#080a0f', borderRadius:8, padding:16,
         fontFamily:"'IBM Plex Mono',monospace", fontSize:12, lineHeight:'1.8',
         color:'#8892a4', maxHeight:340, overflowY:'auto' }}>
         {lines.length === 0 && !stopped && (
           <div style={{ color:'#545f72', display:'flex', alignItems:'center', gap:8 }}>
             <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%',
               background:'#00d4ff', animation:'blink 1s ease-in-out infinite' }}/>
             Connecting to pipeline…
           </div>
         )}
         {lines.map((l,i) => <div key={i} style={{ color:l.color, whiteSpace:'pre-wrap' }}>{l.msg}</div>)}
         {!stopped && lines.length > 0 && (
           <div style={{ color:'#545f72', display:'flex', alignItems:'center', gap:8, marginTop:4 }}>
             <span style={{ display:'inline-block', width:7, height:7, borderRadius:'50%',
               background:'#00d4ff', animation:'blink 1s ease-in-out infinite' }}/>
           </div>
         )}
         <div ref={bottomRef}/>
       </div>
     </div>
   );
 }

/* ─── module-level helpers (must be outside App to avoid hooks-in-loop) ─────── */
function parseTestResults(log: string) {
  const results: {name:string; status:'pass'|'fail'|'skip'; duration:string}[] = [];
  for (const line of log.split('\n')) {
    const pass = line.match(/--- PASS: (\S+) \((.+?)\)/);
    const fail = line.match(/--- FAIL: (\S+) \((.+?)\)/);
    const skip = line.match(/--- SKIP: (\S+) \((.+?)\)/);
    if (pass) results.push({ name: pass[1], status: 'pass', duration: pass[2] });
    else if (fail) results.push({ name: fail[1], status: 'fail', duration: fail[2] });
    else if (skip) results.push({ name: skip[1], status: 'skip', duration: skip[2] });
  }
  return results;
}
function stepStatusColor(s: string) {
  return s==='success'?'#00e5a0':s==='failed'?'#ff4455':s==='running'?'#00d4ff':'#545f72';
}
function stepStatusIcon(s: string) {
  return s==='success'?'✔':s==='failed'?'✖':s==='running'?'▶':s==='cancelled'?'■':'○';
}
function StepRow({ step }: { step: any }) {
  const [logOpen, setLogOpen] = useState(true);
  const stepTests = parseTestResults(step.log||'');
  const stepPassed = stepTests.filter(t=>t.status==='pass').length;
  const stepFailed = stepTests.filter(t=>t.status==='fail').length;
  return (
    <div style={{ borderRadius:7, overflow:'hidden',
      border:`1px solid ${step.status==='failed'?'rgba(255,68,85,0.25)':'rgba(255,255,255,0.07)'}`,
      background:step.status==='failed'?'rgba(255,68,85,0.04)':'rgba(255,255,255,0.02)' }}>
      <div onClick={()=>setLogOpen(o=>!o)}
        style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 14px', cursor:'pointer' }}>
        <span style={{ fontSize:12, color:stepStatusColor(step.status), fontWeight:700, width:14 }}>
          {stepStatusIcon(step.status)}
        </span>
        <span style={{ fontFamily:"'Figtree',sans-serif", fontSize:13,
          color:step.status==='failed'?'#ff8888':'#e8eaf0', flex:1, fontWeight:500 }}>
          {step.name}
        </span>
        {stepTests.length > 0 && (
          <div style={{ display:'flex', gap:6, fontFamily:"'IBM Plex Mono',monospace", fontSize:10 }}>
            {stepPassed>0 && <span style={{ color:'#00e5a0' }}>✔ {stepPassed}</span>}
            {stepFailed>0 && <span style={{ color:'#ff4455' }}>✖ {stepFailed}</span>}
          </div>
        )}
        <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#545f72' }}>
          {step.duration_ms ? `${(step.duration_ms/1000).toFixed(1)}s` : ''}
        </span>
        <ChevronDown size={12} style={{ color:'#545f72',
          transform:logOpen?'none':'rotate(-90deg)', transition:'0.15s' }}/>
      </div>
      {logOpen && step.log && (
        <div style={{ borderTop:'1px solid rgba(255,255,255,0.06)' }}>
          {stepTests.length > 0 && (
            <div style={{ padding:'8px 14px', borderBottom:'1px solid rgba(255,255,255,0.06)',
              display:'flex', flexDirection:'column', gap:3 }}>
              {stepTests.map((t,ti)=>(
                <div key={ti} style={{ display:'flex', alignItems:'center', gap:8,
                  fontFamily:"'IBM Plex Mono',monospace", fontSize:11 }}>
                  <span style={{ color:t.status==='pass'?'#00e5a0':t.status==='fail'?'#ff4455':'#545f72', width:10 }}>
                    {t.status==='pass'?'✔':t.status==='fail'?'✖':'⊘'}
                  </span>
                  <span style={{ color:t.status==='fail'?'#ff8888':'#8892a4', flex:1 }}>{t.name}</span>
                  <span style={{ color:'#545f72' }}>{t.duration}</span>
                </div>
              ))}
            </div>
          )}
          <pre style={{ margin:0, padding:'12px 14px', fontFamily:"'IBM Plex Mono',monospace",
            fontSize:11, lineHeight:1.7, color:'#8892a4', overflowX:'auto',
            maxHeight:240, overflowY:'auto', whiteSpace:'pre-wrap', wordBreak:'break-all' }}>
            {step.log}
          </pre>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [projects, setProjects]   = useState<Project[]>(DEMO);
  const [builds, setBuilds]       = useState<Build[]>(DEMO_BUILDS);
  const [sel, setSel]             = useState<Project|null>(null);
  const [view, setView]           = useState<View>('dashboard');
  const [selBuild, setSelBuild]   = useState<Build|null>(null);
  const [aiOpen, setAiOpen]       = useState(false);
  const [cmdOpen, setCmdOpen]     = useState(false);
  const [addProj, setAddProj]         = useState(false);
  const [addProjToFolder, setAddProjToFolder] = useState<string|null>(null);
  const [addFolder, setAddFolder]     = useState(false);
  const [msgs, setMsgs]           = useState<ChatMsg[]>([
    { role:'assistant', content:"Hey — I'm Callahan AI. Ask me to generate a pipeline, explain a failure, or review your code." }
  ]);
  const [loading, setLoading]     = useState(false);
  const [folders, setFolders]     = useState<FolderItem[]>([]);
  const [cmdQ, setCmdQ]         = useState('');
  const chatEnd  = useRef<HTMLDivElement>(null);
  const cmdRef   = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey||e.ctrlKey) && e.key==='k') { e.preventDefault(); setCmdOpen(o=>!o); }
      if (e.key==='Escape') { setCmdOpen(false); setAiOpen(false); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);
  useEffect(() => { if (cmdOpen) setTimeout(()=>cmdRef.current?.focus(),50); }, [cmdOpen]);
  useEffect(() => { chatEnd.current?.scrollIntoView({ behavior:'smooth' }); }, [msgs]);
  useEffect(() => { api.getProjects().then(setProjects).catch(()=>{}); }, []);

  // Fetch builds when project changes
  useEffect(() => {
    if (!sel) return;
    fetch(`http://localhost:8080/api/v1/projects/${sel.id}/builds`)
      .then(r=>r.json()).then(d=>{ if(Array.isArray(d)) setBuilds(b=>[...d,...b.filter(x=>x.project_id!==sel.id)]); })
      .catch(()=>{});
  }, [sel?.id]);

  // Poll running builds every 3s
  useEffect(() => {
    const running = builds.filter(b=>b.status==='running');
    if (!running.length) return;
    const id = setInterval(async () => {
      for (const b of running) {
        try {
          const res = await fetch(`http://localhost:8080/api/v1/builds/${b.id}`);
          if (!res.ok) continue;
          const updated = await res.json();
          setBuilds(prev=>prev.map(x=>x.id===b.id?{...x,...updated}:x));
          if (selBuild?.id===b.id) setSelBuild(s=>s?{...s,...updated}:s);
        } catch {}
      }
    }, 3000);
    return () => clearInterval(id);
  }, [builds.map(b=>b.id+b.status).join(',')]);

  const projBuilds = sel ? builds.filter(b=>b.project_id===sel.id) : builds;
  const [runModal, setRunModal] = useState(false);

  const triggerBuild = async (artifactVersionId?: string) => {
    if (!sel) return;
    const mock: Build = {
      id:`b-${Date.now()}`, project_id:sel.id, status:'running', branch:sel.branch,
      commit_sha:Math.random().toString(36).slice(2,9),
      commit_message: artifactVersionId ? `Deploy version ${artifactVersionId}` : 'Manual trigger',
      duration:0, duration_ms:0, number:0,
      created_at:new Date().toISOString(), started_at:'', finished_at:''
    };
    setBuilds(p=>[mock,...p]);
    setSelBuild(mock);
    setView('builds');
    try {
      const b = await api.triggerBuild(sel.id, artifactVersionId);
      setBuilds(p=>[b,...p.filter(x=>x.id!==mock.id)]);
      setSelBuild(b);
    } catch {}
  };

  const sendAiMessage = async (msg: string) => {
    setAiOpen(true);
    setMsgs(m=>[...m,{role:'user',content:msg}]);
    setLoading(true);
    try {
      const r = await api.aiChat(msg, sel?.id);
      setMsgs(m=>[...m,{role:'assistant',content:r.message}]);
    } catch {
      setMsgs(m=>[...m,{role:'assistant',content:'Backend offline — run `go run ./cmd/callahan` then try again.'}]);
    }
    setLoading(false);
  };

  function RunBuildModal() {
    const [versions, setVersions] = useState<any[]>([]);
    const [selVersion, setSelVersion] = useState('');
    const [loadingV, setLoadingV] = useState(true);
    useEffect(() => {
      fetch('http://localhost:8080/api/v1/versions')
        .then(r=>r.json()).then(d=>{ setVersions(Array.isArray(d)?d:[]); setLoadingV(false); })
        .catch(()=>setLoadingV(false));
    }, []);
    const run = () => { setRunModal(false); triggerBuild(selVersion||undefined); };
    return (
      <div style={{ position:'fixed', inset:0, zIndex:100, display:'flex', alignItems:'center',
        justifyContent:'center', background:'rgba(0,0,0,0.6)', backdropFilter:'blur(8px)' }}
        onClick={()=>setRunModal(false)}>
        <div style={{ width:460, background:'#0d1117', border:'1px solid rgba(255,255,255,0.12)',
          borderRadius:12, padding:28, boxShadow:'0 32px 80px rgba(0,0,0,0.6)' }}
          onClick={e=>e.stopPropagation()}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
            <h3 style={{ fontFamily:"'Figtree',sans-serif", fontSize:18, fontWeight:700, color:'#fff', margin:0 }}>
              Run Pipeline
            </h3>
            <button onClick={()=>setRunModal(false)} style={{ background:'none', border:'none', cursor:'pointer', color:'#545f72' }}>
              <X size={16}/>
            </button>
          </div>
          <div style={{ marginBottom:20 }}>
            <div style={{ fontSize:11, color:'#545f72', marginBottom:8, fontFamily:"'DM Mono',monospace" }}>
              Pin to a version <em style={{ fontStyle:'italic' }}>(optional — for deploy pipelines)</em>
            </div>
            {loadingV ? (
              <div style={{ color:'#545f72', fontSize:13 }}>Loading versions…</div>
            ) : versions.length === 0 ? (
              <div style={{ color:'#545f72', fontSize:12, fontFamily:"'IBM Plex Mono',monospace" }}>
                No versions available — run a CI build first
              </div>
            ) : (
              <div style={{ display:'flex', flexDirection:'column', gap:5, maxHeight:260, overflowY:'auto' }}>
                <div onClick={()=>setSelVersion('')}
                  style={{ padding:'9px 14px', borderRadius:7, cursor:'pointer',
                    background:selVersion===''?'rgba(0,212,255,0.08)':'rgba(255,255,255,0.02)',
                    border:`1px solid ${selVersion===''?'rgba(0,212,255,0.25)':'rgba(255,255,255,0.07)'}` }}>
                  <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:12,
                    color:selVersion===''?'#00d4ff':'#8892a4' }}>latest commit (no version pin)</span>
                </div>
                {versions.map((v:any)=>(
                  <div key={v.id} onClick={()=>setSelVersion(v.id)}
                    style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 14px', borderRadius:7, cursor:'pointer',
                      background:selVersion===v.id?'rgba(160,120,255,0.08)':'rgba(255,255,255,0.02)',
                      border:`1px solid ${selVersion===v.id?'rgba(160,120,255,0.3)':'rgba(255,255,255,0.07)'}` }}>
                    <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:13, fontWeight:700,
                      color:selVersion===v.id?'#a078ff':'#fff' }}>{v.tag}</span>
                    <span style={{ fontFamily:"'Figtree',sans-serif", fontSize:11, color:'#545f72', flex:1 }}>{v.project_name}</span>
                    <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72' }}>
                      {new Date(v.created_at).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{ display:'flex', gap:10 }}>
            <button onClick={()=>setRunModal(false)} style={{ flex:1, padding:10, background:'transparent',
              border:'1px solid rgba(255,255,255,0.12)', borderRadius:7, color:'#8892a4', cursor:'pointer',
              fontFamily:"'Figtree',sans-serif", fontSize:13 }}>Cancel</button>
            <button onClick={run} style={{ flex:1, padding:10, background:'#00d4ff', color:'#000',
              border:'none', borderRadius:7, fontWeight:700, cursor:'pointer',
              fontFamily:"'Figtree',sans-serif", fontSize:13 }}>
              <Play size={12} fill="#000" style={{ display:'inline', marginRight:6 }}/>
              Run{selVersion?' with version':''}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const deleteProject = async (id: string) => {
    try { await api.deleteProject(id); } catch {}
    setProjects(p => p.filter(x => x.id !== id));
    setBuilds(b => b.filter(x => x.project_id !== id));
    setFolders(f => f.map(fo => ({ ...fo, projects: fo.projects.filter(p => p.id !== id) })));
    if (sel?.id === id) { setSel(null); setView('dashboard'); }
     // best-effort API delete (no delete endpoint yet)
  };

  /* ── sidebar ─────────────────────────────────────────────────────────────── */
  const Sidebar = () => (
    <aside style={{ width:232, flexShrink:0, height:'100vh', position:'sticky', top:0,
      background:'#0d1117', borderRight:'1px solid rgba(255,255,255,0.12)',
      display:'flex', flexDirection:'column', zIndex:10, overflow:'hidden' }}>

      {/* logo — identical to website nav */}
      <div style={{ padding:'15px 16px 13px', borderBottom:'1px solid rgba(255,255,255,0.07)',
        display:'flex', alignItems:'center', gap:10 }}>
        <Logo size={28}/>
        <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:15, fontWeight:600,
          color:'#e8eaf0', letterSpacing:'-0.02em' }}>
          callahan<span style={{ color:'#00d4ff' }}>/ci</span>
        </span>
      </div>

      {/* AI + cmd buttons */}
      <div style={{ padding:'10px 10px 6px', display:'flex', flexDirection:'column', gap:6 }}>
        <button onClick={()=>setAiOpen(true)} style={{ display:'flex', alignItems:'center', gap:9,
          padding:'9px 12px', background:'rgba(0,212,255,0.08)', border:'1px solid rgba(0,212,255,0.2)',
          borderRadius:8, color:'#00d4ff', cursor:'pointer', width:'100%',
          fontFamily:"'Figtree',sans-serif", fontSize:13, fontWeight:600 }}>
          <Sparkles size={14}/>
          Callahan AI
          <span style={{ marginLeft:'auto', fontFamily:"'IBM Plex Mono',monospace", fontSize:10,
            color:'#545f72', background:'#111620', padding:'1px 7px', borderRadius:3 }}>⌘K</span>
        </button>
        <button onClick={()=>setCmdOpen(true)} style={{ display:'flex', alignItems:'center', gap:9,
          padding:'8px 12px', background:'transparent', border:'1px solid rgba(255,255,255,0.12)',
          borderRadius:7, color:'#8892a4', cursor:'pointer', width:'100%',
          fontFamily:"'Figtree',sans-serif", fontSize:12 }}>
          <Command size={13}/> Command palette
        </button>
      </div>

      <div style={{ height:1, background:'rgba(255,255,255,0.07)', margin:'4px 0' }}/>

      {/* project list */}
      <div style={{ flex:1, overflowY:'auto', padding:'6px 8px' }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
          padding:'4px 6px 8px' }}>
          <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
            letterSpacing:'0.1em', textTransform:'uppercase' }}>Projects</span>
          <div style={{ display:'flex', gap:4 }}>
            <button onClick={()=>setAddFolder(true)} title="New folder" style={{ background:'none', border:'none',
              color:'#545f72', cursor:'pointer', padding:3, borderRadius:4, lineHeight:0 }}>
              <FolderOpen size={13}/>
            </button>
            <button onClick={()=>setAddProj(true)} title="New project" style={{ background:'none', border:'none',
              color:'#545f72', cursor:'pointer', padding:3, borderRadius:4, lineHeight:0 }}>
              <Plus size={13}/>
            </button>
          </div>
        </div>

        {folders.map(f => (
          <div key={f.id}>
            <div style={{ display:'flex', alignItems:'center', position:'relative' }}
              onMouseEnter={e=>(e.currentTarget.querySelector('.folder-add') as HTMLElement)?.style && ((e.currentTarget.querySelector('.folder-add') as HTMLElement).style.opacity='1')}
              onMouseLeave={e=>(e.currentTarget.querySelector('.folder-add') as HTMLElement)?.style && ((e.currentTarget.querySelector('.folder-add') as HTMLElement).style.opacity='0')}>
              <button onClick={()=>setFolders(fs=>fs.map(x=>x.id===f.id?{...x,expanded:!x.expanded}:x))}
                style={{ flex:1, display:'flex', alignItems:'center', gap:7, padding:'6px 8px',
                  background:'none', border:'none', cursor:'pointer', borderRadius:6,
                  color:'#8892a4', fontSize:13, fontFamily:"'Figtree',sans-serif" }}>
                <ChevronDown size={11} style={{ transform:f.expanded?'none':'rotate(-90deg)', transition:'0.15s', color:'#545f72' }}/>
                {f.expanded ? <FolderOpen size={13} style={{ color:'#00d4ff' }}/> : <Folder size={13} style={{ color:'#545f72' }}/>}
                <span style={{ fontWeight:500, fontSize:12, flex:1, textAlign:'left' }}>{f.name}</span>
                <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:9, color:'#545f72' }}>
                  {f.projects.length}
                </span>
              </button>
              <button className="folder-add"
                onClick={()=>{ setAddProjToFolder(f.id); setAddProj(true); }}
                title={`Add repo to ${f.name}`}
                style={{ opacity:0, transition:'opacity 0.15s', background:'none', border:'none',
                  cursor:'pointer', color:'#545f72', padding:'4px 6px', lineHeight:0, borderRadius:4 }}
                onMouseEnter={e=>(e.currentTarget.style.color='#00d4ff')}
                onMouseLeave={e=>(e.currentTarget.style.color='#545f72')}>
                <Plus size={12}/>
              </button>
            </div>
            {f.expanded && f.projects.map(p=><ProjRow key={p.id} project={p} depth={1}/>)}
          </div>
        ))}

        {projects.filter(p=>!folders.some(f=>f.projects.find(fp=>fp.id===p.id))).map(p=><ProjRow key={p.id} project={p} depth={0}/>)}

        {projects.length===0 && (
          <button onClick={()=>setAddProj(true)} style={{ width:'100%', padding:12,
            border:'1px dashed rgba(255,255,255,0.12)', borderRadius:8, background:'none',
            color:'#545f72', fontSize:12, cursor:'pointer', marginTop:8,
            fontFamily:"'Figtree',sans-serif" }}>
            + Connect repository
          </button>
        )}
      </div>

      <div style={{ height:1, background:'rgba(255,255,255,0.07)' }}/>

      {/* per-project nav */}
      {sel && (
        <div style={{ padding:'8px 8px' }}>
          {(['dashboard','builds','pipeline'] as const).map(v=>{
            const icons = {
              dashboard:<Activity size={13}/>, builds:<Zap size={13}/>,
              pipeline:<GitBranch size={13}/>
            } as Record<string,React.ReactNode>;
            const active = view===v;
            return (
              <button key={v} onClick={()=>setView(v)} style={{ display:'flex', alignItems:'center',
                gap:9, padding:'8px 10px', width:'100%', marginBottom:2,
                background: active?'rgba(0,212,255,0.08)':'none',
                border: active?'1px solid rgba(0,212,255,0.15)':'1px solid transparent',
                borderRadius:6, color: active?'#00d4ff':'#8892a4', cursor:'pointer',
                fontSize:13, fontFamily:"'Figtree',sans-serif", textTransform:'capitalize' }}>
                {icons[v]}{v}
              </button>
            );
          })}
        </div>
      )}

      {/* status dot + bottom nav */}
      <div style={{ padding:'10px 10px 10px', borderTop:'1px solid rgba(255,255,255,0.07)', display:'flex', flexDirection:'column', gap:2 }}>

        {/* Secrets */}
        <button onClick={()=>setView('secrets')}
          style={{ display:'flex', alignItems:'center', gap:7, width:'100%', padding:'7px 10px',
            background: view==='secrets' ? 'rgba(0,212,255,0.06)' : 'transparent',
            border: view==='secrets' ? '1px solid rgba(0,212,255,0.15)' : '1px solid transparent',
            borderRadius:6, cursor:'pointer', textAlign:'left' }}>
          <Lock size={13} color={view==='secrets' ? '#00d4ff' : '#545f72'}/>
          <span style={{ fontFamily:"'Figtree',sans-serif", fontSize:12,
            color: view==='secrets' ? '#00d4ff' : '#545f72', fontWeight:500 }}>Secrets</span>
        </button>

        {/* Settings */}
        <button onClick={()=>setView('settings')}
          style={{ display:'flex', alignItems:'center', gap:7, width:'100%', padding:'7px 10px',
            background: view==='settings' ? 'rgba(0,212,255,0.06)' : 'transparent',
            border: view==='settings' ? '1px solid rgba(0,212,255,0.15)' : '1px solid transparent',
            borderRadius:6, cursor:'pointer', textAlign:'left' }}>
          <Settings size={13} color={view==='settings' ? '#00d4ff' : '#545f72'}/>
          <span style={{ fontFamily:"'Figtree',sans-serif", fontSize:12,
            color: view==='settings' ? '#00d4ff' : '#545f72', fontWeight:500 }}>Settings</span>
        </button>

        {/* LLM Config */}
        <button onClick={()=>setView('llm-config')}
          style={{ display:'flex', alignItems:'center', gap:7, width:'100%', padding:'7px 10px',
            background: view==='llm-config' ? 'rgba(160,120,255,0.1)' : 'transparent',
            border: view==='llm-config' ? '1px solid rgba(160,120,255,0.3)' : '1px solid transparent',
            borderRadius:6, cursor:'pointer', textAlign:'left' }}>
          <Sparkles size={13} color={view==='llm-config' ? '#a078ff' : '#545f72'}/>
          <span style={{ fontFamily:"'Figtree',sans-serif", fontSize:12,
            color: view==='llm-config' ? '#a078ff' : '#545f72', fontWeight:500 }}>Configure AI / LLM</span>
        </button>

        {/* API status */}
        <div style={{ display:'flex', alignItems:'center', gap:7, padding:'6px 10px 0' }}>
          <span style={{ width:6, height:6, borderRadius:'50%', background:'#00e5a0',
            boxShadow:'0 0 6px #00e5a0', display:'inline-block',
            animation:'blink 2s ease-in-out infinite' }}/>
          <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
            letterSpacing:'0.04em' }}>API :8080</span>
        </div>
      </div>
    </aside>
  );

  const ProjRow = ({ project:p, depth }: { project:Project; depth:number }) => {
    const active = sel?.id===p.id;
    const [hov, setHov] = useState(false);
    const [confirmDel, setConfirmDel] = useState(false);
    const dotColor = p.status==='success'?'#00e5a0':p.status==='running'?'#00d4ff':p.status==='failed'?'#ff4455':'#545f72';
    return (
      <div style={{ position:'relative' }}
        onMouseEnter={()=>setHov(true)}
        onMouseLeave={()=>{ setHov(false); setConfirmDel(false); }}>
        <button onClick={()=>{ setSel(p); setView('dashboard'); }} style={{
          display:'flex', alignItems:'center', gap:8,
          padding:`7px ${hov?28:8}px 7px ${8+depth*16}px`, width:'100%', marginBottom:2,
          background: active?'rgba(0,212,255,0.06)':'none',
          border: active?'1px solid rgba(0,212,255,0.15)':'1px solid transparent',
          borderRadius:6, cursor:'pointer', color: active?'#e8eaf0':'#8892a4',
          fontSize:13, fontFamily:"'Figtree',sans-serif", textAlign:'left',
          transition:'padding 0.1s' }}>
          <span style={{ width:6, height:6, borderRadius:'50%', background:dotColor, flexShrink:0 }}/>
          <span style={{ flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
            fontWeight: active?600:400 }}>{p.name}</span>
        </button>
        {hov && !confirmDel && (
          <button onClick={e=>{ e.stopPropagation(); setConfirmDel(true); }}
            title="Remove project"
            style={{ position:'absolute', right:6, top:'50%', transform:'translateY(-50%)',
              background:'none', border:'none', cursor:'pointer', color:'#545f72',
              padding:3, lineHeight:0, borderRadius:4 }}
            onMouseEnter={e=>(e.currentTarget.style.color='#ff4455')}
            onMouseLeave={e=>(e.currentTarget.style.color='#545f72')}>
            <Trash2 size={12}/>
          </button>
        )}
        {confirmDel && (
          <div style={{ position:'absolute', right:4, top:'50%', transform:'translateY(-50%)',
            display:'flex', alignItems:'center', gap:4, zIndex:20 }}>
            <span style={{ fontSize:11, color:'#8892a4', fontFamily:"'Figtree',sans-serif", whiteSpace:'nowrap' }}>Remove?</span>
            <button onClick={e=>{ e.stopPropagation(); deleteProject(p.id); }}
              style={{ padding:'2px 8px', background:'rgba(255,68,85,0.15)',
                border:'1px solid rgba(255,68,85,0.3)', borderRadius:4,
                color:'#ff4455', cursor:'pointer', fontSize:11,
                fontFamily:"'Figtree',sans-serif" }}>Yes</button>
            <button onClick={e=>{ e.stopPropagation(); setConfirmDel(false); }}
              style={{ padding:'2px 6px', background:'none',
                border:'1px solid rgba(255,255,255,0.12)', borderRadius:4,
                color:'#545f72', cursor:'pointer', fontSize:11,
                fontFamily:"'Figtree',sans-serif" }}>No</button>
          </div>
        )}
      </div>
    );
  };

  /* ── top bar ──────────────────────────────────────────────────────────────── */
  const TopBar = () => (
    <div style={{ height:52, borderBottom:'1px solid rgba(255,255,255,0.12)',
      display:'flex', alignItems:'center', justifyContent:'space-between', padding:'0 24px',
      background:'rgba(8,10,15,0.8)', backdropFilter:'blur(20px)',
      position:'sticky', top:0, zIndex:5, flexShrink:0 }}>
      <div style={{ display:'flex', alignItems:'center', gap:6,
        fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:'#545f72' }}>
        <span>callahan</span>
        {sel && <><ChevronRight size={12}/><span style={{ color:'#8892a4' }}>{sel.name}</span></>}
        {sel && <><ChevronRight size={12}/><span style={{ color:'#00d4ff', textTransform:'capitalize' }}>{view}</span></>}
      </div>
      <div style={{ display:'flex', gap:8 }}>
        <button onClick={()=>setCmdOpen(true)} style={{ display:'flex', alignItems:'center', gap:6,
          padding:'6px 12px', background:'transparent', border:'1px solid rgba(255,255,255,0.12)',
          borderRadius:6, color:'#545f72', cursor:'pointer', fontSize:12,
          fontFamily:"'IBM Plex Mono',monospace" }}>
          <Command size={12}/> ⌘K
        </button>
        {sel && (
          <button onClick={()=>setRunModal(true)} style={{ display:'flex', alignItems:'center', gap:6,
            padding:'7px 14px', background:'#00d4ff', color:'#000', border:'none',
            borderRadius:6, fontSize:12, fontWeight:700, cursor:'pointer',
            fontFamily:"'Figtree',sans-serif" }}>
            <Play size={12} fill="#000"/> Run Build
          </button>
        )}
      </div>
    </div>
  );

  /* ── welcome ──────────────────────────────────────────────────────────────── */
  const Welcome = () => (
    <div style={{ display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
      flex:1, padding:64, textAlign:'center' }}>
      <Logo size={52}/>
      <h1 style={{ fontFamily:"'Figtree',sans-serif", fontSize:40, fontWeight:900,
        letterSpacing:'-0.04em', color:'#fff', margin:'24px 0 14px', lineHeight:1.05 }}>
        CI/CD that thinks<br/>for itself.
      </h1>
      <p style={{ color:'#8892a4', fontSize:16, maxWidth:400, lineHeight:1.7, marginBottom:36 }}>
        Connect a repository to run AI-powered pipelines locally. No cloud. No agents.
      </p>
      <div style={{ display:'flex', gap:12, marginBottom:52 }}>
        <button onClick={()=>setAddProj(true)} style={{ display:'flex', alignItems:'center', gap:8,
          padding:'13px 24px', background:'#00d4ff', color:'#000', border:'none',
          borderRadius:8, fontSize:14, fontWeight:700, cursor:'pointer',
          fontFamily:"'Figtree',sans-serif" }}>
          <Plus size={16}/> Connect Repository
        </button>
        <button onClick={()=>setAiOpen(true)} style={{ display:'flex', alignItems:'center', gap:8,
          padding:'13px 24px', background:'transparent', color:'#8892a4',
          border:'1px solid rgba(255,255,255,0.12)', borderRadius:8,
          fontSize:14, cursor:'pointer', fontFamily:"'Figtree',sans-serif" }}>
          <Sparkles size={16} style={{ color:'#00d4ff' }}/> Ask Callahan AI
        </button>
      </div>
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:12, maxWidth:660, width:'100%' }}>
        {[
          { icon:<Zap size={18} style={{ color:'#00d4ff' }}/>,     label:'Serverless', desc:'Every job in a fresh container. Cold start < 2s.' },
          { icon:<Sparkles size={18} style={{ color:'#a078ff' }}/>, label:'AI Agents',  desc:'Debug, review, generate pipelines in plain English.' },
          { icon:<Shield size={18} style={{ color:'#00e5a0' }}/>,   label:'Security',   desc:'Trivy, Semgrep, gitleaks — zero config required.' },
        ].map(f=>(
          <Card key={f.label}>
            <div style={{ marginBottom:10 }}>{f.icon}</div>
            <div style={{ fontSize:13, fontWeight:700, color:'#fff', marginBottom:6,
              fontFamily:"'Figtree',sans-serif", letterSpacing:'-0.01em' }}>{f.label}</div>
            <div style={{ fontSize:12, color:'#8892a4', lineHeight:1.65,
              fontFamily:"'Figtree',sans-serif" }}>{f.desc}</div>
          </Card>
        ))}
      </div>
    </div>
  );

  /* ── dashboard ────────────────────────────────────────────────────────────── */
  const Dashboard = () => (
    <div style={{ padding:28 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
        <div>
          <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:6 }}>
            <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, letterSpacing:'0.08em',
              textTransform:'uppercase', padding:'3px 8px', borderRadius:4,
              background:'rgba(0,212,255,0.08)', border:'1px solid rgba(0,212,255,0.2)', color:'#00d4ff' }}>
              project
            </span>
            <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10,
              color:'rgba(0,229,160,0.8)', letterSpacing:'0.08em',
              background:'rgba(0,229,160,0.08)', border:'1px solid rgba(0,229,160,0.2)',
              padding:'3px 8px', borderRadius:4 }}>
              {sel?.branch}
            </span>
          </div>
          <h2 style={{ fontFamily:"'Figtree',sans-serif", fontSize:26, fontWeight:800,
            color:'#fff', letterSpacing:'-0.03em', margin:0 }}>{sel?.name}</h2>
        </div>
        <button onClick={()=>setRunModal(true)} style={{ display:'flex', alignItems:'center', gap:8,
          padding:'10px 22px', background:'#00d4ff', color:'#000', border:'none',
          borderRadius:8, fontSize:13, fontWeight:700, cursor:'pointer',
          fontFamily:"'Figtree',sans-serif" }}>
          <Play size={14} fill="#000"/> Run Build
        </button>
      </div>

      {/* stat cards */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:10, marginBottom:20 }}>
        {[
          { label:'Total Builds',  value: projBuilds.length.toString(), mono:true },
          { label:'Success Rate',  value: projBuilds.length?`${Math.round(projBuilds.filter(b=>b.status==='success').length/projBuilds.length*100)}%`:'—', color:'#00e5a0', mono:true },
          { label:'Avg Duration',  value: formatDuration(projBuilds.filter(b=>b.duration).reduce((a,b)=>a+b.duration,0)/Math.max(projBuilds.filter(b=>b.duration).length,1)), mono:true },
          { label:'Status',        value: sel?.status??'—', badge:true },
        ].map(s=>(
          <Card key={s.label}>
            <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
              letterSpacing:'0.08em', textTransform:'uppercase', marginBottom:10 }}>{s.label}</div>
            {s.badge
              ? <Badge status={s.value}/>
              : <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:26, fontWeight:700,
                  color: s.color??'#fff', letterSpacing:'-0.03em', lineHeight:1 }}>{s.value}</div>}
          </Card>
        ))}
      </div>

      {/* recent builds */}
      <Card>
        <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
          letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:16 }}>Recent Builds</div>
        {projBuilds.length===0
          ? <div style={{ textAlign:'center', padding:'32px 0', color:'#545f72', fontSize:13 }}>No builds yet — click Run Build</div>
          : projBuilds.slice(0,6).map((b,i)=>(
            <div key={b.id} onClick={()=>{ setSelBuild(b); setView('builds'); }}
              style={{ display:'flex', alignItems:'center', gap:14, padding:'12px 0',
                borderBottom: i<Math.min(projBuilds.length,6)-1?'1px solid rgba(255,255,255,0.07)':'none',
                cursor:'pointer' }}>
              <Badge status={b.status}/>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, color:'#fff', fontWeight:500, marginBottom:2,
                  overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                  fontFamily:"'Figtree',sans-serif" }}>{b.commit_message}</div>
                <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#545f72' }}>
                  {b.commit_sha?.slice(0,7)} · {b.branch}
                </div>
              </div>
              <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11,
                color:'#545f72', textAlign:'right', flexShrink:0 }}>
                {b.duration?formatDuration(b.duration):'—'}<br/>{timeAgo(b.created_at)}
              </div>
            </div>
          ))
        }
      </Card>
    </div>
  );

  /* ── builds ───────────────────────────────────────────────────────────────── */
  function Builds() {
    const [jobs, setJobs] = useState<any[]>([]);
    const [steps, setSteps] = useState({} as Record<string, any[]>);
    const [expanded, setExpanded] = useState({} as Record<string, boolean>);

    useEffect(() => {
      if (!selBuild || selBuild.status === 'running') return;
      const load = async () => {
        try {
          const res = await fetch(`http://localhost:8080/api/v1/builds/${selBuild.id}/jobs`);
          const js = await res.json();
          if (!Array.isArray(js)) return;
          setJobs(js);
          const allExpanded = {} as Record<string, boolean>;
          const allSteps = {} as Record<string, any[]>;
          for (const job of js) {
            allExpanded[job.id] = true;
            const sr = await fetch(`http://localhost:8080/api/v1/jobs/${job.id}/steps`);
            const ss = await sr.json();
            allSteps[job.id] = Array.isArray(ss) ? ss : [];
          }
          setSteps(allSteps);
          setExpanded(allExpanded);
        } catch {}
      };
      load();
    }, [selBuild?.id, selBuild?.status]);

    const dur = (b: Build) => b.duration_ms || b.duration;

    return (
    <div style={{ padding:28 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
        <h2 style={{ fontFamily:"'Figtree',sans-serif", fontSize:22, fontWeight:800,
          color:'#fff', letterSpacing:'-0.03em', margin:0 }}>Builds</h2>
        <button onClick={()=>setRunModal(true)} style={{ display:'flex', alignItems:'center', gap:7,
          padding:'9px 20px', background:'#00d4ff', color:'#000', border:'none',
          borderRadius:7, fontSize:13, fontWeight:700, cursor:'pointer',
          fontFamily:"'Figtree',sans-serif" }}>
          <Play size={13} fill="#000"/> Run Build
        </button>
      </div>

      {selBuild ? (
        <div style={{ display:'flex', gap:16, alignItems:'flex-start' }}>

          {/* ── Left: build history sidebar ── */}
          <div style={{ width:176, flexShrink:0 }}>
            <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
              letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:10, paddingLeft:4 }}>
              Build History
            </div>
            <div style={{ display:'flex', flexDirection:'column', gap:3 }}>
              {projBuilds.map(b => {
                const active = b.id === selBuild.id;
                const col = b.status==='success'?'#00e5a0':b.status==='failed'?'#ff4455':b.status==='running'?'#00d4ff':'#545f72';
                return (
                  <div key={b.id} onClick={()=>{ setSelBuild(b); setJobs([]); setSteps({}); }}
                    style={{ display:'flex', alignItems:'center', gap:8, padding:'8px 10px', borderRadius:6, cursor:'pointer',
                      background:active?'rgba(0,212,255,0.08)':'rgba(255,255,255,0.02)',
                      border:`1px solid ${active?'rgba(0,212,255,0.2)':'rgba(255,255,255,0.06)'}` }}>
                    <span style={{ width:7, height:7, borderRadius:'50%', background:col, flexShrink:0,
                      boxShadow:b.status==='running'?`0 0 6px ${col}`:'none' }}/>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11,
                        color:active?'#00d4ff':'#e8eaf0', fontWeight:active?700:400 }}>
                        #{b.number || b.id.slice(0,4)}
                      </div>
                      <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:9,
                        color:'#545f72', marginTop:1 }}>{timeAgo(b.created_at)}</div>
                    </div>
                    {dur(b) ? (
                      <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:9,
                        color:'#545f72', flexShrink:0 }}>{formatDuration(dur(b))}</div>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <button onClick={()=>{ setSelBuild(null); setJobs([]); setSteps({}); }}
              style={{ marginTop:12, width:'100%', padding:'7px', background:'transparent',
                border:'1px solid rgba(255,255,255,0.08)', borderRadius:6, color:'#545f72',
                cursor:'pointer', fontSize:11, fontFamily:"'Figtree',sans-serif" }}>
              ← All Builds
            </button>
          </div>

          {/* ── Right: build detail ── */}
          <div style={{ flex:1, minWidth:0 }}>
            <Card style={{ marginBottom:12 }}>
              <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:16, marginBottom:16 }}>
                {[
                  { l:'Status',   n:<Badge status={selBuild.status}/> },
                  { l:'Branch',   n:<span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:'#00d4ff' }}>{selBuild.branch}</span> },
                  { l:'Commit',   n:<span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:'#8892a4' }}>{selBuild.commit_sha?.slice(0,7)||'—'}</span> },
                  { l:'Duration', n:<span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:'#8892a4' }}>{dur(selBuild)?formatDuration(dur(selBuild)):'—'}</span> },
                ].map(m=>(
                  <div key={m.l}>
                    <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
                      letterSpacing:'0.08em', textTransform:'uppercase', marginBottom:8 }}>{m.l}</div>
                    {m.n}
                  </div>
                ))}
              </div>
              <div style={{ fontSize:13, color:'#8892a4', fontFamily:"'Figtree',sans-serif" }}>{selBuild.commit_message}</div>
            </Card>

            {/* Running build — live log */}
            {selBuild.status === 'running' && (
              <Card style={{ marginBottom:12 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                  <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
                    letterSpacing:'0.1em', textTransform:'uppercase' }}>Live Log</span>
                  <button onClick={async () => {
                    if (!selBuild) return;
                    setAiOpen(true); setLoading(true);
                    let logText = '';
                    try {
                      const jr = await fetch(`http://localhost:8080/api/v1/builds/${selBuild.id}/jobs`);
                      const js = await jr.json();
                      for (const job of (Array.isArray(js)?js:[])) {
                        const sr = await fetch(`http://localhost:8080/api/v1/jobs/${job.id}/steps`);
                        const ss = await sr.json();
                        for (const step of (Array.isArray(ss)?ss:[])) {
                          logText += `[${step.name}] ${step.status}\n${step.log||''}\n`;
                        }
                      }
                    } catch { logText = 'Could not retrieve logs'; }
                    setMsgs(m=>[...m,{role:'user',content:`Explain this build failure for "${sel?.name}":\n\n${logText||'No log output available.'}`}]);
                    try {
                      const r = await fetch('http://localhost:8080/api/v1/ai/explain-build', {
                        method:'POST', headers:{'Content-Type':'application/json'},
                        body: JSON.stringify({ build_id: selBuild.id, logs: logText, pipeline: '' }),
                      });
                      const d = await r.json();
                      setMsgs(m=>[...m,{role:'assistant',content:d.explanation||'No explanation returned.'}]);
                    } catch { setMsgs(m=>[...m,{role:'assistant',content:'Backend offline.'}]); }
                    setLoading(false);
                  }} style={{ display:'flex', alignItems:'center', gap:6, padding:'5px 12px',
                    background:'rgba(160,120,255,0.08)', border:'1px solid rgba(160,120,255,0.2)',
                    borderRadius:5, color:'#a078ff', cursor:'pointer', fontSize:12,
                    fontFamily:"'Figtree',sans-serif" }}>
                    <Sparkles size={12}/> AI Explain
                  </button>
                </div>
                <RunningLog build={selBuild} onStop={async ()=>{
                  try {
                    const res = await fetch(`http://localhost:8080/api/v1/builds/${selBuild.id}`);
                    if (res.ok) {
                      const updated = await res.json();
                      setBuilds(b=>b.map(x=>x.id===selBuild.id?{...x,...updated}:x));
                      setSelBuild(s=>s?{...s,...updated}:s);
                    } else {
                      setBuilds(b=>b.map(x=>x.id===selBuild.id?{...x,status:'cancelled'}:x));
                      setSelBuild(s=>s?{...s,status:'cancelled'}:s);
                    }
                  } catch {
                    setBuilds(b=>b.map(x=>x.id===selBuild.id?{...x,status:'cancelled'}:x));
                    setSelBuild(s=>s?{...s,status:'cancelled'}:s);
                  }
                }}/>
              </Card>
            )}

            {/* Completed build — step breakdown */}
            {selBuild.status !== 'running' && (
              <div>
                {selBuild.status === 'failed' && (
                  <div style={{ marginBottom:12, display:'flex', justifyContent:'flex-end' }}>
                    <button onClick={async () => {
                      if (!selBuild) return;
                      setAiOpen(true); setLoading(true);
                      let logText = '';
                      for (const job of jobs) {
                        for (const step of (steps[job.id]||[])) {
                          logText += `[${step.name}] ${step.status}\n${step.log||''}\n`;
                        }
                      }
                      setMsgs(m=>[...m,{role:'user',content:`Explain this build failure for "${sel?.name}":\n\n${logText||'No logs.'}`}]);
                      try {
                        const r = await fetch('http://localhost:8080/api/v1/ai/explain-build', {
                          method:'POST', headers:{'Content-Type':'application/json'},
                          body: JSON.stringify({ build_id: selBuild.id, logs: logText, pipeline: '' }),
                        });
                        const d = await r.json();
                        setMsgs(m=>[...m,{role:'assistant',content:d.explanation||'No explanation returned.'}]);
                      } catch { setMsgs(m=>[...m,{role:'assistant',content:'Backend offline.'}]); }
                      setLoading(false);
                    }} style={{ display:'flex', alignItems:'center', gap:6, padding:'7px 14px',
                      background:'rgba(160,120,255,0.1)', border:'1px solid rgba(160,120,255,0.25)',
                      borderRadius:7, color:'#a078ff', cursor:'pointer', fontSize:12,
                      fontFamily:"'Figtree',sans-serif", fontWeight:600 }}>
                      <Sparkles size={13}/> AI Explain Failure
                    </button>
                  </div>
                )}

                {jobs.length === 0 && (
                  <Card>
                    <div style={{ textAlign:'center', padding:'24px 0', color:'#545f72',
                      fontSize:13, fontFamily:"'Figtree',sans-serif" }}>
                      No step data — trigger a new build to see results
                    </div>
                  </Card>
                )}

                {jobs.map(job => {
                  const jobSteps = steps[job.id] || [];
                  const isExpanded = expanded[job.id] !== false;
                  const testResults = jobSteps.flatMap(s => parseTestResults(s.log||''));
                  const passed = testResults.filter(t=>t.status==='pass').length;
                  const failed = testResults.filter(t=>t.status==='fail').length;
                  const skipped = testResults.filter(t=>t.status==='skip').length;
                  return (
                    <Card key={job.id} style={{ marginBottom:10 }}>
                      <div onClick={()=>setExpanded(e=>({...e,[job.id]:!isExpanded}))}
                        style={{ display:'flex', alignItems:'center', gap:12, cursor:'pointer',
                          marginBottom:isExpanded?14:0 }}>
                        <span style={{ fontSize:14, color:stepStatusColor(job.status), fontWeight:700 }}>
                          {stepStatusIcon(job.status)}
                        </span>
                        <span style={{ fontFamily:"'Figtree',sans-serif", fontSize:14,
                          fontWeight:700, color:'#fff', flex:1 }}>{job.name}</span>
                        {testResults.length > 0 && (
                          <div style={{ display:'flex', gap:8, fontFamily:"'IBM Plex Mono',monospace", fontSize:11 }}>
                            {passed>0 && <span style={{ color:'#00e5a0' }}>✔ {passed} passed</span>}
                            {failed>0 && <span style={{ color:'#ff4455' }}>✖ {failed} failed</span>}
                            {skipped>0 && <span style={{ color:'#545f72' }}>⊘ {skipped} skipped</span>}
                          </div>
                        )}
                        <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#545f72' }}>
                          {job.duration_ms?`${(job.duration_ms/1000).toFixed(1)}s`:''}
                        </span>
                        <ChevronDown size={13} style={{ color:'#545f72',
                          transform:isExpanded?'none':'rotate(-90deg)', transition:'0.15s' }}/>
                      </div>
                      {isExpanded && (
                        <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                          {jobSteps.map(step => <StepRow key={step.id} step={step}/>)}
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
          {projBuilds.map(b=>(
            <Card key={b.id} onClick={()=>setSelBuild(b)} style={{ padding:'14px 20px' }}>
              <div style={{ display:'flex', alignItems:'center', gap:14 }}>
                <Badge status={b.status}/>
                <div style={{ flex:1, minWidth:0 }}>
                  <div style={{ fontSize:14, color:'#fff', fontWeight:500, marginBottom:3,
                    overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                    fontFamily:"'Figtree',sans-serif" }}>{b.commit_message}</div>
                  <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#545f72',
                    display:'flex', gap:12 }}>
                    <span>#{b.number||''}</span>
                    <span>{b.commit_sha?.slice(0,7)}</span>
                    <span>{b.branch}</span>
                    <span>{timeAgo(b.created_at)}</span>
                  </div>
                </div>
                <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:'#545f72', flexShrink:0 }}>
                  {dur(b)?formatDuration(dur(b)):'—'}
                </div>
                <ChevronRight size={14} style={{ color:'#545f72' }}/>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
    ); }

  /* ── pipeline ─────────────────────────────────────────────────────────────── */
  function Pipeline() {
    const [yaml, setYaml] = useState('');
    const [saving, setSaving] = useState(false);
    const [saveMsg, setSaveMsg] = useState('');

    useEffect(() => {
      if (!sel) return;
      fetch(`http://localhost:8080/api/v1/projects/${sel.id}/pipeline`)
        .then(r=>r.json())
        .then(d=>{ if(d.content) setYaml(d.content); })
        .catch(()=>{});
    }, [sel?.id]);

    const save = async () => {
      if (!sel || !yaml) return;
      setSaving(true);
      setSaveMsg('');
      try {
        const res = await fetch(`http://localhost:8080/api/v1/projects/${sel.id}/pipeline`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: yaml }),
        });
        const d = await res.json();
        setSaveMsg(res.ok ? (d.message || '✔ Saved') : ('✖ ' + (d.error || 'Save failed')));
      } catch { setSaveMsg('✖ Backend offline'); }
      setSaving(false);
      setTimeout(() => setSaveMsg(''), 4000);
    };

    return (
      <div style={{ padding:28 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
          <h2 style={{ fontFamily:"'Figtree',sans-serif", fontSize:22, fontWeight:800,
            color:'#fff', letterSpacing:'-0.03em', margin:0 }}>Pipeline</h2>
          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
            {saveMsg && (
              <span style={{ fontFamily:"'Figtree',sans-serif", fontSize:12,
                color: saveMsg.startsWith('✖') ? '#ff4455' : '#00e5a0' }}>{saveMsg}</span>
            )}
            <button onClick={()=>sendAiMessage(`Generate a Callahanfile.yaml pipeline for my ${sel?.language??'Go'} project called ${sel?.name??'my-project'}. Return only the YAML, no explanation.`)} style={{ display:'flex', alignItems:'center', gap:7,
              padding:'9px 16px', background:'rgba(0,212,255,0.08)', border:'1px solid rgba(0,212,255,0.2)',
              borderRadius:7, color:'#00d4ff', cursor:'pointer', fontSize:13,
              fontFamily:"'Figtree',sans-serif" }}>
              <Sparkles size={13}/> Generate with AI
            </button>
            <button onClick={save} disabled={saving} style={{ padding:'9px 18px',
              background: saving ? '#111620' : '#00d4ff', color: saving ? '#545f72' : '#000', border:'none',
              borderRadius:7, fontSize:13, fontWeight:700, cursor: saving ? 'wait' : 'pointer',
              fontFamily:"'Figtree',sans-serif" }}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
        <Card>
          <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
            letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:12 }}>Callahanfile.yaml</div>
          <textarea value={yaml} onChange={e=>setYaml(e.target.value)} style={{ width:'100%',
            minHeight:420, background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
            borderRadius:8, padding:20, fontFamily:"'IBM Plex Mono',monospace", fontSize:13,
            color:'#8892a4', lineHeight:1.9, resize:'vertical', outline:'none' }}/>
        </Card>
      </div>
    );
  };

  /* ── secrets ──────────────────────────────────────────────────────────────── */
  function Secrets() {
    const [list, setList]   = useState<{key:string;updated:string}[]>([]);
    const [adding, setAdding] = useState(false);
    const [newKey, setNewKey] = useState('');
    const [newVal, setNewVal] = useState('');
    const keyRef = useRef<HTMLInputElement>(null);
    useEffect(()=>{ if(adding) setTimeout(()=>keyRef.current?.focus(),50); },[adding]);
    const save = () => {
      if(!newKey.trim()) return;
      setList(l=>[...l,{key:newKey.trim().toUpperCase().replace(/\s+/g,'_'), updated:'just now'}]);
      setNewKey(''); setNewVal(''); setAdding(false);
    };
    return (
      <div style={{ padding:28 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
          <h2 style={{ fontFamily:"'Figtree',sans-serif", fontSize:22, fontWeight:800,
            color:'#fff', letterSpacing:'-0.03em', margin:0 }}>Secrets</h2>
          {!adding && <button onClick={()=>setAdding(true)} style={{ display:'flex', alignItems:'center', gap:7,
            padding:'9px 18px', background:'#00d4ff', color:'#000', border:'none',
            borderRadius:7, fontSize:13, fontWeight:700, cursor:'pointer',
            fontFamily:"'Figtree',sans-serif" }}><Plus size={14}/> Add Secret</button>}
        </div>
        {adding && (
          <Card style={{ marginBottom:12 }}>
            <div style={{ fontSize:10, color:'#545f72', letterSpacing:'0.1em', textTransform:'uppercase',
              fontFamily:"'IBM Plex Mono',monospace", marginBottom:14 }}>New Secret</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:10, marginBottom:14 }}>
              <div>
                <div style={{ fontSize:11, color:'#545f72', marginBottom:5, fontFamily:"'Figtree',sans-serif" }}>Key Name</div>
                <input ref={keyRef} value={newKey} onChange={e=>setNewKey(e.target.value)}
                  onKeyDown={e=>e.key==='Enter'&&save()} placeholder="MY_API_KEY"
                  style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                    borderRadius:6, padding:'9px 12px', color:'#e8eaf0',
                    fontFamily:"'IBM Plex Mono',monospace", fontSize:12, outline:'none' }}/>
              </div>
              <div>
                <div style={{ fontSize:11, color:'#545f72', marginBottom:5, fontFamily:"'Figtree',sans-serif" }}>Value</div>
                <input type="password" value={newVal} onChange={e=>setNewVal(e.target.value)}
                  onKeyDown={e=>e.key==='Enter'&&save()} placeholder="sk-..."
                  style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                    borderRadius:6, padding:'9px 12px', color:'#e8eaf0',
                    fontFamily:"'IBM Plex Mono',monospace", fontSize:12, outline:'none' }}/>
              </div>
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={()=>{setAdding(false);setNewKey('');setNewVal('');}}
                style={{ padding:'8px 16px', background:'transparent', border:'1px solid rgba(255,255,255,0.12)',
                  borderRadius:6, color:'#8892a4', cursor:'pointer', fontSize:12,
                  fontFamily:"'Figtree',sans-serif" }}>Cancel</button>
              <button onClick={save} style={{ padding:'8px 16px', background:'#00d4ff', color:'#000',
                border:'none', borderRadius:6, fontWeight:700, cursor:'pointer',
                fontSize:12, fontFamily:"'Figtree',sans-serif" }}>Save Secret</button>
            </div>
          </Card>
        )}
        <Card>
          {list.length===0 ? (
            <div style={{ textAlign:'center', padding:'32px 0', color:'#545f72',
              fontSize:13, fontFamily:"'Figtree',sans-serif" }}>
              No secrets yet — click Add Secret to store API keys and tokens
            </div>
          ) : list.map((s,i)=>(
            <div key={s.key} style={{ display:'flex', alignItems:'center', gap:14, padding:'14px 0',
              borderBottom:i<list.length-1?'1px solid rgba(255,255,255,0.07)':'none' }}>
              <Lock size={14} style={{ color:'#545f72' }}/>
              <div style={{ flex:1 }}>
                <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:13, color:'#fff', marginBottom:2 }}>{s.key}</div>
                <div style={{ fontSize:11, color:'#545f72', fontFamily:"'Figtree',sans-serif" }}>Updated {s.updated}</div>
              </div>
              <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#545f72' }}>••••••••</span>
              <button onClick={()=>setList(l=>l.filter(x=>x.key!==s.key))}
                style={{ background:'none', border:'none', cursor:'pointer', color:'#545f72', padding:4, lineHeight:0 }}
                onMouseEnter={e=>(e.currentTarget.style.color='#ff4455')}
                onMouseLeave={e=>(e.currentTarget.style.color='#545f72')}>
                <Trash2 size={13}/>
              </button>
            </div>
          ))}
        </Card>
      </div>
    );
  };

  const SettingsView = () => {
    const [name,   setName]   = useState(sel?.name     ?? '');
    const [repo,   setRepo]   = useState(sel?.repo_url ?? '');
    const [branch, setBranch] = useState(sel?.branch   ?? 'main');
    const [saved,  setSaved]  = useState(false);
    const [confirmDel, setConfirmDel] = useState(false);
    const save = () => {
      if(!sel) return;
      setProjects(p=>p.map(x=>x.id===sel.id?{...x,name,repo_url:repo,branch}:x));
      setSel(s=>s?{...s,name,repo_url:repo,branch}:s);
      setSaved(true); setTimeout(()=>setSaved(false),2000);
    };
    return (
      <div style={{ padding:28 }}>
        <h2 style={{ fontFamily:"'Figtree',sans-serif", fontSize:22, fontWeight:800,
          color:'#fff', letterSpacing:'-0.03em', marginBottom:24 }}>Settings</h2>
        <Card style={{ marginBottom:12 }}>
          <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
            letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:18 }}>Project</div>
          {([['Project Name',name,setName],['Repository URL',repo,setRepo],['Default Branch',branch,setBranch]] as [string,string,(v:string)=>void][]).map(([l,v,s])=>(
            <div key={l} style={{ marginBottom:14 }}>
              <div style={{ fontSize:12, color:'#545f72', marginBottom:5, fontFamily:"'Figtree',sans-serif" }}>{l}</div>
              <input value={v} onChange={e=>s(e.target.value)}
                style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                  borderRadius:6, padding:'9px 12px', color:'#e8eaf0',
                  fontFamily:"'Figtree',sans-serif", fontSize:13, outline:'none' }}/>
            </div>
          ))}
          <button onClick={save} style={{ padding:'9px 20px',
            background:saved?'#00e5a0':'#00d4ff', color:'#000', border:'none',
            borderRadius:7, fontWeight:700, fontSize:13, cursor:'pointer',
            fontFamily:"'Figtree',sans-serif", transition:'background 0.2s' }}>
            {saved ? '✔ Saved' : 'Save Changes'}
          </button>
        </Card>
        <Card>
          <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
            letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:12 }}>Danger Zone</div>
          <p style={{ fontSize:13, color:'#8892a4', marginBottom:14, lineHeight:1.6,
            fontFamily:"'Figtree',sans-serif" }}>
            Permanently removes this project and all build history. This cannot be undone.
          </p>
          {!confirmDel
            ? <button onClick={()=>setConfirmDel(true)} style={{ padding:'9px 20px',
                background:'rgba(255,68,85,0.1)', color:'#ff4455',
                border:'1px solid rgba(255,68,85,0.2)', borderRadius:7, fontSize:13,
                cursor:'pointer', fontFamily:"'Figtree',sans-serif" }}>Delete Project</button>
            : <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                <span style={{ fontSize:13, color:'#8892a4', fontFamily:"'Figtree',sans-serif" }}>Are you sure?</span>
                <button onClick={()=>sel&&deleteProject(sel.id)} style={{ padding:'9px 18px',
                  background:'#ff4455', color:'#fff', border:'none', borderRadius:7,
                  fontSize:13, fontWeight:700, cursor:'pointer', fontFamily:"'Figtree',sans-serif" }}>Yes, Delete</button>
                <button onClick={()=>setConfirmDel(false)} style={{ padding:'9px 18px',
                  background:'transparent', border:'1px solid rgba(255,255,255,0.12)', borderRadius:7,
                  color:'#8892a4', fontSize:13, cursor:'pointer', fontFamily:"'Figtree',sans-serif" }}>Cancel</button>
              </div>
          }
        </Card>
      </div>
    );
  };

  /* ── AI panel ─────────────────────────────────────────────────────────────── */
  function AiPanel() {
    const [localInput, setLocalInput] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { setTimeout(()=>inputRef.current?.focus(), 80); }, []);

    const send = async () => {
      const msg = localInput.trim();
      if (!msg || loading) return;
      setLocalInput('');
      setMsgs(m=>[...m,{role:'user',content:msg}]);
      setLoading(true);
      try {
        const r = await api.aiChat(msg, sel?.id);
        setMsgs(m=>[...m,{role:'assistant',content:r.message}]);
      } catch {
        setMsgs(m=>[...m,{role:'assistant',content:'Backend offline — run `go run ./cmd/callahan` then try again.'}]);
      }
      setLoading(false);
    };

    return (
    <div style={{ position:'fixed', inset:0, zIndex:50, display:'flex' }}>
      <div onClick={()=>setAiOpen(false)} style={{ flex:1, background:'rgba(0,0,0,0.5)', backdropFilter:'blur(4px)' }}/>
      <div style={{ width:380, background:'#0d1117', borderLeft:'1px solid rgba(255,255,255,0.12)',
        display:'flex', flexDirection:'column', height:'100%' }}>
        <div style={{ padding:'16px 20px', borderBottom:'1px solid rgba(255,255,255,0.07)',
          display:'flex', alignItems:'center', justifyContent:'space-between' }}>
          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
            <Logo size={26}/>
            <div>
              <div style={{ fontFamily:"'Figtree',sans-serif", fontSize:14, fontWeight:700, color:'#fff' }}>Callahan AI</div>
              <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72' }}>ai assistant</div>
            </div>
          </div>
          <button onClick={()=>setAiOpen(false)} style={{ background:'none', border:'none',
            cursor:'pointer', color:'#545f72', padding:4, lineHeight:0 }}><X size={16}/></button>
        </div>

        {msgs.length<=1 && (
          <div style={{ padding:'12px 16px', borderBottom:'1px solid rgba(255,255,255,0.07)',
            display:'flex', flexDirection:'column', gap:6 }}>
            {['Generate a pipeline for my Next.js app','Why did my last build fail?',
              'Review my code for security issues','Explain this error in plain English'].map(s=>(
              <button key={s} onClick={()=>{ setLocalInput(s); inputRef.current?.focus(); }}
                style={{ padding:'8px 12px', background:'#111620', border:'1px solid rgba(255,255,255,0.12)',
                  borderRadius:7, color:'#8892a4', cursor:'pointer', fontSize:12,
                  textAlign:'left', fontFamily:"'Figtree',sans-serif" }}>{s}</button>
            ))}
          </div>
        )}

        <div style={{ flex:1, overflowY:'auto', padding:16 }}>
          {msgs.map((m,i)=>(
            <div key={i} style={{ marginBottom:14, display:'flex', flexDirection:'column',
              alignItems: m.role==='user'?'flex-end':'flex-start' }}>
              <div style={{ maxWidth:'85%', padding:'10px 14px',
                borderRadius: m.role==='user'?'10px 10px 2px 10px':'10px 10px 10px 2px',
                background: m.role==='user'?'#00d4ff':'#111620',
                border: m.role==='assistant'?'1px solid rgba(255,255,255,0.12)':'none',
                color: m.role==='user'?'#000':'#e8eaf0',
                fontSize:13, lineHeight:1.65, fontFamily:"'Figtree',sans-serif",
                fontWeight: m.role==='user'?600:400, whiteSpace:'pre-wrap' }}>
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div style={{ display:'flex', gap:8, alignItems:'center', color:'#545f72', fontSize:12,
              fontFamily:"'Figtree',sans-serif" }}>
              <Loader2 size={13} style={{ animation:'spin 1s linear infinite' }}/> Thinking…
            </div>
          )}
          <div ref={chatEnd}/>
        </div>

        <div style={{ padding:'12px 16px', borderTop:'1px solid rgba(255,255,255,0.07)',
          display:'flex', gap:8 }}>
          <input
            ref={inputRef}
            value={localInput}
            onChange={e=>setLocalInput(e.target.value)}
            onKeyDown={e=>{ if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); }}}
            placeholder="Ask anything…"
            style={{ flex:1, background:'#111620', border:'1px solid rgba(255,255,255,0.12)',
              borderRadius:8, padding:'10px 14px', color:'#e8eaf0',
              fontFamily:"'Figtree',sans-serif", fontSize:13, outline:'none' }}/>
          <button onClick={send} disabled={loading}
            style={{ padding:'10px 14px', background: loading?'#111620':'#00d4ff', color: loading?'#545f72':'#000',
              border:'none', borderRadius:8, cursor: loading?'not-allowed':'pointer', lineHeight:0,
              transition:'all 0.15s' }}>
            <Send size={14}/>
          </button>
        </div>
      </div>
    </div>
    );
  };

  /* ── command palette ──────────────────────────────────────────────────────── */
  function CmdPalette() {
    const cmds = [
      { label:'Connect Repository',  icon:<Plus size={14}/>,      fn:()=>{setAddProj(true);setCmdOpen(false);} },
      { label:'Run Build',           icon:<Play size={14}/>,      fn:()=>{if(sel){triggerBuild();}setCmdOpen(false);} },
      { label:'Open Callahan AI',    icon:<Sparkles size={14}/>,  fn:()=>{setAiOpen(true);setCmdOpen(false);} },
      { label:'View Builds',         icon:<Zap size={14}/>,       fn:()=>{setView('builds');setCmdOpen(false);} },
      { label:'Edit Pipeline',       icon:<FileCode size={14}/>,  fn:()=>{setView('pipeline');setCmdOpen(false);} },
      { label:'Manage Secrets',      icon:<Lock size={14}/>,      fn:()=>{setView('secrets');setCmdOpen(false);} },
      { label:'Settings',            icon:<Settings size={14}/>,  fn:()=>{setView('settings');setCmdOpen(false);} },
      { label:'Configure AI / LLM',  icon:<Sparkles size={14}/>,  fn:()=>{setView('llm-config');setCmdOpen(false);} },
    ].filter(c=>!cmdQ||c.label.toLowerCase().includes(cmdQ.toLowerCase()));
    return (
      <div style={{ position:'fixed', inset:0, zIndex:100, display:'flex', alignItems:'flex-start',
        justifyContent:'center', paddingTop:100, background:'rgba(0,0,0,0.6)', backdropFilter:'blur(8px)' }}
        onClick={()=>setCmdOpen(false)}>
        <div style={{ width:520, background:'#0d1117', border:'1px solid rgba(255,255,255,0.12)',
          borderRadius:12, overflow:'hidden', boxShadow:'0 32px 80px rgba(0,0,0,0.6)' }}
          onClick={e=>e.stopPropagation()}>
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'14px 16px',
            borderBottom:'1px solid rgba(255,255,255,0.07)' }}>
            <Search size={15} style={{ color:'#545f72' }}/>
            <input ref={cmdRef} value={cmdQ} onChange={e=>setCmdQ(e.target.value)}
              placeholder="Search commands…"
              style={{ flex:1, background:'none', border:'none', color:'#e8eaf0',
                fontFamily:"'Figtree',sans-serif", fontSize:14, outline:'none' }}/>
            <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
              padding:'2px 7px', borderRadius:4, border:'1px solid rgba(255,255,255,0.12)' }}>ESC</span>
          </div>
          {cmds.map(c=>(
            <button key={c.label} onClick={c.fn} style={{ display:'flex', alignItems:'center', gap:12,
              width:'100%', padding:'12px 16px', background:'none', border:'none',
              color:'#8892a4', cursor:'pointer', fontSize:14, fontFamily:"'Figtree',sans-serif",
              textAlign:'left', borderBottom:'1px solid rgba(255,255,255,0.07)' }}
              onMouseEnter={e=>{e.currentTarget.style.background='rgba(0,212,255,0.06)'; e.currentTarget.style.color='#fff';}}
              onMouseLeave={e=>{e.currentTarget.style.background='none'; e.currentTarget.style.color='#8892a4';}}>
              <span style={{ color:'#00d4ff', lineHeight:0 }}>{c.icon}</span>{c.label}
            </button>
          ))}
        </div>
      </div>
    );
  };

  /* ── add project modal ────────────────────────────────────────────────────── */
  function AddProject() {
    const [name, setName] = useState('');
    const [repo, setRepo] = useState('');
    const [branch, setBranch] = useState('main');
    const [token, setToken] = useState('');
    const [showToken, setShowToken] = useState(false);
    const [folderId, setFolderId] = useState<string|null>(addProjToFolder);
    const nameRef = useRef<HTMLInputElement>(null);
    useEffect(() => { setTimeout(() => nameRef.current?.focus(), 50); }, []);
    const submit = async () => {
      if (!name.trim()) return;
      const body = { name: name.trim(), repo_url: repo, branch: branch||'main', token };
      let id = Date.now().toString();
      try {
        const res = await fetch('http://localhost:8080/api/v1/projects', {
          method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
        });
        if (res.ok) { const d = await res.json(); id = d.id; }
      } catch {}
      const p: Project = { id, name: name.trim(), repo_url: repo,
        provider:'github', branch: branch||'main', status:'active', created_at: new Date().toISOString() };
      setProjects(prev => [...prev, p]);
      if (folderId) setFolders(fs => fs.map(f => f.id===folderId ? { ...f, projects:[...f.projects,p] } : f));
      setSel(p);
      setAddProj(false);
      setAddProjToFolder(null);
    };
    const folderName = folders.find(f=>f.id===folderId)?.name;
    return (
      <div style={{ position:'fixed', inset:0, zIndex:100, display:'flex', alignItems:'center',
        justifyContent:'center', background:'rgba(0,0,0,0.6)', backdropFilter:'blur(8px)' }}
        onClick={()=>{ setAddProj(false); setAddProjToFolder(null); }}>
        <div style={{ width:480, background:'#0d1117', border:'1px solid rgba(255,255,255,0.12)',
          borderRadius:12, padding:28, boxShadow:'0 32px 80px rgba(0,0,0,0.6)' }}
          onClick={e=>e.stopPropagation()}>

          {/* header */}
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
            <h3 style={{ fontFamily:"'Figtree',sans-serif", fontSize:18, fontWeight:700,
              color:'#fff', margin:0, letterSpacing:'-0.02em' }}>Connect Repository</h3>
            <button onClick={()=>{ setAddProj(false); setAddProjToFolder(null); }}
              style={{ background:'none', border:'none', cursor:'pointer', color:'#545f72', lineHeight:0 }}>
              <X size={16}/>
            </button>
          </div>

          {/* folder context hint */}
          {folderId && (
            <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:20,
              padding:'6px 10px', background:'rgba(0,212,255,0.06)',
              border:'1px solid rgba(0,212,255,0.15)', borderRadius:6 }}>
              <FolderOpen size={12} style={{ color:'#00d4ff' }}/>
              <span style={{ fontFamily:"'Figtree',sans-serif", fontSize:12, color:'#8892a4' }}>
                Adding to <span style={{ color:'#00d4ff', fontWeight:600 }}>{folderName}</span>
              </span>
            </div>
          )}
          {!folderId && <div style={{ marginBottom:20 }}/>}

          {/* project name */}
          <div style={{ marginBottom:14 }}>
            <div style={{ fontSize:12, color:'#545f72', marginBottom:5, fontFamily:"'Figtree',sans-serif" }}>Project Name</div>
            <input ref={nameRef} value={name} onChange={e=>setName(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&submit()} placeholder="my-service"
              style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                borderRadius:7, padding:'10px 14px', color:'#e8eaf0',
                fontFamily:"'Figtree',sans-serif", fontSize:13, outline:'none' }}/>
          </div>

          {/* repo url */}
          <div style={{ marginBottom:14 }}>
            <div style={{ fontSize:12, color:'#545f72', marginBottom:5, fontFamily:"'Figtree',sans-serif" }}>Repository URL</div>
            <input value={repo} onChange={e=>setRepo(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&submit()} placeholder="github.com/org/repo"
              style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                borderRadius:7, padding:'10px 14px', color:'#e8eaf0',
                fontFamily:"'Figtree',sans-serif", fontSize:13, outline:'none' }}/>
          </div>

          {/* branch */}
          <div style={{ marginBottom:14 }}>
            <div style={{ fontSize:12, color:'#545f72', marginBottom:5, fontFamily:"'Figtree',sans-serif" }}>Default Branch</div>
            <input value={branch} onChange={e=>setBranch(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&submit()} placeholder="main"
              style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                borderRadius:7, padding:'10px 14px', color:'#e8eaf0',
                fontFamily:"'Figtree',sans-serif", fontSize:13, outline:'none' }}/>
          </div>

          {/* GitHub PAT */}
          <div style={{ marginBottom:14 }}>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:5 }}>
              <div style={{ fontSize:12, color:'#545f72', fontFamily:"'Figtree',sans-serif" }}>
                GitHub PAT <span style={{ fontStyle:'italic' }}>(private repos)</span>
              </div>
              <button onClick={()=>setShowToken(t=>!t)} style={{ background:'none', border:'none',
                cursor:'pointer', color:'#545f72', fontSize:11, fontFamily:"'Figtree',sans-serif" }}>
                {showToken ? 'hide' : 'show'}
              </button>
            </div>
            <input type={showToken?'text':'password'} value={token} onChange={e=>setToken(e.target.value)}
              placeholder="ghp_xxxx — leave empty for public repos"
              style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                borderRadius:7, padding:'10px 14px', color:'#e8eaf0',
                fontFamily:"'IBM Plex Mono',monospace", fontSize:12, outline:'none' }}/>
            <div style={{ fontSize:11, color:'#545f72', marginTop:4, fontFamily:"'Figtree',sans-serif", lineHeight:1.5 }}>
              Stored as GIT_TOKEN secret. Generate at GitHub → Settings → Developer settings → Personal access tokens → Fine-grained → repo read access.
            </div>
          </div>

          {/* folder picker — only show if folders exist and not already pre-selected */}
          {folders.length > 0 && (
            <div style={{ marginBottom:20 }}>
              <div style={{ fontSize:12, color:'#545f72', marginBottom:8, fontFamily:"'Figtree',sans-serif" }}>Add to Folder</div>
              <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
                <button onClick={()=>setFolderId(null)}
                  style={{ padding:'5px 12px', borderRadius:6, cursor:'pointer', fontSize:12,
                    fontFamily:"'Figtree',sans-serif",
                    background: folderId===null ? 'rgba(255,255,255,0.08)' : 'transparent',
                    border: `1px solid ${folderId===null ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.1)'}`,
                    color: folderId===null ? '#e8eaf0' : '#545f72' }}>
                  No folder
                </button>
                {folders.map(f=>(
                  <button key={f.id} onClick={()=>setFolderId(f.id)}
                    style={{ display:'flex', alignItems:'center', gap:5, padding:'5px 12px',
                      borderRadius:6, cursor:'pointer', fontSize:12,
                      fontFamily:"'Figtree',sans-serif",
                      background: folderId===f.id ? 'rgba(0,212,255,0.08)' : 'transparent',
                      border: `1px solid ${folderId===f.id ? 'rgba(0,212,255,0.3)' : 'rgba(255,255,255,0.1)'}`,
                      color: folderId===f.id ? '#00d4ff' : '#545f72' }}>
                    <Folder size={11}/>{f.name}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div style={{ display:'flex', gap:10 }}>
            <button onClick={()=>{ setAddProj(false); setAddProjToFolder(null); }}
              style={{ flex:1, padding:10, background:'transparent',
                border:'1px solid rgba(255,255,255,0.12)', borderRadius:7,
                color:'#8892a4', cursor:'pointer', fontFamily:"'Figtree',sans-serif", fontSize:13 }}>
              Cancel
            </button>
            <button onClick={submit}
              style={{ flex:1, padding:10, background:'#00d4ff', color:'#000',
                border:'none', borderRadius:7, fontWeight:700, cursor:'pointer',
                fontFamily:"'Figtree',sans-serif", fontSize:13 }}>
              Connect
            </button>
          </div>
        </div>
      </div>
    );
  };

  /* ── add folder modal ────────────────────────────────────────────────────── */
  function AddFolderModal() {
    const [name, setName] = useState('');
    const [assignProj, setAssignProj] = useState<string[]>([]);
    const inputRef = useRef<HTMLInputElement>(null);
    useEffect(() => { setTimeout(() => inputRef.current?.focus(), 50); }, []);
    const unfoldered = projects.filter(p => !folders.some(f => f.projects.find(fp => fp.id === p.id)));
    const submit = () => {
      if (!name.trim()) return;
      const assigned = projects.filter(p => assignProj.includes(p.id));
      setFolders(f => [...f, { id: Date.now().toString(), name: name.trim(), expanded: true, projects: assigned }]);
      setAddFolder(false);
    };
    return (
      <div style={{ position:'fixed', inset:0, zIndex:100, display:'flex', alignItems:'center',
        justifyContent:'center', background:'rgba(0,0,0,0.6)', backdropFilter:'blur(8px)' }}
        onClick={()=>setAddFolder(false)}>
        <div style={{ width:440, background:'#0d1117', border:'1px solid rgba(255,255,255,0.12)',
          borderRadius:12, padding:28, boxShadow:'0 32px 80px rgba(0,0,0,0.6)' }}
          onClick={e=>e.stopPropagation()}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:22 }}>
            <h3 style={{ fontFamily:"'Figtree',sans-serif", fontSize:18, fontWeight:700,
              color:'#fff', margin:0, letterSpacing:'-0.02em' }}>New Folder</h3>
            <button onClick={()=>setAddFolder(false)} style={{ background:'none', border:'none',
              cursor:'pointer', color:'#545f72', lineHeight:0 }}><X size={16}/></button>
          </div>
          <div style={{ marginBottom:20 }}>
            <div style={{ fontSize:12, color:'#545f72', marginBottom:6, fontFamily:"'Figtree',sans-serif" }}>Folder Name</div>
            <input ref={inputRef} value={name} onChange={e=>setName(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&submit()}
              placeholder="e.g. Production, Staging, Team-A"
              style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                borderRadius:7, padding:'10px 14px', color:'#e8eaf0',
                fontFamily:"'Figtree',sans-serif", fontSize:13, outline:'none' }}/>
          </div>
          {unfoldered.length > 0 && (
            <div style={{ marginBottom:20 }}>
              <div style={{ fontSize:12, color:'#545f72', marginBottom:8, fontFamily:"'Figtree',sans-serif" }}>
                Add projects to this folder <span style={{ color:'#545f72', fontStyle:'italic' }}>(optional)</span>
              </div>
              {unfoldered.map(p => {
                const checked = assignProj.includes(p.id);
                return (
                  <div key={p.id} onClick={()=>setAssignProj(a => checked ? a.filter(x=>x!==p.id) : [...a,p.id])}
                    style={{ display:'flex', alignItems:'center', gap:10, padding:'8px 10px',
                      borderRadius:7, cursor:'pointer', marginBottom:4,
                      background: checked ? 'rgba(0,212,255,0.06)' : 'rgba(255,255,255,0.02)',
                      border: `1px solid ${checked ? 'rgba(0,212,255,0.2)' : 'rgba(255,255,255,0.07)'}` }}>
                    <div style={{ width:14, height:14, borderRadius:3, flexShrink:0,
                      background: checked ? '#00d4ff' : 'transparent',
                      border: `1.5px solid ${checked ? '#00d4ff' : 'rgba(255,255,255,0.2)'}`,
                      display:'flex', alignItems:'center', justifyContent:'center' }}>
                      {checked && <svg width="8" height="8" viewBox="0 0 8 8"><path d="M1 4l2 2 4-4" stroke="#000" strokeWidth="1.5" strokeLinecap="round" fill="none"/></svg>}
                    </div>
                    <span style={{ fontSize:13, color: checked ? '#e8eaf0' : '#8892a4',
                      fontFamily:"'Figtree',sans-serif" }}>{p.name}</span>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{ display:'flex', gap:10 }}>
            <button onClick={()=>setAddFolder(false)} style={{ flex:1, padding:10,
              background:'transparent', border:'1px solid rgba(255,255,255,0.12)',
              borderRadius:7, color:'#8892a4', cursor:'pointer',
              fontFamily:"'Figtree',sans-serif", fontSize:13 }}>Cancel</button>
            <button onClick={submit} style={{ flex:1, padding:10, background:'#00d4ff',
              color:'#000', border:'none', borderRadius:7, fontWeight:700, cursor:'pointer',
              fontFamily:"'Figtree',sans-serif", fontSize:13 }}>Create Folder</button>
          </div>
        </div>
      </div>
    );
  };

  /* ── LLM Config ──────────────────────────────────────────────────────────── */
  function LLMConfigView() {
    const [provider, setProvider] = useState('anthropic');
    const [model, setModel]       = useState('claude-sonnet-4-5');
    const [apiKey, setApiKey]     = useState('');
    const [ollamaURL, setOllamaURL] = useState('http://localhost:11434');
    const [showKey, setShowKey]   = useState(false);
    const [status, setStatus]     = useState<null|{ok:boolean;msg:string}>(null);
    const [testing, setTesting]   = useState(false);
    const [saving, setSaving]     = useState(false);

    useEffect(() => {
      fetch('http://localhost:8080/api/v1/settings/llm')
        .then(r=>r.json()).then(d=>{
          if(d.provider) setProvider(d.provider);
          if(d.model) setModel(d.model);
          if(d.ollama_url) setOllamaURL(d.ollama_url);
        }).catch(()=>{});
    }, []);

    const PROVIDERS = [
      { id:'anthropic', name:'Anthropic', models:['claude-opus-4-5','claude-sonnet-4-5','claude-haiku-4-5-20251001'] },
      { id:'openai',    name:'OpenAI',    models:['gpt-4o','gpt-4o-mini','o1-mini'] },
      { id:'groq',      name:'Groq',      models:['llama-3.3-70b-versatile','llama3-8b-8192','gemma2-9b-it'] },
      { id:'ollama',    name:'Ollama (Local)', models:['llama3.2','mistral','codellama','phi3'] },
    ];

    const save = async () => {
      setSaving(true);
      setStatus(null);
      try {
        const res = await fetch('http://localhost:8080/api/v1/settings/llm', {
          method:'PUT', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ provider, model, api_key: apiKey, ollama_url: ollamaURL })
        });
        const d = await res.json();
        if (res.ok) {
          setStatus({ ok: true, msg: `✔ Saved — now using ${d.provider} / ${d.model}` });
          setApiKey(''); // clear key field after save for security
        } else {
          setStatus({ ok: false, msg: d.error || 'Save failed' });
        }
      } catch(e:any) { setStatus({ ok:false, msg: 'Cannot reach backend — is it running?' }); }
      setSaving(false);
    };

    const testConnection = async () => {
      setTesting(true); setStatus(null);
      try {
        const res = await fetch('http://localhost:8080/api/v1/settings/llm/test', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ provider, model, api_key: apiKey })
        });
        const d = await res.json();
        setStatus({ ok: d.ok, msg: d.ok ? `✔ Connected — "${d.response}"` : `✖ ${d.error}` });
      } catch(e:any) { setStatus({ ok:false, msg: '✖ Cannot reach backend — is it running?' }); }
      setTesting(false);
    };

    const prov = PROVIDERS.find(p=>p.id===provider);

    return (
      <div style={{ padding:28, maxWidth:640 }}>
        <h2 style={{ fontFamily:"'Figtree',sans-serif", fontSize:22, fontWeight:800,
          color:'#fff', letterSpacing:'-0.03em', marginBottom:6 }}>AI / LLM Configuration</h2>
        <p style={{ color:'#545f72', fontSize:13, fontFamily:"'Figtree',sans-serif",
          lineHeight:1.6, marginBottom:24 }}>
          Choose your AI provider and enter an API key. Keys are stored in the local database and never leave your machine.
        </p>

        {/* Provider selector */}
        <Card style={{ marginBottom:14 }}>
          <div style={{ fontSize:10, color:'#545f72', letterSpacing:'0.1em', textTransform:'uppercase',
            fontFamily:"'IBM Plex Mono',monospace", marginBottom:16 }}>Provider</div>
          <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
            {PROVIDERS.map(p=>(
              <button key={p.id} onClick={()=>{ setProvider(p.id); setModel(p.models[0]); setStatus(null); }}
                style={{ padding:'12px 14px', borderRadius:8, cursor:'pointer', textAlign:'left',
                  fontFamily:"'Figtree',sans-serif",
                  background: provider===p.id ? 'rgba(160,120,255,0.08)' : 'rgba(255,255,255,0.02)',
                  border: `1px solid ${provider===p.id ? 'rgba(160,120,255,0.4)' : 'rgba(255,255,255,0.08)'}`,
                  transition:'all 0.15s' }}>
                <div style={{ fontSize:13, fontWeight:600, color: provider===p.id ? '#a078ff' : '#e8eaf0', marginBottom:2 }}>{p.name}</div>
                <div style={{ fontSize:11, color:'#545f72' }}>{p.models.length} model{p.models.length!==1?'s':''}</div>
              </button>
            ))}
          </div>
        </Card>

        {/* Model selector */}
        <Card style={{ marginBottom:14 }}>
          <div style={{ fontSize:10, color:'#545f72', letterSpacing:'0.1em', textTransform:'uppercase',
            fontFamily:"'IBM Plex Mono',monospace", marginBottom:14 }}>Model</div>
          <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
            {prov?.models.map(m=>(
              <button key={m} onClick={()=>setModel(m)}
                style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
                  padding:'10px 14px', borderRadius:7, cursor:'pointer',
                  fontFamily:"'IBM Plex Mono',monospace",
                  background: model===m ? 'rgba(0,212,255,0.06)' : 'transparent',
                  border: `1px solid ${model===m ? 'rgba(0,212,255,0.25)' : 'rgba(255,255,255,0.07)'}` }}>
                <span style={{ fontSize:12, color: model===m ? '#00d4ff' : '#8892a4' }}>{m}</span>
                {model===m && <span style={{ fontSize:10, color:'#00d4ff' }}>selected</span>}
              </button>
            ))}
          </div>
        </Card>

        {/* API Key / URL */}
        <Card style={{ marginBottom:14 }}>
          {provider === 'ollama' ? (<>
            <div style={{ fontSize:10, color:'#545f72', letterSpacing:'0.1em', textTransform:'uppercase',
              fontFamily:"'IBM Plex Mono',monospace", marginBottom:14 }}>Ollama Server URL</div>
            <input value={ollamaURL} onChange={e=>setOllamaURL(e.target.value)}
              placeholder="http://localhost:11434"
              style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                borderRadius:7, padding:'10px 14px', color:'#e8eaf0',
                fontFamily:"'IBM Plex Mono',monospace", fontSize:12, outline:'none' }}/>
            <div style={{ fontSize:11, color:'#545f72', marginTop:6, fontFamily:"'Figtree',sans-serif" }}>
              Make sure Ollama is running locally: <code style={{ color:'#00d4ff' }}>ollama serve</code>
            </div>
          </>) : (<>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
              <div style={{ fontSize:10, color:'#545f72', letterSpacing:'0.1em', textTransform:'uppercase',
                fontFamily:"'IBM Plex Mono',monospace" }}>API Key</div>
              <button onClick={()=>setShowKey(k=>!k)} style={{ background:'none', border:'none',
                cursor:'pointer', color:'#545f72', fontSize:11, fontFamily:"'Figtree',sans-serif" }}>
                {showKey ? 'hide' : 'show'}
              </button>
            </div>
            <input type={showKey?'text':'password'} value={apiKey} onChange={e=>setApiKey(e.target.value)}
              placeholder={`Enter your ${prov?.name} API key…`}
              style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                borderRadius:7, padding:'10px 14px', color:'#e8eaf0',
                fontFamily:"'IBM Plex Mono',monospace", fontSize:12, outline:'none' }}/>
            <div style={{ fontSize:11, color:'#545f72', marginTop:6, fontFamily:"'Figtree',sans-serif" }}>
              {provider==='anthropic' && <>Get your key at <span style={{color:'#00d4ff'}}>console.anthropic.com</span></>}
              {provider==='openai' && <>Get your key at <span style={{color:'#00d4ff'}}>platform.openai.com/api-keys</span></>}
              {provider==='groq' && <>Get your key at <span style={{color:'#00d4ff'}}>console.groq.com</span></>}
            </div>
          </>)}
        </Card>

        {/* Status message */}
        {status && (
          <div style={{ marginBottom:14, padding:'12px 16px', borderRadius:8,
            background: status.ok ? 'rgba(0,229,160,0.08)' : 'rgba(255,68,85,0.08)',
            border: `1px solid ${status.ok ? 'rgba(0,229,160,0.2)' : 'rgba(255,68,85,0.2)'}`,
            fontFamily:"'Figtree',sans-serif", fontSize:13,
            color: status.ok ? '#00e5a0' : '#ff4455' }}>
            {status.msg}
          </div>
        )}

        {/* Actions */}
        <div style={{ display:'flex', gap:10 }}>
          <button onClick={testConnection} disabled={testing}
            style={{ flex:1, padding:'10px 20px', background:'transparent',
              border:'1px solid rgba(255,255,255,0.15)', borderRadius:7,
              color: testing ? '#545f72' : '#e8eaf0', cursor: testing ? 'wait' : 'pointer',
              fontFamily:"'Figtree',sans-serif", fontSize:13, fontWeight:500 }}>
            {testing ? 'Testing…' : 'Test Connection'}
          </button>
          <button onClick={save} disabled={saving}
            style={{ flex:2, padding:'10px 20px', background:'#a078ff',
              border:'none', borderRadius:7, color:'#fff', cursor: saving ? 'wait' : 'pointer',
              fontFamily:"'Figtree',sans-serif", fontSize:13, fontWeight:700,
              opacity: saving ? 0.7 : 1 }}>
            {saving ? 'Saving…' : 'Save Configuration'}
          </button>
        </div>
      </div>
    );
  };

  /* ── render ───────────────────────────────────────────────────────────────── */
  const main = () => {
    if (view === 'llm-config') return <LLMConfigView/>;
    if (view === 'secrets')    return <Secrets/>;
    if (view === 'settings')   return <SettingsView/>;
    if (!sel) return <Welcome/>;
    switch(view) {
      case 'dashboard': return <Dashboard/>;
      case 'builds':    return <Builds/>;
      case 'pipeline':  return <Pipeline/>;
      default:          return <Dashboard/>;
    }
  };

  return (
    <>
      <style>{`
        @keyframes spin  { to { transform: rotate(360deg); } }
        @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0.3} }
        textarea:focus, input:focus { border-color: rgba(0,212,255,0.4) !important; }
        button:focus { outline: none; }
        ::-webkit-scrollbar { width:4px; height:4px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:rgba(255,255,255,0.1); border-radius:4px; }
      `}</style>
      <div style={{ display:'flex', minHeight:'100vh', background:'#080a0f', color:'#e8eaf0' }}>
        <Sidebar/>
        <div style={{ flex:1, display:'flex', flexDirection:'column', minWidth:0 }}>
          <TopBar/>
          <main style={{ flex:1, overflowY:'auto' }}>
            {main()}
          </main>
        </div>
        {aiOpen     && <AiPanel/>}
        {cmdOpen    && <CmdPalette/>}
        {addProj    && <AddProject/>}
        {addFolder  && <AddFolderModal/>}
        {runModal   && <RunBuildModal/>}
      </div>
    </>
  );
}
