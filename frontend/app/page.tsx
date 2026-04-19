'use client';
import { useEffect, useState, useRef } from 'react';
import {
  Play, CheckCircle, XCircle, Clock, Plus, Settings, Terminal,
  Shield, Search, Sparkles, Command, Lock, FileCode, Loader2,
  GitCommit, X, Send, FolderOpen, Folder, ChevronDown,
  Trash2, GitBranch, Zap, Activity, ChevronRight,
  Globe, Bell, Tag, Rocket, Package, AlertTriangle, CheckSquare,
  RotateCcw, ExternalLink, Copy, ChevronUp
} from 'lucide-react';
import { pageApi as api, Project } from '@/lib/api';

// Local Build type — compatible with both the API response and demo data
type Build = {
  id: string; project_id: string; status: string; branch: string;
  number?: number; commit?: string; commitMsg?: string;
  commit_sha?: string; commit_message?: string; duration?: number;
  duration_ms?: number;
  created_at: string; started_at?: string; finished_at?: string;
};
import { formatDuration, timeAgo, statusStyles } from '@/lib/utils';

type View = 'dashboard' | 'builds' | 'pipeline' | 'secrets' | 'settings' | 'llm-config' | 'versions';
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

/* ─── logo ────────────────────────────────────────────────────────────────── */
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
  const bottomRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket|null>(null);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (stoppedRef.current) return;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://localhost:8080/ws?build_id=${build.id}`);
    wsRef.current = ws;
    let cleanedUp = false;

    ws.onopen = () => {
      if (cleanedUp || stoppedRef.current) return;
      // Reset any stale lines from a prior aborted attempt
      setLines([]);
    };
    ws.onmessage = (e) => {
      if (cleanedUp || stoppedRef.current) return;
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'log' && msg.payload?.line) {
          const raw: string = msg.payload.line;
          const color = raw.startsWith('✖')||raw.includes('error')||raw.includes('Error') ? '#ff4455'
            : raw.startsWith('✔')||raw.includes('success') ? '#00e5a0'
            : raw.startsWith('▶') ? '#00d4ff'
            : raw.startsWith('✦') ? '#a078ff'
            : '#8892a4';
          setLines(l=>[...l,{msg:raw,color}]);
        }
        if (msg.type === 'build_status' && (msg.payload?.status==='success'||msg.payload?.status==='failed'||msg.payload?.status==='cancelled')) {
          stoppedRef.current = true;
          setStopped(true);
          onStop();
        }
      } catch {}
    };
    ws.onerror = () => { /* suppress — retry handles it */ };
    ws.onclose = () => { /* suppress connection noise */ };
    return () => { cleanedUp = true; ws.close(); };
  }, [build.id]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:'smooth' }); }, [lines]);

  const stop = async () => {
    if (stopping) return;
    setStopping(true);
    try {
      await fetch(`http://localhost:8080/api/v1/builds/${build.id}/cancel`, { method:'POST' });
    } catch {}
    stoppedRef.current = true;
    wsRef.current?.close();
    onStop();
  };

  return (
    <div>
      <div style={{ background:'#080a0f', borderRadius:8, padding:16, maxHeight:380, overflowY:'auto',
        fontFamily:"'IBM Plex Mono',monospace", fontSize:12, lineHeight:2 }}>
        {lines.length===0 && <span style={{ color:'#545f72' }}>Connecting…</span>}
        {lines.map((l,i)=>(
          <div key={i} style={{ color:l.color }}>{l.msg}</div>
        ))}
        <div ref={bottomRef}/>
      </div>
      {!stopped && (
        <button onClick={stop} disabled={stopping} style={{ marginTop:10, padding:'6px 14px',
          background:'rgba(255,68,85,0.1)', border:'1px solid rgba(255,68,85,0.25)',
          borderRadius:6, color:'#ff4455', cursor:stopping?'wait':'pointer', fontSize:12,
          fontFamily:"'Figtree',sans-serif", display:'flex', alignItems:'center', gap:6 }}>
          {stopping ? <Loader2 size={12} style={{animation:'spin 1s linear infinite'}}/> : <X size={12}/>}
          {stopping ? 'Stopping…' : 'Stop Build'}
        </button>
      )}
    </div>
  );
}

/* ─── build step helpers ──────────────────────────────────────────────────── */
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
function StepRow({ step, onExplain }: { step: any; onExplain?: (name: string, log: string) => void }) {
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
        {step.status === 'failed' && onExplain && (
          <button onClick={e=>{ e.stopPropagation(); onExplain(step.name, step.log||''); }}
            style={{ display:'flex', alignItems:'center', gap:4, padding:'3px 10px',
              background:'rgba(160,120,255,0.1)', border:'1px solid rgba(160,120,255,0.3)',
              borderRadius:5, color:'#a078ff', cursor:'pointer', fontSize:11,
              fontFamily:"'Figtree',sans-serif", fontWeight:600, flexShrink:0 }}>
            <Sparkles size={11}/> Explain
          </button>
        )}
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

/* ─── section label ───────────────────────────────────────────────────────── */
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
      letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:14 }}>{children}</div>
  );
}

/* ─── field ───────────────────────────────────────────────────────────────── */
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:12, color:'#8892a4', marginBottom:5, fontFamily:"'Figtree',sans-serif" }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize:11, color:'#545f72', marginTop:4, fontFamily:"'Figtree',sans-serif" }}>{hint}</div>}
    </div>
  );
}

function Input({ value, onChange, placeholder, type='text', mono=false, style={} }: {
  value: string; onChange: (v:string)=>void; placeholder?: string; type?: string; mono?: boolean; style?: React.CSSProperties;
}) {
  return (
    <input type={type} value={value} onChange={e=>onChange(e.target.value)} placeholder={placeholder}
      style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
        borderRadius:6, padding:'9px 12px', color:'#e8eaf0', outline:'none', boxSizing:'border-box',
        fontFamily: mono ? "'IBM Plex Mono',monospace" : "'Figtree',sans-serif", fontSize:13, ...style }}/>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v:boolean)=>void; label: string }) {
  return (
    <label style={{ display:'flex', alignItems:'center', gap:8, cursor:'pointer', userSelect:'none' }}>
      <div onClick={()=>onChange(!checked)} style={{ width:34, height:18, borderRadius:9, position:'relative', flexShrink:0,
        background: checked ? '#00d4ff' : 'rgba(255,255,255,0.1)', transition:'background 0.2s',
        border: `1px solid ${checked ? '#00d4ff' : 'rgba(255,255,255,0.2)'}` }}>
        <div style={{ position:'absolute', top:2, left: checked ? 17 : 2, width:12, height:12,
          borderRadius:'50%', background:'#fff', transition:'left 0.2s', boxShadow:'0 1px 3px rgba(0,0,0,0.4)' }}/>
      </div>
      <span style={{ fontSize:13, color:'#8892a4', fontFamily:"'Figtree',sans-serif" }}>{label}</span>
    </label>
  );
}

/* ════════════════════════════════════════════════════════════════════════════ */
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
  const [cmdQ, setCmdQ]           = useState('');
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
  useEffect(() => { api.getProjects().then(setProjects).catch(()=>{}); api.getBuilds().then(setBuilds).catch(()=>{}); }, []);

  const [loadingDemo, setLoadingDemo] = useState(false);
  const loadDemo = async () => {
    setLoadingDemo(true);
    try {
      const r = await fetch('http://localhost:8080/api/v1/demo/seed', { method: 'POST' });
      const d = await r.json();
      const projs = await api.getProjects();
      setProjects(projs);
      const demo = projs.find((p: Project) => p.id === d.project.id);
      if (demo) { setSel(demo); setView('builds'); }
      const allBuilds = await api.getBuilds();
      setBuilds(allBuilds);
    } catch {}
    setLoadingDemo(false);
  };

  const projBuilds = sel ? builds.filter(b=>b.project_id===sel.id) : builds;

  const triggerBuild = async () => {
    if (!sel) return;
    const mock: Build = { id:`b-${Date.now()}`, project_id:sel.id, status:'running', branch:sel.branch,
      commit_sha: Math.random().toString(36).slice(2,9), commit_message:'Manual trigger',
      duration:0, created_at:new Date().toISOString(), started_at:'', finished_at:'' };
    setBuilds(p=>[mock,...p]);
    try { const b = await api.triggerBuild(sel.id); setBuilds(p=>[b,...p.filter(x=>x.id!==mock.id)]); } catch {}
  };

  const deleteProject = async (id: string) => {
    try { await api.deleteProject(id); } catch {}
    setProjects(p => p.filter(x => x.id !== id));
    setBuilds(b => b.filter(x => x.project_id !== id));
    setFolders(f => f.map(fo => ({ ...fo, projects: fo.projects.filter(p => p.id !== id) })));
    if (sel?.id === id) { setSel(null); setView('dashboard'); }
  };

  /* ── sidebar ─────────────────────────────────────────────────────────────── */
  const Sidebar = () => (
    <aside style={{ width:232, flexShrink:0, height:'100vh', position:'sticky', top:0,
      background:'#0d1117', borderRight:'1px solid rgba(255,255,255,0.12)',
      display:'flex', flexDirection:'column', zIndex:10, overflow:'hidden' }}>

      <div style={{ padding:'15px 16px 13px', borderBottom:'1px solid rgba(255,255,255,0.07)',
        display:'flex', alignItems:'center', gap:10 }}>
        <Logo size={28}/>
        <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:15, fontWeight:600,
          color:'#e8eaf0', letterSpacing:'-0.02em' }}>
          callahan<span style={{ color:'#00d4ff' }}>/ci</span>
        </span>
      </div>

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
          <div style={{ display:'flex', flexDirection:'column', gap:6, marginTop:8 }}>
            <button onClick={()=>setAddProj(true)} style={{ width:'100%', padding:10,
              border:'1px dashed rgba(255,255,255,0.12)', borderRadius:8, background:'none',
              color:'#545f72', fontSize:12, cursor:'pointer', fontFamily:"'Figtree',sans-serif" }}>
              + Connect repository
            </button>
            <button onClick={loadDemo} disabled={loadingDemo} style={{ width:'100%', padding:10,
              border:'1px solid rgba(160,120,255,0.3)', borderRadius:8,
              background:'rgba(160,120,255,0.07)', color: loadingDemo ? '#545f72' : '#a078ff',
              fontSize:12, cursor: loadingDemo ? 'wait' : 'pointer', fontFamily:"'Figtree',sans-serif" }}>
              {loadingDemo ? '⏳ Loading…' : '✦ Try Demo'}
            </button>
          </div>
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

      {/* bottom nav */}
      <div style={{ padding:'10px 10px 10px', borderTop:'1px solid rgba(255,255,255,0.07)', display:'flex', flexDirection:'column', gap:2 }}>

        {/* Versions — read-only timeline, still useful */}
        <button onClick={()=>setView('versions')}
          style={{ display:'flex', alignItems:'center', gap:7, width:'100%', padding:'7px 10px',
            background: view==='versions' ? 'rgba(160,120,255,0.06)' : 'transparent',
            border: view==='versions' ? '1px solid rgba(160,120,255,0.2)' : '1px solid transparent',
            borderRadius:6, cursor:'pointer', textAlign:'left' }}>
          <Tag size={13} color={view==='versions' ? '#a078ff' : '#545f72'}/>
          <span style={{ fontFamily:"'Figtree',sans-serif", fontSize:12,
            color: view==='versions' ? '#a078ff' : '#545f72', fontWeight:500 }}>Version History</span>
        </button>

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
          <button onClick={triggerBuild} style={{ display:'flex', alignItems:'center', gap:6,
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
      <div style={{ display:'flex', gap:12, marginBottom:52, flexWrap:'wrap', justifyContent:'center' }}>
        <button onClick={()=>setAddProj(true)} style={{ display:'flex', alignItems:'center', gap:8,
          padding:'13px 24px', background:'#00d4ff', color:'#000', border:'none',
          borderRadius:8, fontSize:14, fontWeight:700, cursor:'pointer',
          fontFamily:"'Figtree',sans-serif" }}>
          <Plus size={16}/> Connect Repository
        </button>
        <button onClick={loadDemo} disabled={loadingDemo} style={{ display:'flex', alignItems:'center', gap:8,
          padding:'13px 24px', background:'rgba(160,120,255,0.12)', color: loadingDemo ? '#545f72' : '#a078ff',
          border:'1px solid rgba(160,120,255,0.35)', borderRadius:8,
          fontSize:14, fontWeight:700, cursor: loadingDemo ? 'wait' : 'pointer',
          fontFamily:"'Figtree',sans-serif" }}>
          {loadingDemo ? <><Loader2 size={16} style={{animation:'spin 1s linear infinite'}}/> Loading…</> : <><Sparkles size={16}/> Try Demo</>}
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
        <button onClick={triggerBuild} style={{ display:'flex', alignItems:'center', gap:8,
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
          { label:'Avg Duration',  value: formatDuration(projBuilds.filter(b=>b.duration??b.duration_ms).reduce((a,b)=>a+(b.duration??b.duration_ms??0),0)/Math.max(projBuilds.filter(b=>b.duration??b.duration_ms).length,1)), mono:true },
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

      {/* quick-access */}
      <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:10, marginBottom:20 }}>
        {[
          { label:'Configure Pipeline', desc:'Environments, notifications, deploy chain', color:'#00d4ff', icon:<GitBranch size={15}/>, v:'pipeline' as View },
          { label:'Version History',    desc:'SemVer timeline + git tags',                 color:'#a078ff', icon:<Tag size={15}/>,      v:'versions' as View },
          { label:'Run Build',          desc:'Trigger a new build now',                    color:'#00e5a0', icon:<Play size={15}/>,     v:null },
        ].map(item=>(
          <button key={item.label} onClick={()=>item.v ? setView(item.v) : triggerBuild()}
            style={{ background:'rgba(255,255,255,0.02)', border:`1px solid ${item.color}20`,
              borderRadius:10, padding:'14px 16px', cursor:'pointer', textAlign:'left',
              display:'flex', alignItems:'center', gap:12, transition:'border-color 0.15s' }}
            onMouseEnter={e=>(e.currentTarget.style.borderColor=item.color+'50')}
            onMouseLeave={e=>(e.currentTarget.style.borderColor=item.color+'20')}>
            <div style={{ width:34, height:34, borderRadius:8, background:`${item.color}15`,
              display:'flex', alignItems:'center', justifyContent:'center',
              border:`1px solid ${item.color}30`, color:item.color, flexShrink:0 }}>
              {item.icon}
            </div>
            <div>
              <div style={{ fontFamily:"'Figtree',sans-serif", fontSize:13, fontWeight:600,
                color:'#fff', marginBottom:2 }}>{item.label}</div>
              <div style={{ fontSize:11, color:'#545f72', fontFamily:"'Figtree',sans-serif" }}>{item.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* recent builds */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
        <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
          letterSpacing:'0.1em', textTransform:'uppercase' }}>Recent Builds</span>
        <button onClick={()=>setView('builds')} style={{ background:'none', border:'none',
          cursor:'pointer', color:'#545f72', fontSize:12, fontFamily:"'Figtree',sans-serif' " }}>
          View all →
        </button>
      </div>
      <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
        {projBuilds.slice(0,5).map(b=>(
          <Card key={b.id} onClick={()=>{ setView('builds'); setSelBuild(b); }} style={{ padding:'12px 18px' }}>
            <div style={{ display:'flex', alignItems:'center', gap:12 }}>
              <Badge status={b.status}/>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontSize:13, color:'#fff', fontWeight:500,
                  overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap',
                  fontFamily:"'Figtree',sans-serif" }}>{b.commit_message}</div>
                <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#545f72',
                  display:'flex', gap:10, marginTop:2 }}>
                  <span>{b.commit_sha?.slice(0,7)}</span><span>{b.branch}</span><span>{timeAgo(b.created_at)}</span>
                </div>
              </div>
              <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:'#545f72', flexShrink:0 }}>
                {b.duration?formatDuration(b.duration):'—'}
              </div>
              <ChevronRight size={13} style={{ color:'#545f72' }}/>
            </div>
          </Card>
        ))}
        {projBuilds.length===0 && (
          <div style={{ textAlign:'center', padding:'32px 0', color:'#545f72',
            fontSize:13, fontFamily:"'Figtree',sans-serif" }}>
            No builds yet — click Run Build to trigger the first one
          </div>
        )}
      </div>
    </div>
  );

  /* ── builds ───────────────────────────────────────────────────────────────── */
  function Builds() {
    const [buildSubTab, setBuildSubTab] = useState<'builds'|'environments'>('builds');

    // ── Builds sub-tab state
    const [jobs, setJobs] = useState<any[]>([]);
    const [steps, setSteps] = useState({} as Record<string, any[]>);
    const [expanded, setExpanded] = useState({} as Record<string, boolean>);

    // ── Environments sub-tab state
    const [envs, setEnvs] = useState<any[]>([]);
    const [deployments, setDeployments] = useState<any[]>([]);
    const [selDep, setSelDep] = useState<any|null>(null);
    const [deploying, setDeploying] = useState<string|null>(null);
    const [deployTarget, setDeployTarget] = useState<{envId:string;envName:string}|null>(null);
    const [pickedVersion, setPickedVersion] = useState('');
    const [showAddEnv, setShowAddEnv] = useState(false);
    const [newEnv, setNewEnv] = useState({ name:'', description:'', color:'#00e5a0', auto_deploy:false, requires_approval:false });

    const projBuilds = sel ? builds.filter(b => b.project_id === sel.id) : [];
    const ENV_COLORS: Record<string,string> = { dev:'#00d4ff', test:'#00e5a0', staging:'#f5c542', prod:'#ff4455', production:'#ff4455' };

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

    useEffect(() => {
      if (!sel || buildSubTab !== 'environments') return;
      fetch(`http://localhost:8080/api/v1/projects/${sel.id}/environments`).then(r=>r.json()).then(d=>setEnvs(Array.isArray(d)?d:[])).catch(()=>{});
      fetch(`http://localhost:8080/api/v1/projects/${sel.id}/deployments`).then(r=>r.json()).then(d=>setDeployments(Array.isArray(d)?d:[])).catch(()=>{});
    }, [sel?.id, buildSubTab]);

    const reloadDeployments = () => {
      if (!sel) return;
      fetch(`http://localhost:8080/api/v1/projects/${sel.id}/deployments`).then(r=>r.json()).then(d=>{
        if (!Array.isArray(d)) return;
        setDeployments(d);
        // Also refresh selDep so the log viewer badge updates
        setSelDep((prev: any) => prev ? (d.find((x: any) => x.id === prev.id) ?? prev) : null);
      }).catch(()=>{});
    };

    const openDeployModal = (envId: string, envName: string) => {
      const latestSuccess = projBuilds.find(b=>b.status==='success');
      setPickedVersion(latestSuccess?.id ?? '');
      setDeployTarget({ envId, envName });
    };

    const confirmDeploy = async () => {
      if (!sel || !deployTarget || !pickedVersion) return;
      const buildNum = projBuilds.find(b=>b.id===pickedVersion)?.number ?? '';
      setDeploying(deployTarget.envId);
      setDeployTarget(null);
      try {
        const r = await fetch(`http://localhost:8080/api/v1/projects/${sel.id}/environments/${deployTarget.envId}/deploy`, {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ build_id: pickedVersion, strategy:'direct', notes:`Deploy build #${buildNum}` })
        });
        if (r.ok) {
          const d = await r.json();
          setDeployments(ds=>[d,...ds]);
          setSelDep(d);
        }
      } catch {}
      setDeploying(null);
    };

    const dur = (b: Build) => b.duration ?? b.duration_ms ?? 0;

    // Deploy-specific log viewer — uses dep.id as WS channel
    function DeployLog({ dep }: { dep: any }) {
      const [lines, setLines] = useState<{msg:string;color:string}[]>([]);
      const bottomRef = useRef<HTMLDivElement>(null);
      const envForDep = envs.find((e:any) => e.id === dep.environment_id);
      const statusColor = dep.status==='success'?'#00e5a0':dep.status==='failed'?'#ff4455':dep.status==='running'?'#00d4ff':'#f5c542';
      const envColor = ENV_COLORS[(envForDep?.name??'').toLowerCase()] ?? '#00e5a0';

      useEffect(() => {
        setLines([]);
        if (dep.status !== 'running') {
          fetch(`http://localhost:8080/api/v1/deployments/${dep.id}/log`)
            .then(r=>r.json()).then(d=>{
              if (d.log) setLines(d.log.split('\n').filter(Boolean).map((msg:string)=>({
                msg,
                color: (msg.includes('✖')||msg.toLowerCase().includes('failed')) ? '#ff4455'
                  : (msg.includes('✔')||msg.toLowerCase().includes('success')) ? '#00e5a0'
                  : (msg.startsWith('╔')||msg.startsWith('╚')||msg.startsWith('✦')) ? '#a078ff'
                  : msg.startsWith('▶') ? '#00d4ff' : '#8892a4'
              })));
            }).catch(()=>{});
          return;
        }
        const proto = window.location.protocol==='https:'?'wss':'ws';
        const ws = new WebSocket(`${proto}://localhost:8080/ws?build_id=${dep.id}`);
        let cleanedUp = false;
        ws.onopen = () => { if (!cleanedUp) setLines([]); };
        ws.onmessage = (e) => {
          if (cleanedUp) return;
          try {
            const msg = JSON.parse(e.data);
            if (msg.type==='log' && msg.payload?.line) {
              const raw: string = msg.payload.line;
              setLines(l=>[...l,{msg:raw,
                color: (raw.startsWith('✖')||raw.toLowerCase().includes('failed')) ? '#ff4455'
                  : (raw.startsWith('✔')||raw.toLowerCase().includes('success')) ? '#00e5a0'
                  : (raw.startsWith('╔')||raw.startsWith('╚')||raw.startsWith('✦')) ? '#a078ff'
                  : raw.startsWith('▶') ? '#00d4ff' : '#8892a4'
              }]);
            }
            if (msg.type==='deployment_status') { setTimeout(reloadDeployments, 600); }
          } catch {}
        };
        ws.onerror = ()=>{}; ws.onclose = ()=>{};
        return () => { cleanedUp=true; ws.close(); };
      }, [dep.id, dep.status]);

      useEffect(() => { bottomRef.current?.scrollIntoView({behavior:'smooth'}); }, [lines]);

      return (
        <div style={{ flex:1 }}>
          <div style={{ marginBottom:14, display:'flex', alignItems:'center', gap:10 }}>
            <span style={{ width:8, height:8, borderRadius:'50%', background:statusColor, flexShrink:0,
              boxShadow:dep.status==='running'?`0 0 8px ${statusColor}`:'none' }}/>
            <span style={{ fontFamily:"'Figtree',sans-serif", fontSize:15, fontWeight:700, color:'#fff' }}>
              Deploy → <span style={{color:envColor}}>{envForDep?.name ?? 'env'}</span>
            </span>
            <Badge status={dep.status}/>
            <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#545f72', marginLeft:'auto' }}>
              {timeAgo(dep.created_at)}
            </span>
          </div>
          <div style={{ background:'#080a0f', borderRadius:8, padding:16, maxHeight:440, overflowY:'auto',
            fontFamily:"'IBM Plex Mono',monospace", fontSize:12, lineHeight:2,
            border:'1px solid rgba(255,255,255,0.06)' }}>
            {lines.length===0 && dep.status==='running' && <span style={{color:'#545f72'}}>Connecting…</span>}
            {lines.length===0 && dep.status!=='running' && <span style={{color:'#545f72'}}>No log stored for this deployment.</span>}
            {lines.map((l,i)=><div key={i} style={{color:l.color}}>{l.msg}</div>)}
            <div ref={bottomRef}/>
          </div>
        </div>
      );
    }

    return (
    <div style={{ padding:28 }}>
      {/* Header with sub-tab switcher */}
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:20 }}>
        <div style={{ display:'flex', alignItems:'center', gap:14 }}>
          <h2 style={{ fontFamily:"'Figtree',sans-serif", fontSize:22, fontWeight:800,
            color:'#fff', letterSpacing:'-0.03em', margin:0 }}>
            {buildSubTab==='builds' ? 'Build History' : 'Environments'}
          </h2>
          <div style={{ display:'flex', background:'rgba(255,255,255,0.04)', borderRadius:7, padding:3, gap:2 }}>
            {(['builds','environments'] as const).map(t=>(
              <button key={t} onClick={()=>setBuildSubTab(t)} style={{
                padding:'5px 14px', borderRadius:5, border:'none', cursor:'pointer',
                background:buildSubTab===t?'rgba(0,212,255,0.12)':'transparent',
                color:buildSubTab===t?'#00d4ff':'#545f72',
                fontFamily:"'Figtree',sans-serif", fontSize:12, fontWeight:buildSubTab===t?600:400,
                transition:'all 0.15s'
              }}>{t==='builds'?'Builds':'Environments'}</button>
            ))}
          </div>
        </div>
        <div style={{ display:'flex', gap:8 }}>
          {buildSubTab==='environments' && (
            <button onClick={()=>setShowAddEnv(s=>!s)} style={{ display:'flex', alignItems:'center', gap:6,
              padding:'7px 14px', background:'rgba(0,229,160,0.08)', border:'1px solid rgba(0,229,160,0.2)',
              borderRadius:7, color:'#00e5a0', cursor:'pointer', fontSize:12, fontFamily:"'Figtree',sans-serif" }}>
              <Plus size={12}/> Add Env
            </button>
          )}
          <button onClick={triggerBuild} style={{ display:'flex', alignItems:'center', gap:8,
            padding:'9px 18px', background:'#00d4ff', color:'#000', border:'none',
            borderRadius:7, fontSize:13, fontWeight:700, cursor:'pointer',
            fontFamily:"'Figtree',sans-serif" }}>
            <Play size={13} fill="#000"/> Run Build
          </button>
        </div>
      </div>

      {/* ══ BUILDS SUB-TAB ══════════════════════════════════════════════════════ */}
      {buildSubTab === 'builds' && (<>
      {selBuild ? (
        <div style={{ display:'flex', gap:16, alignItems:'flex-start' }}>
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
                      background:active?'rgba(0,212,255,0.08)':' rgba(255,255,255,0.02)',
                      border:`1px solid ${active?'rgba(0,212,255,0.2)':'rgba(255,255,255,0.06)'}` }}>
                    <span style={{ width:7, height:7, borderRadius:'50%', background:col, flexShrink:0,
                      boxShadow:b.status==='running'?`0 0 6px ${col}`:'none' }}/>
                    <div style={{ flex:1, minWidth:0 }}>
                      <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11,
                        color:active?'#00d4ff':'#e8eaf0', fontWeight:active?700:400 }}>
                        #{b.number ?? b.id.slice(0,4)}
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

            {selBuild.status === 'running' && (
              <Card style={{ marginBottom:12 }}>
                <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                  <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
                    letterSpacing:'0.1em', textTransform:'uppercase' }}>Live Log</span>
                  <button onClick={()=>setAiOpen(true)} style={{ display:'flex', alignItems:'center', gap:6,
                    padding:'5px 12px', background:'rgba(160,120,255,0.08)', border:'1px solid rgba(160,120,255,0.2)',
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
                          {jobSteps.map(step => <StepRow key={step.id} step={step} onExplain={(name, log) => {
                            setAiOpen(true); setLoading(true);
                            const msg = `Explain why the "${name}" step failed in build #${selBuild.number} for project "${sel?.name}":\n\n${log||'No log output.'}`;
                            setMsgs(m=>[...m,{role:'user',content:msg}]);
                            fetch('http://localhost:8080/api/v1/ai/explain-build', {
                              method:'POST', headers:{'Content-Type':'application/json'},
                              body: JSON.stringify({ build_id: selBuild.id, logs: log, pipeline: '' }),
                            }).then(r=>r.json()).then(d=>{
                              setMsgs(m=>[...m,{role:'assistant',content:d.explanation||'No explanation returned.'}]);
                            }).catch(()=>{
                              setMsgs(m=>[...m,{role:'assistant',content:'Could not reach backend.'}]);
                            }).finally(()=>setLoading(false));
                          }}/>)}
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
                    <span>{b.commit_sha?.slice(0,7)}</span>
                    <span>{b.branch}</span>
                    <span>{timeAgo(b.created_at)}</span>
                  </div>
                </div>
                <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:'#545f72', flexShrink:0 }}>
                  {b.duration?formatDuration(b.duration):'—'}
                </div>
                <ChevronRight size={14} style={{ color:'#545f72' }}/>
              </div>
            </Card>
          ))}
        </div>
      )}
      </>)}

      {/* ══ ENVIRONMENTS SUB-TAB ════════════════════════════════════════════════ */}
      {buildSubTab === 'environments' && (<>
        {/* Add env form */}
        {showAddEnv && (
          <Card style={{ marginBottom:16, padding:16 }}>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12 }}>
              {[['Name','name','text'],['Description','description','text']].map(([lbl,field])=>(
                <div key={field}>
                  <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72', letterSpacing:'0.08em', textTransform:'uppercase', marginBottom:6 }}>{lbl}</div>
                  <input value={(newEnv as any)[field]} onChange={e=>setNewEnv(n=>({...n,[field]:e.target.value}))}
                    style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)', borderRadius:6, padding:'8px 10px', color:'#e8eaf0', outline:'none', fontFamily:"'Figtree',sans-serif", fontSize:13, boxSizing:'border-box' as const }}/>
                </div>
              ))}
              <div style={{ display:'flex', gap:8, alignItems:'center', marginTop:4 }}>
                <label style={{ display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontFamily:"'Figtree',sans-serif", fontSize:13, color:'#8892a4' }}>
                  <input type="checkbox" checked={newEnv.auto_deploy} onChange={e=>setNewEnv(n=>({...n,auto_deploy:e.target.checked}))}/> Auto deploy
                </label>
                <label style={{ display:'flex', alignItems:'center', gap:6, cursor:'pointer', fontFamily:"'Figtree',sans-serif", fontSize:13, color:'#8892a4' }}>
                  <input type="checkbox" checked={newEnv.requires_approval} onChange={e=>setNewEnv(n=>({...n,requires_approval:e.target.checked}))}/> Requires approval
                </label>
              </div>
              <button onClick={async ()=>{
                if(!sel||!newEnv.name.trim()) return;
                const r = await fetch(`http://localhost:8080/api/v1/projects/${sel.id}/environments`,{
                  method:'POST', headers:{'Content-Type':'application/json'},
                  body: JSON.stringify({...newEnv, color: ENV_COLORS[newEnv.name.toLowerCase()]??'#00e5a0'})
                });
                if(r.ok){ const e=await r.json(); setEnvs(es=>[...es,e]); setNewEnv({name:'',description:'',color:'#00e5a0',auto_deploy:false,requires_approval:false}); setShowAddEnv(false); }
              }} style={{ padding:'8px 18px', background:'#00e5a0', color:'#000', border:'none', borderRadius:6, fontWeight:700, cursor:'pointer', fontFamily:"'Figtree',sans-serif", fontSize:13, marginTop:4 }}>
                Create Environment
              </button>
            </div>
          </Card>
        )}

        {envs.length === 0 ? (
          <Card style={{ textAlign:'center', padding:'40px 0' }}>
            <Globe size={28} style={{ color:'#545f72', marginBottom:10 }}/>
            <div style={{ fontFamily:"'Figtree',sans-serif", fontSize:14, color:'#545f72' }}>No environments yet</div>
            <div style={{ fontFamily:"'Figtree',sans-serif", fontSize:12, color:'#3a4050', marginTop:4 }}>Click Add Env to create test, staging or production environments</div>
          </Card>
        ) : (
          <div style={{ display:'flex', gap:16, alignItems:'flex-start' }}>
            {/* Left: env list */}
            <div style={{ width:300, flexShrink:0, display:'flex', flexDirection:'column', gap:8 }}>
              {envs.map((env:any) => {
                const envDeps = deployments.filter(d=>d.environment_id===env.id);
                const latestDep = envDeps[0] ?? null;
                const envCol = ENV_COLORS[env.name?.toLowerCase()] ?? env.color ?? '#00e5a0';
                return (
                  <Card key={env.id} style={{ padding:0 }}>
                    {/* Env header */}
                    <div style={{ display:'flex', alignItems:'center', gap:8, padding:'10px 14px', borderBottom:'1px solid rgba(255,255,255,0.06)' }}>
                      <span style={{ width:8, height:8, borderRadius:'50%', background:envCol, flexShrink:0 }}/>
                      <span style={{ fontFamily:"'Figtree',sans-serif", fontSize:13, fontWeight:700, color:'#fff', flex:1 }}>{env.name}</span>
                      {env.auto_deploy && <span style={{ fontSize:10, padding:'2px 7px', borderRadius:4, background:'rgba(0,229,160,0.1)', color:'#00e5a0', fontFamily:"'IBM Plex Mono',monospace" }}>auto</span>}
                      {env.requires_approval && <span style={{ fontSize:10, padding:'2px 7px', borderRadius:4, background:'rgba(245,197,66,0.1)', color:'#f5c542', fontFamily:"'IBM Plex Mono',monospace" }}>approval</span>}
                      <button onClick={()=>openDeployModal(env.id, env.name)} disabled={!!deploying}
                        style={{ display:'flex', alignItems:'center', gap:5, padding:'4px 10px', background:'rgba(0,212,255,0.1)', border:'1px solid rgba(0,212,255,0.25)', borderRadius:5, color:'#00d4ff', cursor:'pointer', fontSize:11, fontFamily:"'Figtree',sans-serif" }}>
                        <Rocket size={10}/> Deploy
                      </button>
                    </div>
                    {/* Currently deployed */}
                    {latestDep && latestDep.status==='success' && (
                      <div style={{ padding:'8px 14px', borderBottom:'1px solid rgba(255,255,255,0.04)', display:'flex', alignItems:'center', gap:8 }}>
                        <span style={{ width:6, height:6, borderRadius:'50%', background:'#00e5a0', flexShrink:0 }}/>
                        <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#00e5a0' }}>
                          live: build #{projBuilds.find(b=>b.id===latestDep.build_id)?.number??'?'}
                        </span>
                        <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72', marginLeft:'auto' }}>{timeAgo(latestDep.created_at)}</span>
                      </div>
                    )}
                    {/* Deployment history */}
                    <div style={{ display:'flex', flexDirection:'column', gap:2, padding:'6px 8px' }}>
                      {envDeps.slice(0,5).map((d:any)=>{
                        const isSelected = selDep?.id === d.id;
                        const dCol = d.status==='success'?'#00e5a0':d.status==='failed'?'#ff4455':d.status==='running'?'#00d4ff':'#f5c542';
                        const bNum = projBuilds.find(b=>b.id===d.build_id)?.number;
                        return (
                          <div key={d.id} onClick={()=>setSelDep(d)}
                            style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 6px', borderRadius:5, cursor:'pointer',
                              background:isSelected?'rgba(0,212,255,0.07)':'transparent',
                              border:`1px solid ${isSelected?'rgba(0,212,255,0.15)':'transparent'}`,
                              transition:'background 0.12s' }}
                            onMouseEnter={e=>{ if(!isSelected)(e.currentTarget as HTMLElement).style.background='rgba(255,255,255,0.03)'; }}
                            onMouseLeave={e=>{ if(!isSelected)(e.currentTarget as HTMLElement).style.background='transparent'; }}>
                            <span style={{ width:6, height:6, borderRadius:'50%', background:dCol, flexShrink:0 }}/>
                            <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:dCol, width:48, flexShrink:0 }}>{d.status}</span>
                            {bNum && <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72' }}>#{bNum}</span>}
                            <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72', marginLeft:'auto' }}>{timeAgo(d.created_at)}</span>
                            {d.status==='pending' && (
                              <button onClick={async e=>{ e.stopPropagation();
                                await fetch(`http://localhost:8080/api/v1/deployments/${d.id}/approve`,{method:'POST'});
                                setTimeout(reloadDeployments, 800);
                              }} style={{ padding:'2px 8px', background:'rgba(245,197,66,0.12)', border:'1px solid rgba(245,197,66,0.3)', borderRadius:4, color:'#f5c542', cursor:'pointer', fontSize:10, fontFamily:"'Figtree',sans-serif" }}>
                                Approve
                              </button>
                            )}
                          </div>
                        );
                      })}
                      {envDeps.length===0 && <div style={{ padding:'8px 6px', fontSize:11, color:'#3a4050', fontFamily:"'Figtree',sans-serif", fontStyle:'italic' }}>No deployments yet</div>}
                    </div>
                  </Card>
                );
              })}
            </div>

            {/* Right: deploy log viewer */}
            <div style={{ flex:1, minWidth:0 }}>
              {selDep ? (
                <Card><DeployLog dep={selDep}/></Card>
              ) : (
                <Card style={{ textAlign:'center', padding:'60px 0' }}>
                  <Rocket size={28} style={{ color:'#545f72', marginBottom:10 }}/>
                  <div style={{ fontFamily:"'Figtree',sans-serif", fontSize:14, color:'#545f72' }}>Select a deployment to view logs</div>
                  <div style={{ fontFamily:"'Figtree',sans-serif", fontSize:12, color:'#3a4050', marginTop:4 }}>Or click Deploy to push a build to an environment</div>
                </Card>
              )}
            </div>
          </div>
        )}

        {/* Deploy version picker modal */}
        {deployTarget && (
          <div style={{ position:'fixed', inset:0, zIndex:200, display:'flex', alignItems:'center', justifyContent:'center',
            background:'rgba(0,0,0,0.7)', backdropFilter:'blur(8px)' }} onClick={()=>setDeployTarget(null)}>
            <div style={{ background:'#111620', border:'1px solid rgba(255,255,255,0.1)', borderRadius:12, padding:28, width:480, maxHeight:'80vh', overflowY:'auto' }}
              onClick={e=>e.stopPropagation()}>
              <div style={{ fontFamily:"'Figtree',sans-serif", fontSize:17, fontWeight:700, color:'#fff', marginBottom:4 }}>
                Deploy to <span style={{ color: ENV_COLORS[deployTarget.envName.toLowerCase()]??'#00e5a0' }}>{deployTarget.envName}</span>
              </div>
              <div style={{ fontFamily:"'Figtree',sans-serif", fontSize:13, color:'#545f72', marginBottom:18 }}>Pick a successful build to deploy</div>
              <div style={{ display:'flex', flexDirection:'column', gap:4, marginBottom:20 }}>
                {projBuilds.filter(b=>b.status==='success').map(b=>(
                  <div key={b.id} onClick={()=>setPickedVersion(b.id)}
                    style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px', borderRadius:7, cursor:'pointer',
                      background:pickedVersion===b.id?'rgba(0,212,255,0.08)':'rgba(255,255,255,0.02)',
                      border:`1px solid ${pickedVersion===b.id?'rgba(0,212,255,0.25)':'rgba(255,255,255,0.06)'}` }}>
                    <span style={{ width:7, height:7, borderRadius:'50%', background:'#00e5a0', flexShrink:0 }}/>
                    <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:'#00e5a0', fontWeight:600 }}>#{b.number??b.id.slice(0,4)}</span>
                    <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#545f72' }}>{(b.commit??b.commit_sha??'').slice(0,7)}</span>
                    <span style={{ fontSize:12, color:'#8892a4', fontFamily:"'Figtree',sans-serif", flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{b.commit_message}</span>
                    <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72', flexShrink:0 }}>{timeAgo(b.created_at)}</span>
                  </div>
                ))}
                {projBuilds.filter(b=>b.status==='success').length===0 && (
                  <div style={{ textAlign:'center', padding:'20px 0', color:'#545f72', fontFamily:"'Figtree',sans-serif", fontSize:13 }}>No successful builds yet — run a build first</div>
                )}
              </div>
              <div style={{ display:'flex', gap:10, justifyContent:'flex-end' }}>
                <button onClick={()=>setDeployTarget(null)} style={{ padding:'9px 18px', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.1)', borderRadius:7, color:'#8892a4', cursor:'pointer', fontFamily:"'Figtree',sans-serif", fontSize:13 }}>Cancel</button>
                <button onClick={confirmDeploy} disabled={!pickedVersion}
                  style={{ padding:'9px 22px', background: pickedVersion?'#00d4ff':'rgba(0,212,255,0.3)', color:pickedVersion?'#000':'#545f72', border:'none', borderRadius:7, fontWeight:700, cursor:pickedVersion?'pointer':'default', fontFamily:"'Figtree',sans-serif", fontSize:13 }}>
                  Deploy Build #{projBuilds.find(b=>b.id===pickedVersion)?.number ?? '—'}
                </button>
              </div>
            </div>
          </div>
        )}
      </>)}
    </div>
    );
  }

  /* ════════════════════════════════════════════════════════════════════════════
     PIPELINE — Jenkins-style job config
     Tabs: General | Triggers | Steps | AI | Environments | Notifications
  ════════════════════════════════════════════════════════════════════════════ */
  const Pipeline = () => {
    type PipelineTab = 'general' | 'triggers' | 'steps' | 'ai' | 'environments' | 'notifications';
    const [tab, setTab] = useState<PipelineTab>('general');
    const [saving, setSaving] = useState(false);
    const [saved, setSaved]   = useState(false);

    // ── General
    const [pName,     setPName]     = useState(sel?.name ?? '');
    const [pDesc,     setPDesc]     = useState('');
    const [pRepo,     setPRepo]     = useState(sel?.repo_url ?? '');
    const [pBranch,   setPBranch]   = useState(sel?.branch ?? 'main');
    const [pImage,    setPImage]    = useState('callahan:latest');
    const [pTimeout,  setPTimeout]  = useState('30');

    // ── Triggers
    const [tPush,    setTPush]    = useState(true);
    const [tPR,      setTPR]      = useState(true);
    const [tManual,  setTManual]  = useState(true);
    const [tCron,    setTCron]    = useState('');

    // ── Steps
    type Step = { id: string; name: string; run: string; continueOnError: boolean };
    const [steps, setSteps] = useState<Step[]>([]);
    const addStep = () => setSteps(s=>[...s,{ id:Date.now().toString(), name:'', run:'', continueOnError:false }]);
    const delStep = (id:string) => setSteps(s=>s.filter(x=>x.id!==id));
    const updateStep = (id:string, field:keyof Step, val:string|boolean) =>
      setSteps(s=>s.map(x=>x.id===id?{...x,[field]:val}:x));

    // ── Steps toolbar (AI generate + YAML editor)
    const [aiPrompt,     setAiPrompt]     = useState('');
    const [aiGenerating, setAiGenerating] = useState(false);
    const [showAiBox,    setShowAiBox]    = useState(false);
    const [showYaml,     setShowYaml]     = useState(false);
    const [yamlText,     setYamlText]     = useState('');

    const applyYaml = (yaml: string) => {
      const lines = yaml.split('\n');
      const parsed: Step[] = [];
      let i = 0;
      while (i < lines.length) {
        const nameLine = lines[i].match(/^\s*-\s+name:\s*(.+)$/);
        if (nameLine) {
          const name = nameLine[1].trim();
          let run = ''; let continueOnError = false;
          i++;
          while (i < lines.length && !lines[i].match(/^\s*-\s+name:/)) {
            const runLine = lines[i].match(/^\s+run:\s*(.+)$/);
            const coeLine = lines[i].match(/^\s+continue-on-error:\s*true/);
            if (runLine) run = runLine[1].trim();
            if (coeLine) continueOnError = true;
            i++;
          }
          if (name && run) parsed.push({ id: Date.now().toString()+parsed.length, name, run, continueOnError });
        } else { i++; }
      }
      if (parsed.length > 0) setSteps(parsed);
    };

    const generateSteps = async () => {
      if (!aiPrompt.trim() || !sel) return;
      setAiGenerating(true);
      try {
        const r = await fetch('http://localhost:8080/api/v1/ai/generate-pipeline', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ description: aiPrompt, language: sel.language||'', framework: sel.framework||'' })
        });
        const d = await r.json();
        if (d.content) {
          applyYaml(d.content);
          setShowAiBox(false);
          setAiPrompt('');
        }
      } catch {}
      setAiGenerating(false);
    };

    // ── AI
    const [aiReview,    setAiReview]    = useState(true);
    const [aiSecurity,  setAiSecurity]  = useState(true);
    const [aiExplain,   setAiExplain]   = useState(true);
    const [aiModel,     setAiModel]     = useState('');

    // ── Environments
    const [envs,        setEnvs]        = useState<any[]>([]);
    const [deployments, setDeployments] = useState<any[]>([]);
    const [showAddEnv,  setShowAddEnv]  = useState(false);
    const [newEnv, setNewEnv] = useState({ name:'', description:'', color:'#00e5a0', auto_deploy:false, requires_approval:false, branch_filter:'' });
    const [deploying,   setDeploying]   = useState<string|null>(null);
    const [guardResult, setGuardResult] = useState<{safe:boolean;concerns:string[]}|null>(null);
    // Version picker modal
    const [deployTarget, setDeployTarget] = useState<{envId:string;envName:string}|null>(null);
    const [versions,     setVersions]     = useState<any[]>([]);
    const [pickedVersion, setPickedVersion] = useState<string>('latest');

    const ENV_COLORS: Record<string,string> = { dev:'#00d4ff', test:'#00e5a0', staging:'#f5c542', prod:'#ff4455' };

    // ── Notifications
    const [channels,    setChannels]    = useState<any[]>([]);
    const [showAddCh,   setShowAddCh]   = useState(false);
    const [chPlatform,  setChPlatform]  = useState('slack');
    const [chName,      setChName]      = useState('');
    const [chWebhook,   setChWebhook]   = useState('');
    const [chOnSuccess, setChOnSuccess] = useState(true);
    const [chOnFailure, setChOnFailure] = useState(true);
    const [chOnCancel,  setChOnCancel]  = useState(false);
    const [chAiMsg,     setChAiMsg]     = useState(true);
    const [chSaving,    setChSaving]    = useState(false);
    const [notifPreviewing, setNotifPreviewing] = useState(false);
    const [notifPreview,    setNotifPreview]    = useState('');

    useEffect(() => {
      if (!sel) return;
      fetch(`http://localhost:8080/api/v1/projects/${sel.id}/environments`).then(r=>r.json()).then(d=>setEnvs(Array.isArray(d)?d:[])).catch(()=>{});
      fetch(`http://localhost:8080/api/v1/projects/${sel.id}/deployments`).then(r=>r.json()).then(d=>setDeployments(Array.isArray(d)?d:[])).catch(()=>{});
      fetch(`http://localhost:8080/api/v1/projects/${sel.id}/notifications`).then(r=>r.json()).then(d=>setChannels(Array.isArray(d)?d:[])).catch(()=>{});
      fetch(`http://localhost:8080/api/v1/projects/${sel.id}/versions`).then(r=>r.json()).then(d=>setVersions(Array.isArray(d)?d:[])).catch(()=>{});
      // Load saved pipeline and parse steps
      fetch(`http://localhost:8080/api/v1/projects/${sel.id}/pipeline`).then(r=>r.json()).then(d=>{
        if (!d.content) return;
        const lines = d.content.split('\n');
        const parsed: Step[] = [];
        let i = 0;
        while (i < lines.length) {
          const nameLine = lines[i].match(/^\s*-\s+name:\s*(.+)$/);
          if (nameLine) {
            const name = nameLine[1].trim();
            let run = '';
            let continueOnError = false;
            i++;
            while (i < lines.length && !lines[i].match(/^\s*-\s+name:/)) {
              const runLine = lines[i].match(/^\s+run:\s*(.+)$/);
              const coeLine = lines[i].match(/^\s+continue-on-error:\s*true/);
              if (runLine) run = runLine[1].trim();
              if (coeLine) continueOnError = true;
              i++;
            }
            if (name && run) parsed.push({ id: Date.now().toString() + parsed.length, name, run, continueOnError });
          } else { i++; }
        }
        if (parsed.length > 0) setSteps(parsed);
      }).catch(()=>{});
    }, [sel?.id]);

    const savePipeline = async () => {
      if (!sel) return;
      setSaving(true);
      const yaml = [
        `name: ${pName}`,
        `on:${[tPush&&' push',tPR&&' pull_request',tManual&&' manual'].filter(Boolean).join(',')}`,
        tCron ? `  schedule: "${tCron}"` : null,
        `\njobs:\n  build:`,
        `    runs-on: ${pImage}`,
        `    timeout: ${pTimeout}m`,
        `    steps:`,
        ...steps.map(s=>`      - name: ${s.name}\n        run: ${s.run}${s.continueOnError?'\n        continue-on-error: true':''}`),
        `\n    ai:`,
        `      review: ${aiReview}`,
        `      security-scan: ${aiSecurity}`,
        `      explain-failures: ${aiExplain}`,
      ].filter(x=>x!==null).join('\n');
      try {
        await fetch(`http://localhost:8080/api/v1/projects/${sel.id}/pipeline`, {
          method:'PUT', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ content: yaml })
        });
      } catch {}
      setSaving(false); setSaved(true); setTimeout(()=>setSaved(false), 2000);
    };

    // Env helpers
    const createEnv = async () => {
      if (!sel || !newEnv.name) return;
      const color = ENV_COLORS[newEnv.name.toLowerCase()] || newEnv.color;
      const r = await fetch(`http://localhost:8080/api/v1/projects/${sel.id}/environments`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({...newEnv, color})
      });
      if (r.ok) { const d = await r.json(); setEnvs(e=>[...e,d]); setShowAddEnv(false); setNewEnv({name:'',description:'',color:'#00e5a0',auto_deploy:false,requires_approval:false,branch_filter:''}); }
    };
    const deleteEnv = async (id: string) => {
      await fetch(`http://localhost:8080/api/v1/environments/${id}`, {method:'DELETE'});
      setEnvs(e=>e.filter(x=>x.id!==id));
    };
    const openDeployModal = (envId: string, envName: string) => {
      const latestSuccess = projBuilds.find(b=>b.status==='success');
      setPickedVersion(latestSuccess?.id ?? '');
      setDeployTarget({ envId, envName });
    };
    const confirmDeploy = async () => {
      if (!sel || !deployTarget || !pickedVersion) return;
      const buildId = pickedVersion; // pickedVersion is now always a build ID
      const buildNum = projBuilds.find(b=>b.id===buildId)?.number ?? '';
      setDeploying(deployTarget.envId);
      setDeployTarget(null);
      const r = await fetch(`http://localhost:8080/api/v1/projects/${sel.id}/environments/${deployTarget.envId}/deploy`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ build_id: buildId, strategy:'direct', notes:`Deploy build #${buildNum} — Manual` })
      });
      if (r.ok) {
        const d = await r.json(); setDeployments(ds=>[d,...ds]);
        setTimeout(() => {
          fetch(`http://localhost:8080/api/v1/projects/${sel.id}/deployments`)
            .then(r=>r.json()).then(d=>setDeployments(Array.isArray(d)?d:[])).catch(()=>{});
        }, 3200);
      }
      setDeploying(null);
    };
    const lastDepForEnv = (envId: string) => deployments.find(d=>d.environment_id===envId);

    // Notification helpers
    const saveChannel = async () => {
      if (!sel || !chName || !chWebhook) return;
      setChSaving(true);
      const r = await fetch(`http://localhost:8080/api/v1/projects/${sel.id}/notifications`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ name:chName, platform:chPlatform, config:{ webhook_url:chWebhook },
          on_success:chOnSuccess, on_failure:chOnFailure, on_cancel:chOnCancel, ai_message:chAiMsg, enabled:true })
      });
      if (r.ok) { const d=await r.json(); setChannels(c=>[...c,d]); setShowAddCh(false); setChName(''); setChWebhook(''); }
      setChSaving(false);
    };
    const deleteChannel = async (id: string) => {
      await fetch(`http://localhost:8080/api/v1/notifications/${id}`, {method:'DELETE'});
      setChannels(c=>c.filter(x=>x.id!==id));
    };
    const generatePreview = async () => {
      setNotifPreviewing(true);
      try {
        const r = await fetch('http://localhost:8080/api/v1/ai/notification-preview', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ platform:chPlatform, status:'success' })
        });
        if(r.ok){ const d=await r.json(); setNotifPreview(d.message||''); }
      } catch{}
      setNotifPreviewing(false);
    };

    const PLATFORMS = [
      { id:'slack',     name:'Slack',       color:'#4a154b', desc:'Webhook URL from Slack app settings' },
      { id:'teams',     name:'Teams',       color:'#6264a7', desc:'Incoming webhook connector URL' },
      { id:'discord',   name:'Discord',     color:'#5865f2', desc:'Discord channel webhook URL' },
      { id:'jira',      name:'Jira',        color:'#0052cc', desc:'Jira Cloud base URL + API token' },
      { id:'azuredevops',name:'Azure DevOps',color:'#0078d4',desc:'Azure DevOps PAT + work item ID' },
      { id:'webhook',   name:'Webhook',     color:'#00e5a0', desc:'Any POST endpoint — JSON payload' },
    ];
    const pInfo = PLATFORMS.find(p=>p.id===chPlatform);

    const TABS: { id: PipelineTab; label: string; icon: React.ReactNode }[] = [
      { id:'general',      label:'General',      icon:<Settings size={13}/> },
      { id:'triggers',     label:'Triggers',     icon:<Zap size={13}/> },
      { id:'steps',        label:'Steps',        icon:<Terminal size={13}/> },
      { id:'ai',           label:'AI',           icon:<Sparkles size={13}/> },
      { id:'notifications',label:'Notifications',icon:<Bell size={13}/> },
    ];

    const inputStyle = { width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
      borderRadius:6, padding:'9px 12px', color:'#e8eaf0', outline:'none', boxSizing:'border-box' as const,
      fontFamily:"'Figtree',sans-serif", fontSize:13 };
    const monoInput = { ...inputStyle, fontFamily:"'IBM Plex Mono',monospace", fontSize:12 };

    return (
      <div style={{ display:'flex', flexDirection:'column', height:'100%' }}>

        {/* ── page header */}
        <div style={{ padding:'20px 28px 0', borderBottom:'1px solid rgba(255,255,255,0.07)' }}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:16 }}>
            <div>
              <h2 style={{ fontFamily:"'Figtree',sans-serif", fontSize:20, fontWeight:800,
                color:'#fff', letterSpacing:'-0.03em', margin:0 }}>Pipeline Configuration</h2>
              <p style={{ color:'#545f72', fontSize:12, fontFamily:"'Figtree',sans-serif", margin:'3px 0 0' }}>
                {sel?.name} — configure build, deploy, and notification behaviour
              </p>
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={()=>setAiOpen(true)} style={{ display:'flex', alignItems:'center', gap:7,
                padding:'8px 14px', background:'rgba(160,120,255,0.1)', border:'1px solid rgba(160,120,255,0.25)',
                borderRadius:7, color:'#a078ff', cursor:'pointer', fontSize:12,
                fontFamily:"'Figtree',sans-serif" }}>
                <Sparkles size={12}/> Generate with AI
              </button>
              <button onClick={savePipeline} disabled={saving} style={{ padding:'8px 18px',
                background: saved?'#00e5a0':'#00d4ff', color:'#000', border:'none',
                borderRadius:7, fontSize:13, fontWeight:700, cursor:'pointer',
                fontFamily:"'Figtree',sans-serif", transition:'background 0.2s', opacity:saving?0.7:1 }}>
                {saving ? 'Saving…' : saved ? '✔ Saved' : 'Save'}
              </button>
            </div>
          </div>

          {/* tabs */}
          <div style={{ display:'flex', gap:0, overflowX:'auto' }}>
            {TABS.map(t=>(
              <button key={t.id} onClick={()=>setTab(t.id)} style={{ display:'flex', alignItems:'center', gap:6,
                padding:'9px 16px', background:'none', border:'none', borderBottom:`2px solid ${tab===t.id?'#00d4ff':'transparent'}`,
                color: tab===t.id?'#00d4ff':'#545f72', cursor:'pointer', fontSize:13, fontWeight: tab===t.id?600:400,
                fontFamily:"'Figtree',sans-serif", whiteSpace:'nowrap', transition:'color 0.15s' }}>
                {t.icon}{t.label}
              </button>
            ))}
          </div>
        </div>

        {/* ── tab content */}
        <div style={{ flex:1, overflowY:'auto', padding:28 }}>

          {/* ── GENERAL ─────────────────────────────────────────────── */}
          {tab==='general' && (
            <div style={{ maxWidth:640 }}>
              <SectionLabel>Project</SectionLabel>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, marginBottom:14 }}>
                <Field label="Pipeline Name">
                  <input style={inputStyle} value={pName} onChange={e=>setPName(e.target.value)} placeholder={sel?.name}/>
                </Field>
                <Field label="Default Branch">
                  <input style={inputStyle} value={pBranch} onChange={e=>setPBranch(e.target.value)} placeholder="main"/>
                </Field>
              </div>
              <Field label="Repository URL">
                <input style={inputStyle} value={pRepo} onChange={e=>setPRepo(e.target.value)} placeholder="https://github.com/org/repo"/>
              </Field>
              <Field label="Description">
                <textarea value={pDesc} onChange={e=>setPDesc(e.target.value)} placeholder="What does this pipeline build?"
                  style={{ ...inputStyle, resize:'vertical', minHeight:72 }}/>
              </Field>
              <div style={{ height:1, background:'rgba(255,255,255,0.07)', margin:'20px 0' }}/>
              <SectionLabel>Runtime</SectionLabel>
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14 }}>
                <Field label="Docker Image" hint="Used for all steps unless overridden">
                  <input style={monoInput} value={pImage} onChange={e=>setPImage(e.target.value)} placeholder="callahan:latest"/>
                </Field>
                <Field label="Timeout (minutes)">
                  <input type="number" min="1" max="180" style={monoInput} value={pTimeout} onChange={e=>setPTimeout(e.target.value)}/>
                </Field>
              </div>
            </div>
          )}

          {/* ── TRIGGERS ─────────────────────────────────────────────── */}
          {tab==='triggers' && (
            <div style={{ maxWidth:540 }}>
              <SectionLabel>Build Triggers</SectionLabel>
              <Card style={{ marginBottom:14 }}>
                <div style={{ display:'flex', flexDirection:'column', gap:14 }}>
                  <Toggle checked={tPush}   onChange={setTPush}   label="Push to branch"/>
                  <Toggle checked={tPR}     onChange={setTPR}     label="Pull Request / Merge Request"/>
                  <Toggle checked={tManual} onChange={setTManual} label="Manual trigger (Run Build button)"/>
                </div>
              </Card>
              <Field label="Cron Schedule (optional)" hint='e.g. "0 2 * * *" runs nightly at 02:00 UTC'>
                <input style={monoInput} value={tCron} onChange={e=>setTCron(e.target.value)} placeholder='0 2 * * *'/>
              </Field>
            </div>
          )}

          {/* ── STEPS ─────────────────────────────────────────────────── */}
          {tab==='steps' && (
            <div style={{ maxWidth:720 }}>
              {/* toolbar */}
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                <SectionLabel>Build Steps</SectionLabel>
                <div style={{ display:'flex', gap:8 }}>
                  <button onClick={()=>{ setShowYaml(v=>!v); setYamlText(steps.map(s=>`      - name: ${s.name}\n        run: ${s.run}${s.continueOnError?'\n        continue-on-error: true':''}`).join('\n')); }}
                    style={{ display:'flex', alignItems:'center', gap:5,
                      padding:'6px 12px', background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.1)',
                      borderRadius:6, color:'#8892a4', cursor:'pointer', fontSize:12, fontFamily:"'Figtree',sans-serif" }}>
                    {showYaml ? 'Form view' : 'Edit YAML'}
                  </button>
                  <button onClick={()=>setShowAiBox(v=>!v)} style={{ display:'flex', alignItems:'center', gap:5,
                    padding:'6px 12px', background:'rgba(160,120,255,0.08)', border:'1px solid rgba(160,120,255,0.2)',
                    borderRadius:6, color:'#a078ff', cursor:'pointer', fontSize:12, fontFamily:"'Figtree',sans-serif" }}>
                    <Sparkles size={11}/> Generate with AI
                  </button>
                  {!showYaml && <button onClick={addStep} style={{ display:'flex', alignItems:'center', gap:5,
                    padding:'6px 12px', background:'rgba(0,212,255,0.08)', border:'1px solid rgba(0,212,255,0.2)',
                    borderRadius:6, color:'#00d4ff', cursor:'pointer', fontSize:12, fontFamily:"'Figtree',sans-serif" }}>
                    <Plus size={12}/> Add Step
                  </button>}
                </div>
              </div>

              {/* AI prompt box */}
              {showAiBox && (
                <Card style={{ marginBottom:14, padding:'14px 16px' }}>
                  <div style={{ fontSize:12, color:'#a078ff', fontWeight:600, marginBottom:8, fontFamily:"'Figtree',sans-serif" }}>
                    ✦ Describe your pipeline in plain English
                  </div>
                  <textarea value={aiPrompt} onChange={e=>setAiPrompt(e.target.value)}
                    placeholder="e.g. Test and build a Go CLI tool, run go vet, go test, then go build"
                    style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(160,120,255,0.2)',
                      borderRadius:6, padding:'10px 12px', color:'#e8eaf0', outline:'none',
                      fontFamily:"'Figtree',sans-serif", fontSize:13, resize:'vertical', minHeight:72,
                      boxSizing:'border-box' }}/>
                  <div style={{ display:'flex', gap:8, marginTop:10 }}>
                    <button onClick={()=>setShowAiBox(false)} style={{ padding:'7px 14px', background:'transparent',
                      border:'1px solid rgba(255,255,255,0.1)', borderRadius:6, color:'#545f72',
                      cursor:'pointer', fontSize:12, fontFamily:"'Figtree',sans-serif" }}>Cancel</button>
                    <button onClick={generateSteps} disabled={aiGenerating||!aiPrompt.trim()} style={{ display:'flex', alignItems:'center', gap:6,
                      padding:'7px 18px', background:'#a078ff', border:'none', borderRadius:6,
                      color:'#000', cursor:aiGenerating?'wait':'pointer', fontSize:12,
                      fontFamily:"'Figtree',sans-serif", fontWeight:700, opacity:aiGenerating?0.6:1 }}>
                      {aiGenerating ? <><Loader2 size={12} style={{animation:'spin 1s linear infinite'}}/> Generating…</> : <><Sparkles size={12}/> Generate</>}
                    </button>
                  </div>
                </Card>
              )}

              {/* YAML editor */}
              {showYaml ? (
                <Card style={{ padding:'14px 16px' }}>
                  <div style={{ fontSize:11, color:'#545f72', marginBottom:8, fontFamily:"'Figtree',sans-serif" }}>
                    Paste or edit YAML steps — then click Apply
                  </div>
                  <textarea value={yamlText} onChange={e=>setYamlText(e.target.value)}
                    style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.1)',
                      borderRadius:6, padding:'12px', color:'#e8eaf0', outline:'none',
                      fontFamily:"'IBM Plex Mono',monospace", fontSize:12, resize:'vertical', minHeight:180,
                      boxSizing:'border-box', lineHeight:1.6 }}/>
                  <button onClick={()=>{ applyYaml(yamlText); setShowYaml(false); }}
                    style={{ marginTop:10, padding:'7px 18px', background:'#00d4ff', border:'none',
                      borderRadius:6, color:'#000', cursor:'pointer', fontSize:12,
                      fontFamily:"'Figtree',sans-serif", fontWeight:700 }}>
                    Apply YAML
                  </button>
                </Card>
              ) : (
                <>
                  <div style={{ display:'flex', flexDirection:'column', gap:10 }}>
                    {steps.map((s, idx)=>(
                      <Card key={s.id} style={{ padding:'14px 18px' }}>
                        <div style={{ display:'flex', alignItems:'flex-start', gap:12 }}>
                          <div style={{ width:24, height:24, borderRadius:6, background:'rgba(0,212,255,0.1)',
                            border:'1px solid rgba(0,212,255,0.2)', display:'flex', alignItems:'center',
                            justifyContent:'center', flexShrink:0, marginTop:2 }}>
                            <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#00d4ff' }}>{idx+1}</span>
                          </div>
                          <div style={{ flex:1, display:'grid', gridTemplateColumns:'1fr 2fr', gap:10 }}>
                            <div>
                              <div style={{ fontSize:11, color:'#545f72', marginBottom:4, fontFamily:"'Figtree',sans-serif" }}>Step Name</div>
                              <input style={{ ...inputStyle, fontSize:12 }} value={s.name} placeholder="e.g. Install"
                                onChange={e=>updateStep(s.id,'name',e.target.value)}/>
                            </div>
                            <div>
                              <div style={{ fontSize:11, color:'#545f72', marginBottom:4, fontFamily:"'Figtree',sans-serif" }}>Command</div>
                              <input style={{ ...monoInput }} value={s.run} placeholder="e.g. go test ./..."
                                onChange={e=>updateStep(s.id,'run',e.target.value)}/>
                            </div>
                          </div>
                          <div style={{ display:'flex', alignItems:'center', gap:10, marginTop:6 }}>
                            <label style={{ display:'flex', alignItems:'center', gap:5, cursor:'pointer' }}>
                              <input type="checkbox" checked={s.continueOnError}
                                onChange={e=>updateStep(s.id,'continueOnError',e.target.checked)}/>
                              <span style={{ fontSize:11, color:'#545f72', fontFamily:"'Figtree',sans-serif", whiteSpace:'nowrap' }}>
                                Continue on error
                              </span>
                            </label>
                            <button onClick={()=>delStep(s.id)} style={{ background:'none', border:'none',
                              cursor:'pointer', color:'#545f72', lineHeight:0, padding:4 }}
                              onMouseEnter={e=>(e.currentTarget.style.color='#ff4455')}
                              onMouseLeave={e=>(e.currentTarget.style.color='#545f72')}>
                              <Trash2 size={13}/>
                            </button>
                          </div>
                        </div>
                      </Card>
                    ))}
                  </div>
                  {steps.length===0 && (
                    <div style={{ textAlign:'center', padding:'32px 0', color:'#545f72', fontFamily:"'Figtree',sans-serif", fontSize:13 }}>
                      No steps yet — click Add Step, Generate with AI, or Edit YAML
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* ── AI ─────────────────────────────────────────────────────── */}
          {tab==='ai' && (
            <div style={{ maxWidth:560 }}>
              <SectionLabel>AI Features</SectionLabel>
              <Card style={{ marginBottom:14 }}>
                <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
                  <Toggle checked={aiReview}   onChange={setAiReview}   label="Code review on every build"/>
                  <Toggle checked={aiSecurity} onChange={setAiSecurity} label="Security scan (Semgrep / secret detection)"/>
                  <Toggle checked={aiExplain}  onChange={setAiExplain}  label="AI explain on build failure"/>
                </div>
              </Card>
              <Field label="Override AI Model" hint="Leave blank to use the globally configured model">
                <input style={monoInput} value={aiModel} onChange={e=>setAiModel(e.target.value)} placeholder="e.g. llama-3.3-70b-versatile"/>
              </Field>
              <div style={{ marginTop:8, padding:'12px 14px', background:'rgba(160,120,255,0.06)',
                border:'1px solid rgba(160,120,255,0.18)', borderRadius:8,
                fontFamily:"'Figtree',sans-serif", fontSize:12, color:'#8892a4', lineHeight:1.6 }}>
                <span style={{ color:'#a078ff', fontWeight:600 }}>✦ How it works:</span> Code review and security scan run as job cards after your steps complete. Results appear in the Build Log. AI explain triggers automatically when a step exits non-zero.
              </div>
            </div>
          )}

          {/* ── ENVIRONMENTS ──────────────────────────────────────────── */}
          {tab==='environments' && (
            <div style={{ maxWidth:900 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                <SectionLabel>Deploy Environments</SectionLabel>
                <button onClick={()=>setShowAddEnv(s=>!s)} style={{ display:'flex', alignItems:'center', gap:6,
                  padding:'6px 14px', background:'rgba(0,229,160,0.08)', border:'1px solid rgba(0,229,160,0.2)',
                  borderRadius:6, color:'#00e5a0', cursor:'pointer', fontSize:12, fontFamily:"'Figtree',sans-serif" }}>
                  <Plus size={12}/> Add Environment
                </button>
              </div>

              {/* Add env form */}
              {showAddEnv && (
                <Card style={{ marginBottom:16 }}>
                  <SectionLabel>New Environment</SectionLabel>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, marginBottom:12 }}>
                    {([['Name','name','e.g. staging'],['Branch Filter','branch_filter','e.g. main']] as [string,string,string][]).map(([label,field,ph])=>(
                      <div key={field}>
                        <div style={{ fontSize:11, color:'#545f72', marginBottom:4, fontFamily:"'Figtree',sans-serif" }}>{label}</div>
                        <input value={(newEnv as any)[field]} onChange={e=>setNewEnv(n=>({...n,[field]:e.target.value}))}
                          placeholder={ph} style={inputStyle}/>
                      </div>
                    ))}
                  </div>
                  <div style={{ display:'flex', gap:20, marginBottom:14 }}>
                    <Toggle checked={newEnv.auto_deploy} onChange={v=>setNewEnv(n=>({...n,auto_deploy:v}))} label="Auto-deploy on green build"/>
                    <Toggle checked={newEnv.requires_approval} onChange={v=>setNewEnv(n=>({...n,requires_approval:v}))} label="Require approval"/>
                  </div>
                  <div style={{ display:'flex', gap:8 }}>
                    <button onClick={()=>setShowAddEnv(false)} style={{ flex:1, padding:'8px', background:'transparent',
                      border:'1px solid rgba(255,255,255,0.1)', borderRadius:6, color:'#545f72', cursor:'pointer',
                      fontFamily:"'Figtree',sans-serif", fontSize:13 }}>Cancel</button>
                    <button onClick={createEnv} style={{ flex:2, padding:'8px', background:'#00e5a0',
                      border:'none', borderRadius:6, color:'#000', cursor:'pointer',
                      fontFamily:"'Figtree',sans-serif", fontSize:13, fontWeight:700 }}>Create Environment</button>
                  </div>
                </Card>
              )}

              {/* Quick create */}
              {envs.length===0 && !showAddEnv && (
                <div style={{ marginBottom:16 }}>
                  <div style={{ fontSize:12, color:'#545f72', marginBottom:8, fontFamily:"'Figtree',sans-serif" }}>Quick create standard environments:</div>
                  <div style={{ display:'flex', gap:8 }}>
                    {['dev','test','staging','prod'].map(name=>(
                      <button key={name} onClick={async ()=>{
                        if(!sel) return;
                        const r = await fetch(`http://localhost:8080/api/v1/projects/${sel.id}/environments`,{
                          method:'POST',headers:{'Content-Type':'application/json'},
                          body:JSON.stringify({name,color:ENV_COLORS[name],auto_deploy:name!=='prod',requires_approval:name==='prod'})
                        });
                        if(r.ok){const d=await r.json();setEnvs(e=>[...e,d]);}
                      }} style={{ padding:'7px 14px', borderRadius:6, cursor:'pointer',
                        background:`${ENV_COLORS[name]}15`, border:`1px solid ${ENV_COLORS[name]}40`,
                        color:ENV_COLORS[name], fontFamily:"'Figtree',sans-serif", fontSize:12, fontWeight:600 }}>
                        + {name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Guardrail warning */}
              {guardResult && !guardResult.safe && (
                <div style={{ marginBottom:14, padding:14, background:'rgba(255,68,85,0.08)',
                  border:'1px solid rgba(255,68,85,0.25)', borderRadius:8 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:8, marginBottom:8,
                    color:'#ff4455', fontWeight:700, fontFamily:"'Figtree',sans-serif" }}>
                    <AlertTriangle size={14}/> AI Deployment Guardrail — Concerns Detected
                  </div>
                  {guardResult.concerns.map((c,i)=>(
                    <div key={i} style={{ fontSize:12, color:'#ff8888', fontFamily:"'Figtree',sans-serif", marginLeft:22 }}>• {c}</div>
                  ))}
                  <button onClick={()=>setGuardResult(null)} style={{ marginTop:8, padding:'5px 12px',
                    background:'transparent', border:'1px solid rgba(255,68,85,0.3)', borderRadius:6,
                    color:'#ff4455', cursor:'pointer', fontSize:12, fontFamily:"'Figtree',sans-serif" }}>Dismiss</button>
                </div>
              )}

              {/* Env cards */}
              <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
                {envs.map(env=>{
                  const envDeps = deployments.filter(d=>d.environment_id===env.id).slice(0,5);
                  const latestDep = envDeps[0];
                  const deployedBuild = latestDep ? projBuilds.find(b=>b.id===latestDep.build_id) : null;
                  const isDeploying = deploying===env.id;
                  return (
                    <Card key={env.id} style={{ borderLeft:`3px solid ${env.color||'#545f72'}`, padding:0, overflow:'hidden' }}>
                      {/* Header row */}
                      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between',
                        padding:'14px 16px', borderBottom:'1px solid rgba(255,255,255,0.06)' }}>
                        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                          <span style={{ fontFamily:"'Figtree',sans-serif", fontSize:15, fontWeight:700, color:'#fff' }}>{env.name}</span>
                          {env.auto_deploy && <span style={{ fontSize:10, padding:'2px 7px', borderRadius:4,
                            background:'rgba(0,229,160,0.1)', color:'#00e5a0', fontFamily:"'IBM Plex Mono',monospace" }}>auto</span>}
                          {env.requires_approval && <span style={{ fontSize:10, padding:'2px 7px', borderRadius:4,
                            background:'rgba(245,197,66,0.1)', color:'#f5c542', fontFamily:"'IBM Plex Mono',monospace" }}>approval</span>}
                          {env.branch_filter && <span style={{ fontSize:10, color:'#545f72', fontFamily:"'IBM Plex Mono',monospace" }}>branch: {env.branch_filter}</span>}
                        </div>
                        <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                          <button onClick={()=>openDeployModal(env.id, env.name)} disabled={isDeploying}
                            style={{ display:'flex', alignItems:'center', gap:6, padding:'6px 14px',
                              background: isDeploying?'rgba(0,212,255,0.05)':'rgba(0,212,255,0.12)',
                              border:`1px solid ${isDeploying?'rgba(0,212,255,0.1)':'rgba(0,212,255,0.3)'}`,
                              borderRadius:6, color:isDeploying?'#545f72':'#00d4ff', cursor:isDeploying?'wait':'pointer',
                              fontFamily:"'Figtree',sans-serif", fontSize:12, fontWeight:600 }}>
                            {isDeploying ? <><Loader2 size={12} style={{animation:'spin 1s linear infinite'}}/> Deploying…</> : <><Rocket size={12}/> Deploy</>}
                          </button>
                          <button onClick={()=>deleteEnv(env.id)} style={{ background:'none', border:'none',
                            cursor:'pointer', color:'#545f72', lineHeight:0 }}
                            onMouseEnter={e=>(e.currentTarget.style.color='#ff4455')}
                            onMouseLeave={e=>(e.currentTarget.style.color='#545f72')}>
                            <Trash2 size={13}/>
                          </button>
                        </div>
                      </div>

                      {/* Currently deployed */}
                      <div style={{ padding:'12px 16px', borderBottom:'1px solid rgba(255,255,255,0.04)',
                        background:'rgba(255,255,255,0.015)' }}>
                        <div style={{ fontSize:10, letterSpacing:'0.08em', color:'#545f72', textTransform:'uppercase',
                          fontFamily:"'IBM Plex Mono',monospace", marginBottom:6 }}>Currently Deployed</div>
                        {deployedBuild && latestDep?.status === 'success' ? (
                          <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                            <span style={{ width:7, height:7, borderRadius:'50%', background:'#00e5a0', flexShrink:0 }}/>
                            <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:'#00e5a0', fontWeight:600 }}>
                              #{deployedBuild.number ?? '?'}
                            </span>
                            <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#545f72' }}>
                              {deployedBuild.commit?.slice(0,7) ?? deployedBuild.commit_sha?.slice(0,7) ?? ''}
                            </span>
                            <span style={{ fontSize:12, color:'#8892a4', fontFamily:"'Figtree',sans-serif",
                              flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                              {deployedBuild.commit_message ?? deployedBuild.commitMsg ?? ''}
                            </span>
                            <span style={{ fontSize:11, color:'#545f72', fontFamily:"'IBM Plex Mono',monospace", flexShrink:0 }}>
                              {timeAgo(latestDep.created_at)}
                            </span>
                          </div>
                        ) : (
                          <div style={{ fontSize:12, color:'#545f72', fontFamily:"'Figtree',sans-serif", fontStyle:'italic' }}>
                            {latestDep ? `Last deploy: ${latestDep.status}` : 'Nothing deployed yet'}
                          </div>
                        )}
                      </div>

                      {/* Deployment history */}
                      {envDeps.length > 0 && (
                        <div style={{ padding:'10px 16px' }}>
                          <div style={{ fontSize:10, letterSpacing:'0.08em', color:'#545f72', textTransform:'uppercase',
                            fontFamily:"'IBM Plex Mono',monospace", marginBottom:8 }}>Deployment History</div>
                          <div style={{ display:'flex', flexDirection:'column', gap:4 }}>
                            {envDeps.map((d,i)=>{
                              const b = projBuilds.find(b=>b.id===d.build_id);
                              const statusColor = d.status==='success'?'#00e5a0':d.status==='running'?'#00d4ff':d.status==='pending'?'#f5c542':'#ff4455';
                              return (
                                <div key={d.id}
                                  onClick={b ? ()=>{ setView('builds'); setSelBuild(b); } : undefined}
                                  style={{ display:'flex', alignItems:'center', gap:10,
                                  padding:'6px 8px', borderRadius:5, cursor: b ? 'pointer' : 'default',
                                  background: i===0 ? 'rgba(255,255,255,0.025)' : 'transparent',
                                  transition:'background 0.12s' }}
                                  onMouseEnter={b?e=>(e.currentTarget.style.background='rgba(255,255,255,0.04)'):undefined}
                                  onMouseLeave={b?e=>(e.currentTarget.style.background=i===0?'rgba(255,255,255,0.025)':'transparent'):undefined}>
                                  <span style={{ width:6, height:6, borderRadius:'50%', background:statusColor, flexShrink:0 }}/>
                                  <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:statusColor, width:52, flexShrink:0 }}>{d.status}</span>
                                  {b && <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#545f72', width:52, flexShrink:0 }}>
                                    build #{b.number ?? '?'}
                                  </span>}
                                  {b && <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#545f72', width:52, flexShrink:0 }}>
                                    {(b.commit??b.commit_sha??'').slice(0,7)}
                                  </span>}
                                  {b && <span style={{ fontSize:11, color:'#8892a4', fontFamily:"'Figtree',sans-serif",
                                    flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                                    {b.commit_message ?? b.commitMsg ?? ''}
                                  </span>}
                                  <span style={{ fontSize:10, color:'#545f72', fontFamily:"'IBM Plex Mono',monospace", flexShrink:0 }}>
                                    {timeAgo(d.created_at)}
                                  </span>
                                  {d.status==='pending' && (
                                    <button onClick={async ()=>{
                                      await fetch(`http://localhost:8080/api/v1/deployments/${d.id}/approve`,{method:'POST'});
                                      setTimeout(()=>fetch(`http://localhost:8080/api/v1/projects/${sel!.id}/deployments`).then(r=>r.json()).then(d=>setDeployments(Array.isArray(d)?d:[])).catch(()=>{}), 3200);
                                    }} style={{ padding:'3px 10px', background:'rgba(245,197,66,0.12)',
                                      border:'1px solid rgba(245,197,66,0.3)', borderRadius:5,
                                      color:'#f5c542', cursor:'pointer', fontSize:11,
                                      fontFamily:"'Figtree',sans-serif", flexShrink:0 }}>
                                      Approve
                                    </button>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </Card>
                  );
                })}
              </div>

              {/* Deploy chain legend */}
              {envs.length >= 2 && (
                <div style={{ marginTop:20, padding:'12px 16px', background:'rgba(0,212,255,0.04)',
                  border:'1px solid rgba(0,212,255,0.1)', borderRadius:8,
                  fontFamily:"'Figtree',sans-serif", fontSize:12, color:'#545f72' }}>
                  <span style={{ color:'#00d4ff', fontWeight:600 }}>Deploy Chain: </span>
                  {envs.map((e,i)=>(
                    <span key={e.id}>
                      <span style={{ color: e.requires_approval ? '#f5c542' : '#00e5a0' }}>{e.name}</span>
                      {i < envs.length-1 && <span style={{ color:'#545f72' }}> → </span>}
                    </span>
                  ))}
                  <span style={{ marginLeft:8, color:'#545f72' }}> · <span style={{ color:'#00e5a0' }}>green</span> = auto · <span style={{ color:'#f5c542' }}>yellow</span> = needs approval</span>
                </div>
              )}
            </div>
          )}

          {/* ── NOTIFICATIONS ─────────────────────────────────────────── */}
          {tab==='notifications' && (
            <div style={{ maxWidth:680 }}>
              <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
                <SectionLabel>Notification Channels</SectionLabel>
                <button onClick={()=>setShowAddCh(s=>!s)} style={{ display:'flex', alignItems:'center', gap:6,
                  padding:'6px 14px', background:'rgba(245,197,66,0.08)', border:'1px solid rgba(245,197,66,0.2)',
                  borderRadius:6, color:'#f5c542', cursor:'pointer', fontSize:12, fontFamily:"'Figtree',sans-serif" }}>
                  <Plus size={12}/> Add Channel
                </button>
              </div>

              {showAddCh && (
                <Card style={{ marginBottom:16 }}>
                  <SectionLabel>New Notification Channel</SectionLabel>
                  {/* platform picker */}
                  <div style={{ display:'grid', gridTemplateColumns:'repeat(3,1fr)', gap:6, marginBottom:14 }}>
                    {PLATFORMS.map(p=>(
                      <button key={p.id} onClick={()=>setChPlatform(p.id)} style={{ padding:'7px 8px', borderRadius:6,
                        cursor:'pointer', textAlign:'left',
                        background: chPlatform===p.id?`${p.color}20`:'transparent',
                        border:`1px solid ${chPlatform===p.id?p.color+'50':'rgba(255,255,255,0.08)'}` }}>
                        <div style={{ fontSize:12, fontWeight:600, fontFamily:"'Figtree',sans-serif",
                          color: chPlatform===p.id?p.color:'#8892a4' }}>{p.name}</div>
                      </button>
                    ))}
                  </div>
                  <div style={{ fontSize:11, color:'#545f72', marginBottom:12, fontFamily:"'Figtree',sans-serif" }}>{pInfo?.desc}</div>
                  <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:10, marginBottom:12 }}>
                    <Field label="Channel Name">
                      <input style={inputStyle} value={chName} onChange={e=>setChName(e.target.value)} placeholder="#builds"/>
                    </Field>
                    <Field label="Webhook URL">
                      <input type="password" style={monoInput} value={chWebhook} onChange={e=>setChWebhook(e.target.value)} placeholder="https://hooks.slack.com/…"/>
                    </Field>
                  </div>
                  <div style={{ display:'flex', gap:20, flexWrap:'wrap', marginBottom:12 }}>
                    <Toggle checked={chOnSuccess} onChange={setChOnSuccess} label="On success"/>
                    <Toggle checked={chOnFailure} onChange={setChOnFailure} label="On failure"/>
                    <Toggle checked={chOnCancel}  onChange={setChOnCancel}  label="On cancel"/>
                    <Toggle checked={chAiMsg}     onChange={setChAiMsg}     label="AI-written message"/>
                  </div>
                  {/* AI preview */}
                  <div style={{ marginBottom:12 }}>
                    <button onClick={generatePreview} disabled={notifPreviewing} style={{ display:'flex', alignItems:'center', gap:6,
                      padding:'6px 12px', background:'rgba(160,120,255,0.1)', border:'1px solid rgba(160,120,255,0.25)',
                      borderRadius:6, color:'#a078ff', cursor:'pointer', fontSize:12, fontFamily:"'Figtree',sans-serif" }}>
                      {notifPreviewing ? <Loader2 size={12} style={{animation:'spin 1s linear infinite'}}/> : <Sparkles size={12}/>}
                      {notifPreviewing ? 'Generating…' : 'AI Message Preview'}
                    </button>
                    {notifPreview && (
                      <div style={{ marginTop:8, padding:'10px 14px', background:'rgba(255,255,255,0.03)',
                        border:'1px solid rgba(255,255,255,0.08)', borderRadius:6,
                        fontFamily:"'Figtree',sans-serif", fontSize:13, color:'#e8eaf0', whiteSpace:'pre-wrap' }}>
                        {notifPreview}
                      </div>
                    )}
                  </div>
                  <div style={{ display:'flex', gap:8 }}>
                    <button onClick={()=>setShowAddCh(false)} style={{ flex:1, padding:'8px', background:'transparent',
                      border:'1px solid rgba(255,255,255,0.1)', borderRadius:6, color:'#545f72', cursor:'pointer',
                      fontFamily:"'Figtree',sans-serif", fontSize:13 }}>Cancel</button>
                    <button onClick={saveChannel} disabled={chSaving} style={{ flex:2, padding:'8px',
                      background:'#f5c542', border:'none', borderRadius:6, color:'#000', cursor:'pointer',
                      fontFamily:"'Figtree',sans-serif", fontSize:13, fontWeight:700 }}>
                      {chSaving ? 'Saving…' : 'Save Channel'}
                    </button>
                  </div>
                </Card>
              )}

              {channels.length===0 && !showAddCh ? (
                <div style={{ textAlign:'center', padding:'48px 0', color:'#545f72', fontFamily:"'Figtree',sans-serif" }}>
                  <Bell size={30} style={{ opacity:0.3, marginBottom:10 }}/>
                  <div style={{ fontSize:14 }}>No notification channels yet</div>
                  <div style={{ fontSize:12, marginTop:4 }}>Add Slack, Teams, Discord, Jira, or Azure DevOps</div>
                </div>
              ) : (
                <div style={{ display:'flex', flexDirection:'column', gap:8 }}>
                  {channels.map(ch=>{
                    const pDef = PLATFORMS.find(p=>p.id===ch.platform);
                    return (
                      <Card key={ch.id} style={{ padding:'14px 18px' }}>
                        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between' }}>
                          <div style={{ display:'flex', alignItems:'center', gap:12 }}>
                            <div style={{ width:34, height:34, borderRadius:8, background:`${pDef?.color||'#545f72'}20`,
                              display:'flex', alignItems:'center', justifyContent:'center',
                              border:`1px solid ${pDef?.color||'#545f72'}40` }}>
                              <Bell size={14} color={pDef?.color||'#545f72'}/>
                            </div>
                            <div>
                              <div style={{ fontFamily:"'Figtree',sans-serif", fontSize:14, fontWeight:600, color:'#fff' }}>{ch.name}</div>
                              <div style={{ fontSize:11, color:'#545f72', fontFamily:"'IBM Plex Mono',monospace" }}>
                                {ch.platform} · {[ch.on_success&&'✔ success',ch.on_failure&&'✖ fail',ch.ai_message&&'✦ AI'].filter(Boolean).join(' · ')}
                              </div>
                            </div>
                          </div>
                          <div style={{ display:'flex', alignItems:'center', gap:8 }}>
                            <span style={{ width:7, height:7, borderRadius:'50%',
                              background: ch.enabled?'#00e5a0':'#545f72', display:'inline-block' }}/>
                            <button onClick={()=>deleteChannel(ch.id)} style={{ background:'none', border:'none',
                              cursor:'pointer', color:'#545f72', lineHeight:0 }}
                              onMouseEnter={e=>(e.currentTarget.style.color='#ff4455')}
                              onMouseLeave={e=>(e.currentTarget.style.color='#545f72')}>
                              <Trash2 size={13}/>
                            </button>
                          </div>
                        </div>
                      </Card>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Deploy version picker modal */}
        {deployTarget && (() => {
          const successBuilds = projBuilds.filter(b=>b.status==='success');
          const envForModal = envs.find(e=>e.id===deployTarget.envId);
          const currentDep = deployments.find(d=>d.environment_id===deployTarget.envId && d.status==='success');
          const currentBuild = currentDep ? projBuilds.find(b=>b.id===currentDep.build_id) : null;
          return (
          <div style={{ position:'fixed', inset:0, zIndex:200, display:'flex', alignItems:'center',
            justifyContent:'center', background:'rgba(0,0,0,0.7)', backdropFilter:'blur(6px)' }}
            onClick={()=>setDeployTarget(null)}>
            <div style={{ width:520, background:'#0d1117', border:'1px solid rgba(255,255,255,0.14)',
              borderRadius:12, padding:24, boxShadow:'0 32px 80px rgba(0,0,0,0.7)', maxHeight:'85vh', display:'flex', flexDirection:'column' }}
              onClick={e=>e.stopPropagation()}>

              {/* Header */}
              <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:16 }}>
                <div>
                  <h3 style={{ fontFamily:"'Figtree',sans-serif", fontSize:17, fontWeight:700, color:'#fff', margin:'0 0 4px' }}>
                    Deploy to <span style={{ color: envForModal?.color||'#00d4ff' }}>{deployTarget.envName}</span>
                  </h3>
                  {currentBuild ? (
                    <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#545f72' }}>
                      Currently running: build #{currentBuild.number} · {(currentBuild.commit??currentBuild.commit_sha??'').slice(0,7)}
                    </div>
                  ) : (
                    <div style={{ fontFamily:"'Figtree',sans-serif", fontSize:12, color:'#545f72' }}>Nothing deployed yet</div>
                  )}
                </div>
                <button onClick={()=>setDeployTarget(null)} style={{ background:'none', border:'none',
                  cursor:'pointer', color:'#545f72', lineHeight:0 }}><X size={15}/></button>
              </div>

              {/* Build list */}
              <div style={{ fontSize:10, letterSpacing:'0.08em', color:'#545f72', textTransform:'uppercase',
                fontFamily:"'IBM Plex Mono',monospace", marginBottom:8 }}>Select Build to Deploy</div>

              {successBuilds.length === 0 ? (
                <div style={{ padding:'20px', textAlign:'center', color:'#545f72',
                  fontFamily:"'Figtree',sans-serif", fontSize:13, fontStyle:'italic' }}>
                  No successful builds yet — run a build first
                </div>
              ) : (
                <div style={{ overflowY:'auto', display:'flex', flexDirection:'column', gap:4, flex:1, minHeight:0 }}>
                  {successBuilds.map(b=>{
                    const bid = b.id;
                    const isSelected = pickedVersion === bid;
                    const isCurrent = currentBuild?.id === bid;
                    const sha = (b.commit??b.commit_sha??'').slice(0,7);
                    const msg = b.commit_message ?? b.commitMsg ?? '';
                    return (
                      <div key={bid} onClick={()=>setPickedVersion(bid)}
                        style={{ display:'flex', alignItems:'center', gap:10, padding:'10px 12px',
                          borderRadius:7, cursor:'pointer',
                          background: isSelected ? 'rgba(0,212,255,0.06)' : 'rgba(255,255,255,0.02)',
                          border:`1px solid ${isSelected ? 'rgba(0,212,255,0.3)' : 'rgba(255,255,255,0.07)'}` }}>
                        <div style={{ width:11, height:11, borderRadius:'50%', border:'2px solid', flexShrink:0,
                          borderColor: isSelected ? '#00d4ff' : '#545f72',
                          background: isSelected ? '#00d4ff' : 'transparent' }}/>
                        <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:'#00d4ff', fontWeight:700, width:52, flexShrink:0 }}>
                          #{b.number}
                        </span>
                        <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#545f72', width:48, flexShrink:0 }}>
                          {sha}
                        </span>
                        <span style={{ fontSize:12, color: isSelected?'#fff':'#8892a4', fontFamily:"'Figtree',sans-serif",
                          flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
                          {msg || b.branch}
                        </span>
                        <span style={{ fontSize:10, color:'#545f72', fontFamily:"'IBM Plex Mono',monospace", flexShrink:0 }}>
                          {timeAgo(b.created_at)}
                        </span>
                        {isCurrent && <span style={{ fontSize:10, padding:'2px 6px', borderRadius:4, flexShrink:0,
                          background:'rgba(0,229,160,0.1)', color:'#00e5a0',
                          fontFamily:"'IBM Plex Mono',monospace" }}>live</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              <div style={{ display:'flex', gap:10, marginTop:16 }}>
                <button onClick={()=>setDeployTarget(null)} style={{ flex:1, padding:'10px',
                  background:'transparent', border:'1px solid rgba(255,255,255,0.12)',
                  borderRadius:7, color:'#8892a4', cursor:'pointer', fontFamily:"'Figtree',sans-serif", fontSize:13 }}>
                  Cancel
                </button>
                <button onClick={confirmDeploy} disabled={!pickedVersion || successBuilds.length===0}
                  style={{ flex:2, padding:'10px', display:'flex', alignItems:'center', justifyContent:'center', gap:8,
                  background: (!pickedVersion || successBuilds.length===0) ? 'rgba(0,212,255,0.2)' : '#00d4ff',
                  border:'none', borderRadius:7, color:'#000', fontFamily:"'Figtree',sans-serif", fontSize:13, fontWeight:700,
                  cursor: (!pickedVersion || successBuilds.length===0) ? 'not-allowed' : 'pointer' }}>
                  <Rocket size={13}/>
                  {pickedVersion && successBuilds.find(b=>b.id===pickedVersion)
                    ? `Deploy Build #${successBuilds.find(b=>b.id===pickedVersion)!.number}`
                    : 'Select a build'}
                </button>
              </div>
            </div>
          </div>
          );
        })()}
      </div>
    );
  };

  /* ── secrets ──────────────────────────────────────────────────────────────── */
  const Secrets = () => {
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

    useEffect(()=>{
      if(!sel) return;
      fetch(`http://localhost:8080/api/v1/projects/${sel.id}/secrets`)
        .then(r=>r.json()).then(d=>setList(Array.isArray(d)?d:[])).catch(()=>{});
    },[sel?.id]);

    return (
      <div style={{ padding:28, maxWidth:640 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
          <h2 style={{ fontFamily:"'Figtree',sans-serif", fontSize:22, fontWeight:800,
            color:'#fff', letterSpacing:'-0.03em', margin:0 }}>Secrets</h2>
          <button onClick={()=>setAdding(true)} style={{ display:'flex', alignItems:'center', gap:7,
            padding:'9px 16px', background:'rgba(0,212,255,0.08)', border:'1px solid rgba(0,212,255,0.2)',
            borderRadius:7, color:'#00d4ff', cursor:'pointer', fontFamily:"'Figtree',sans-serif", fontSize:13, fontWeight:600 }}>
            <Plus size={14}/> Add Secret
          </button>
        </div>
        {adding && (
          <Card style={{ marginBottom:14 }}>
            <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
              letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:14 }}>New Secret</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 2fr', gap:10, marginBottom:14 }}>
              <div>
                <div style={{ fontSize:12, color:'#545f72', marginBottom:5, fontFamily:"'Figtree',sans-serif" }}>Key</div>
                <input ref={keyRef} value={newKey} onChange={e=>setNewKey(e.target.value)} placeholder="API_KEY"
                  style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                    borderRadius:6, padding:'9px 12px', color:'#e8eaf0',
                    fontFamily:"'IBM Plex Mono',monospace", fontSize:12, outline:'none' }}/>
              </div>
              <div>
                <div style={{ fontSize:12, color:'#545f72', marginBottom:5, fontFamily:"'Figtree',sans-serif" }}>Value</div>
                <input type="password" value={newVal} onChange={e=>setNewVal(e.target.value)} placeholder="sk-…"
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

  /* ── settings ─────────────────────────────────────────────────────────────── */
  const SettingsView = () => {
    const [name,   setName]   = useState(sel?.name     ?? '');
    const [repo,   setRepo]   = useState(sel?.repo_url ?? '');
    const [branch, setBranch] = useState(sel?.branch   ?? 'main');
    const [saved,  setSaved]  = useState(false);
    const [confirmDel, setConfirmDel] = useState(false);
    const [maxBuilds, setMaxBuilds] = useState('50');
    const [maxVersions, setMaxVersions] = useState('30');
    const [retSaved, setRetSaved] = useState(false);

    useEffect(() => {
      fetch('http://localhost:8080/api/v1/settings/retention')
        .then(r=>r.json())
        .then(d=>{ setMaxBuilds(d.max_builds||'50'); setMaxVersions(d.max_versions||'30'); })
        .catch(()=>{});
    }, []);

    const save = () => {
      if(!sel) return;
      api.updateProject(sel.id, { name, repo_url: repo, branch } as any).catch(()=>{});
      setProjects(p=>p.map(x=>x.id===sel.id?{...x,name,repo_url:repo,branch}:x));
      setSel(s=>s?{...s,name,repo_url:repo,branch}:s);
      setSaved(true); setTimeout(()=>setSaved(false),2000);
    };

    const saveRetention = () => {
      fetch('http://localhost:8080/api/v1/settings/retention', {
        method:'PUT', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ max_builds: maxBuilds, max_versions: maxVersions })
      }).then(()=>{ setRetSaved(true); setTimeout(()=>setRetSaved(false),2000); }).catch(()=>{});
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
        <Card style={{ marginBottom:12 }}>
          <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
            letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:18 }}>Retention</div>
          <p style={{ fontSize:13, color:'#8892a4', marginBottom:16, lineHeight:1.6,
            fontFamily:"'Figtree',sans-serif" }}>
            Control how many builds and versions are kept per project. Older items are automatically pruned after each build.
          </p>
          <div style={{ display:'flex', gap:16, marginBottom:16 }}>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:12, color:'#545f72', marginBottom:5, fontFamily:"'Figtree',sans-serif" }}>Max Builds per Project</div>
              <input type="number" min="5" max="500" value={maxBuilds} onChange={e=>setMaxBuilds(e.target.value)}
                style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                  borderRadius:6, padding:'9px 12px', color:'#e8eaf0',
                  fontFamily:"'IBM Plex Mono',monospace", fontSize:13, outline:'none' }}/>
            </div>
            <div style={{ flex:1 }}>
              <div style={{ fontSize:12, color:'#545f72', marginBottom:5, fontFamily:"'Figtree',sans-serif" }}>Max Versions per Project</div>
              <input type="number" min="5" max="200" value={maxVersions} onChange={e=>setMaxVersions(e.target.value)}
                style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                  borderRadius:6, padding:'9px 12px', color:'#e8eaf0',
                  fontFamily:"'IBM Plex Mono',monospace", fontSize:13, outline:'none' }}/>
            </div>
          </div>
          <button onClick={saveRetention} style={{ padding:'9px 20px',
            background:retSaved?'#00e5a0':'#00d4ff', color:'#000', border:'none',
            borderRadius:7, fontWeight:700, fontSize:13, cursor:'pointer',
            fontFamily:"'Figtree',sans-serif", transition:'background 0.2s' }}>
            {retSaved ? '✔ Saved' : 'Save Retention'}
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
  const AiPanel = () => {
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
              <button key={s} onClick={()=>{ setMsgs(m=>[...m,{role:'user',content:s}]); }}
                style={{ padding:'8px 12px', background:'rgba(255,255,255,0.03)',
                  border:'1px solid rgba(255,255,255,0.08)', borderRadius:7,
                  color:'#8892a4', cursor:'pointer', textAlign:'left',
                  fontSize:12, fontFamily:"'Figtree',sans-serif" }}>
                {s}
              </button>
            ))}
          </div>
        )}

        <div style={{ flex:1, overflowY:'auto', padding:'16px 20px', display:'flex', flexDirection:'column', gap:12 }}>
          {msgs.map((m,i)=>(
            <div key={i} style={{ display:'flex', flexDirection:'column',
              alignItems: m.role==='user' ? 'flex-end' : 'flex-start' }}>
              <div style={{
                maxWidth:'85%', padding:'10px 14px', borderRadius: m.role==='user' ? '12px 12px 2px 12px' : '12px 12px 12px 2px',
                background: m.role==='user' ? 'rgba(0,212,255,0.12)' : 'rgba(255,255,255,0.05)',
                border: `1px solid ${m.role==='user' ? 'rgba(0,212,255,0.2)' : 'rgba(255,255,255,0.08)'}`,
                color:'#e8eaf0', fontSize:13, lineHeight:1.65, fontFamily:"'Figtree',sans-serif",
                whiteSpace:'pre-wrap' }}>
                {m.content}
              </div>
            </div>
          ))}
          {loading && (
            <div style={{ display:'flex', alignItems:'flex-start' }}>
              <div style={{ padding:'10px 14px', borderRadius:'12px 12px 12px 2px',
                background:'rgba(255,255,255,0.05)', border:'1px solid rgba(255,255,255,0.08)',
                display:'flex', gap:4, alignItems:'center' }}>
                {[0,1,2].map(i=>(
                  <span key={i} style={{ width:6, height:6, borderRadius:'50%', background:'#545f72',
                    display:'inline-block', animation:`blink 1.2s ease-in-out ${i*0.2}s infinite` }}/>
                ))}
              </div>
            </div>
          )}
          <div ref={chatEnd}/>
        </div>

        <div style={{ padding:'12px 16px', borderTop:'1px solid rgba(255,255,255,0.07)',
          display:'flex', gap:8, alignItems:'center' }}>
          <input ref={inputRef} value={localInput} onChange={e=>setLocalInput(e.target.value)}
            onKeyDown={e=>{ if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send();} }}
            placeholder="Ask anything about your pipeline…"
            style={{ flex:1, background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
              borderRadius:8, padding:'10px 14px', color:'#e8eaf0', outline:'none',
              fontSize:13, fontFamily:"'Figtree',sans-serif" }}/>
          <button onClick={send} disabled={loading} style={{ width:36, height:36,
            background: loading?'#111620':'#00d4ff', color: loading?'#545f72':'#000',
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
  const CmdPalette = () => {
    const cmds = [
      { label:'Connect Repository',  icon:<Plus size={14}/>,      fn:()=>{setAddProj(true);setCmdOpen(false);} },
      { label:'Run Build',           icon:<Play size={14}/>,      fn:()=>{if(sel){triggerBuild();}setCmdOpen(false);} },
      { label:'Open Callahan AI',    icon:<Sparkles size={14}/>,  fn:()=>{setAiOpen(true);setCmdOpen(false);} },
      { label:'View Builds',         icon:<Zap size={14}/>,       fn:()=>{setView('builds');setCmdOpen(false);} },
      { label:'Configure Pipeline',  icon:<FileCode size={14}/>,  fn:()=>{setView('pipeline');setCmdOpen(false);} },
      { label:'Version History',     icon:<Tag size={14}/>,       fn:()=>{setView('versions');setCmdOpen(false);} },
      { label:'Manage Secrets',      icon:<Lock size={14}/>,      fn:()=>{setView('secrets');setCmdOpen(false);} },
      { label:'Settings',            icon:<Settings size={14}/>,  fn:()=>{setView('settings');setCmdOpen(false);} },
      { label:'Configure AI / LLM',  icon:<Sparkles size={14}/>,  fn:()=>{setView('llm-config');setCmdOpen(false);} },
    ].filter(c=>!cmdQ||c.label.toLowerCase().includes(cmdQ.toLowerCase()));

    return (
      <div style={{ position:'fixed', inset:0, zIndex:200, display:'flex', alignItems:'flex-start',
        justifyContent:'center', paddingTop:120, background:'rgba(0,0,0,0.6)', backdropFilter:'blur(8px)' }}
        onClick={()=>setCmdOpen(false)}>
        <div style={{ width:520, background:'#0d1117', border:'1px solid rgba(255,255,255,0.15)',
          borderRadius:12, boxShadow:'0 32px 80px rgba(0,0,0,0.7)', overflow:'hidden' }}
          onClick={e=>e.stopPropagation()}>
          <div style={{ display:'flex', alignItems:'center', gap:10, padding:'14px 16px',
            borderBottom:'1px solid rgba(255,255,255,0.08)' }}>
            <Search size={15} style={{ color:'#545f72', flexShrink:0 }}/>
            <input ref={cmdRef} value={cmdQ} onChange={e=>setCmdQ(e.target.value)}
              onKeyDown={e=>{ if(e.key==='Escape'){setCmdOpen(false);} if(e.key==='Enter'&&cmds.length>0){cmds[0].fn();} }}
              placeholder="Type a command…"
              style={{ flex:1, background:'none', border:'none', outline:'none',
                color:'#e8eaf0', fontSize:14, fontFamily:"'Figtree',sans-serif" }}/>
            <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
              background:'#111620', padding:'2px 7px', borderRadius:3 }}>ESC</span>
          </div>
          <div style={{ padding:'8px 8px', maxHeight:320, overflowY:'auto' }}>
            {cmds.map((c,i)=>(
              <button key={i} onClick={c.fn} style={{ display:'flex', alignItems:'center', gap:10,
                width:'100%', padding:'10px 12px', background:'none',
                border:'1px solid transparent', borderRadius:7, cursor:'pointer', textAlign:'left',
                color:'#e8eaf0', fontSize:13, fontFamily:"'Figtree',sans-serif" }}
                onMouseEnter={e=>{ e.currentTarget.style.background='rgba(255,255,255,0.04)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.08)'; }}
                onMouseLeave={e=>{ e.currentTarget.style.background='none'; e.currentTarget.style.borderColor='transparent'; }}>
                <span style={{ color:'#545f72' }}>{c.icon}</span>{c.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  };

  /* ── Versions View (read-only timeline) ──────────────────────────────────── */
  const VersionsView = () => {
    const [versions, setVersions] = useState<any[]>([]);
    const [showManual, setShowManual] = useState(false);
    const [bumpType, setBumpType] = useState('patch');
    const [changelog, setChangelog] = useState('');
    const [aiAdvice, setAiAdvice] = useState<{bump:string;reason:string}|null>(null);
    const [advising, setAdvising] = useState(false);

    useEffect(() => {
      if (!sel) return;
      fetch(`http://localhost:8080/api/v1/projects/${sel.id}/versions`).then(r=>r.json()).then(d=>setVersions(Array.isArray(d)?d:[])).catch(()=>{});
    }, [sel?.id]);

    const askAI = async () => {
      if(!sel) return;
      setAdvising(true);
      try {
        const r = await fetch('http://localhost:8080/api/v1/ai/version-bump', {
          method:'POST', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ project_id:sel.id, commits:[], changelog })
        });
        if(r.ok){ const d=await r.json(); setAiAdvice(d); setBumpType(d.bump||'patch'); }
      } catch{}
      setAdvising(false);
    };

    const createVersion = async () => {
      if(!sel||builds.length===0) return;
      const r = await fetch(`http://localhost:8080/api/v1/projects/${sel.id}/versions`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ build_id:builds[0].id, bump_type:bumpType, changelog })
      });
      if(r.ok){ const d=await r.json(); setVersions(v=>[d,...v]); setShowManual(false); }
    };

    const BUMP_COLORS: Record<string,string> = { major:'#ff4455', minor:'#f5c542', patch:'#00e5a0' };

    return (
      <div style={{ padding:28, maxWidth:720 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
          <div>
            <h2 style={{ fontFamily:"'Figtree',sans-serif", fontSize:22, fontWeight:800, color:'#fff', letterSpacing:'-0.03em', margin:0 }}>Version History</h2>
            <p style={{ color:'#545f72', fontSize:13, fontFamily:"'Figtree',sans-serif", margin:'4px 0 0' }}>Semantic versions auto-created on every successful build</p>
          </div>
          <button onClick={()=>setShowManual(s=>!s)} style={{ display:'flex', alignItems:'center', gap:7,
            padding:'9px 16px', background:'rgba(160,120,255,0.1)', border:'1px solid rgba(160,120,255,0.25)',
            borderRadius:7, color:'#a078ff', cursor:'pointer', fontFamily:"'Figtree',sans-serif", fontSize:13, fontWeight:600 }}>
            <Tag size={14}/> Manual Version
          </button>
        </div>

        {showManual && (
          <Card style={{ marginBottom:20 }}>
            <div style={{ fontSize:10, color:'#545f72', letterSpacing:'0.1em', textTransform:'uppercase', fontFamily:"'IBM Plex Mono',monospace", marginBottom:16 }}>Create Version</div>
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:11, color:'#545f72', marginBottom:8, fontFamily:"'Figtree',sans-serif" }}>Bump Type</div>
              <div style={{ display:'flex', gap:8 }}>
                {['patch','minor','major'].map(t=>(
                  <button key={t} onClick={()=>setBumpType(t)} style={{ flex:1, padding:'8px', borderRadius:6, cursor:'pointer',
                    background: bumpType===t?`${BUMP_COLORS[t]}15`:'transparent',
                    border:`1px solid ${bumpType===t?BUMP_COLORS[t]+'50':'rgba(255,255,255,0.08)'}`,
                    color: bumpType===t?BUMP_COLORS[t]:'#545f72', fontFamily:"'Figtree',sans-serif", fontSize:13, fontWeight:600 }}>
                    {t}
                  </button>
                ))}
              </div>
            </div>
            <div style={{ marginBottom:14 }}>
              <div style={{ fontSize:11, color:'#545f72', marginBottom:5, fontFamily:"'Figtree',sans-serif" }}>Changelog (optional)</div>
              <textarea value={changelog} onChange={e=>setChangelog(e.target.value)} rows={4} placeholder="## Changes&#10;- Fixed login bug&#10;- Added dark mode"
                style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.1)', borderRadius:6,
                  padding:'8px 12px', color:'#e8eaf0', fontFamily:"'IBM Plex Mono',monospace", fontSize:12, outline:'none', resize:'vertical' }}/>
            </div>
            <div style={{ marginBottom:14 }}>
              <button onClick={askAI} disabled={advising} style={{ padding:'6px 14px',
                background:'rgba(160,120,255,0.1)', border:'1px solid rgba(160,120,255,0.25)',
                borderRadius:6, color:'#a078ff', cursor:'pointer', fontSize:12, fontFamily:"'Figtree',sans-serif",
                display:'flex', alignItems:'center', gap:6 }}>
                {advising ? <Loader2 size={12} style={{animation:'spin 1s linear infinite'}}/> : <Sparkles size={12}/>}
                {advising ? 'Analyzing…' : 'Ask AI: What should we bump?'}
              </button>
              {aiAdvice && (
                <div style={{ marginTop:8, padding:'10px 14px', background:`${BUMP_COLORS[aiAdvice.bump]}10`,
                  border:`1px solid ${BUMP_COLORS[aiAdvice.bump]}30`, borderRadius:6 }}>
                  <div style={{ fontFamily:"'Figtree',sans-serif", fontSize:13, fontWeight:600, color:BUMP_COLORS[aiAdvice.bump], marginBottom:4 }}>
                    ✦ AI recommends: {aiAdvice.bump} bump
                  </div>
                  <div style={{ fontSize:12, color:'#8892a4', fontFamily:"'Figtree',sans-serif" }}>{aiAdvice.reason}</div>
                </div>
              )}
            </div>
            <div style={{ display:'flex', gap:8 }}>
              <button onClick={()=>setShowManual(false)} style={{ flex:1, padding:'8px', background:'transparent', border:'1px solid rgba(255,255,255,0.1)', borderRadius:6, color:'#545f72', cursor:'pointer', fontFamily:"'Figtree',sans-serif", fontSize:13 }}>Cancel</button>
              <button onClick={createVersion} disabled={builds.length===0} style={{ flex:2, padding:'8px', background:'#a078ff', border:'none', borderRadius:6, color:'#fff', cursor:'pointer', fontFamily:"'Figtree',sans-serif", fontSize:13, fontWeight:700 }}>
                Create {bumpType} version
              </button>
            </div>
          </Card>
        )}

        {versions.length === 0 ? (
          <div style={{ textAlign:'center', padding:'48px 0', color:'#545f72', fontFamily:"'Figtree',sans-serif" }}>
            <Tag size={32} style={{ opacity:0.3, marginBottom:12 }}/>
            <div style={{ fontSize:14 }}>No versions yet</div>
            <div style={{ fontSize:12, marginTop:4 }}>Versions are auto-created after every successful build</div>
          </div>
        ) : (
          <div style={{ position:'relative' }}>
            <div style={{ position:'absolute', left:15, top:0, bottom:0, width:1, background:'rgba(255,255,255,0.07)' }}/>
            {versions.map((v)=>(
              <div key={v.id} style={{ display:'flex', gap:16, marginBottom:16 }}>
                <div style={{ width:30, height:30, borderRadius:'50%', background:`${BUMP_COLORS[v.bump_type]||'#545f72'}20`,
                  border:`2px solid ${BUMP_COLORS[v.bump_type]||'#545f72'}`,
                  display:'flex', alignItems:'center', justifyContent:'center', flexShrink:0, zIndex:1 }}>
                  <Tag size={12} color={BUMP_COLORS[v.bump_type]||'#545f72'}/>
                </div>
                <Card style={{ flex:1, borderLeft:`3px solid ${BUMP_COLORS[v.bump_type]||'#545f72'}` }}>
                  <div style={{ display:'flex', alignItems:'flex-start', justifyContent:'space-between', marginBottom:6 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:10 }}>
                      <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:16, fontWeight:700, color:'#fff' }}>{v.tag}</span>
                      <span style={{ fontSize:10, padding:'2px 8px', borderRadius:4,
                        background:`${BUMP_COLORS[v.bump_type]||'#545f72'}20`,
                        color:BUMP_COLORS[v.bump_type]||'#545f72',
                        fontFamily:"'IBM Plex Mono',monospace", fontWeight:600 }}>{v.bump_type}</span>
                      {v.build_id && (() => { const bNum = projBuilds.find((b:any)=>b.id===v.build_id)?.number; return bNum ? (
                        <span style={{ fontSize:10, color:'#545f72', fontFamily:"'IBM Plex Mono',monospace" }}>build #{bNum}</span>
                      ) : null; })()}
                      {v.git_tagged && <span style={{ fontSize:10, color:'#00e5a0', fontFamily:"'IBM Plex Mono',monospace" }}>⬧ git tagged</span>}
                    </div>
                    <span style={{ fontSize:11, color:'#545f72', fontFamily:"'IBM Plex Mono',monospace" }}>
                      {new Date(v.created_at).toLocaleDateString()}
                    </span>
                  </div>
                  {v.bump_reason && <div style={{ fontSize:12, color:'#8892a4', fontFamily:"'Figtree',sans-serif", marginBottom:6 }}>{v.bump_reason}</div>}
                  {v.changelog && (
                    <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11, color:'#545f72',
                      background:'rgba(255,255,255,0.02)', borderRadius:5, padding:'8px 10px', whiteSpace:'pre-wrap' }}>
                      {v.changelog.slice(0,200)}{v.changelog.length>200?'…':''}
                    </div>
                  )}
                </Card>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  /* ── LLM config ───────────────────────────────────────────────────────────── */
  const LLMConfigView = () => {
    const PROVIDERS = [
      { id:'groq',      name:'Groq',      color:'#f55036', models:['llama-3.3-70b-versatile','llama-3.1-8b-instant','mixtral-8x7b-32768'] },
      { id:'openai',    name:'OpenAI',    color:'#10a37f', models:['gpt-4o','gpt-4o-mini','gpt-4-turbo','gpt-3.5-turbo'] },
      { id:'anthropic', name:'Anthropic', color:'#d97757', models:['claude-opus-4-5','claude-sonnet-4-5','claude-haiku-4-5'] },
      { id:'ollama',    name:'Ollama',    color:'#888',    models:['llama3','codellama','mistral','deepseek-coder'] },
    ];
    const [provider, setProvider] = useState('groq');
    const [model,    setModel]    = useState('llama-3.3-70b-versatile');
    const [apiKey,   setApiKey]   = useState('');
    const [ollamaURL,setOllamaURL]= useState('http://localhost:11434');
    const [showKey,  setShowKey]  = useState(false);
    const [saving,   setSaving]   = useState(false);
    const [testing,  setTesting]  = useState(false);
    const [status,   setStatus]   = useState<{ok:boolean;msg:string}|null>(null);

    useEffect(() => {
      fetch('http://localhost:8080/api/v1/settings/llm').then(r=>r.json()).then(d=>{
        if(d.provider) setProvider(d.provider);
        if(d.model) setModel(d.model);
        if(d.ollama_url) setOllamaURL(d.ollama_url);
      }).catch(()=>{});
    },[]);

    const prov = PROVIDERS.find(p=>p.id===provider);

    const save = async () => {
      setSaving(true);
      try {
        await fetch('http://localhost:8080/api/v1/settings/llm', {
          method:'PUT', headers:{'Content-Type':'application/json'},
          body: JSON.stringify({ provider, model, api_key:apiKey, ollama_url:ollamaURL })
        });
        setStatus({ok:true, msg:'Configuration saved successfully.'});
      } catch { setStatus({ok:false,msg:'Failed to save — is the backend running?'}); }
      setSaving(false);
      setTimeout(()=>setStatus(null),3000);
    };

    const testConnection = async () => {
      setTesting(true); setStatus(null);
      try {
        const r = await fetch('http://localhost:8080/api/v1/settings/llm/test', { method:'POST' });
        const d = await r.json();
        setStatus(d.ok ? {ok:true,msg:`Connected — ${d.model||model}`} : {ok:false,msg:d.error||'Connection failed'});
      } catch { setStatus({ok:false,msg:'Backend offline'}); }
      setTesting(false);
    };

    return (
      <div style={{ padding:28, maxWidth:640 }}>
        <h2 style={{ fontFamily:"'Figtree',sans-serif", fontSize:22, fontWeight:800,
          color:'#fff', letterSpacing:'-0.03em', marginBottom:24 }}>Configure AI / LLM</h2>

        {/* Provider picker */}
        <Card style={{ marginBottom:14 }}>
          <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
            letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:16 }}>Provider</div>
          <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:8, marginBottom:20 }}>
            {PROVIDERS.map(p=>(
              <button key={p.id} onClick={()=>{ setProvider(p.id); setModel(p.models[0]); }}
                style={{ padding:'10px 8px', borderRadius:8, cursor:'pointer', textAlign:'center',
                  background: provider===p.id?`${p.color}15`:'transparent',
                  border:`1px solid ${provider===p.id?p.color+'50':'rgba(255,255,255,0.1)'}`,
                  display:'flex', flexDirection:'column', alignItems:'center', gap:4 }}>
                <div style={{ fontSize:13, fontWeight:600, fontFamily:"'Figtree',sans-serif",
                  color: provider===p.id?p.color:'#8892a4' }}>{p.name}</div>
              </button>
            ))}
          </div>

          {/* Model picker */}
          <div style={{ marginBottom:16 }}>
            <div style={{ fontSize:10, color:'#545f72', letterSpacing:'0.1em', textTransform:'uppercase',
              fontFamily:"'IBM Plex Mono',monospace", marginBottom:10 }}>Model</div>
            <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
              {prov?.models.map(m=>(
                <button key={m} onClick={()=>setModel(m)} style={{ padding:'6px 12px', borderRadius:6,
                  cursor:'pointer', background: model===m?`${prov.color}15`:'transparent',
                  border:`1px solid ${model===m?prov.color+'50':'rgba(255,255,255,0.1)'}`,
                  color: model===m?prov.color:'#545f72',
                  fontFamily:"'IBM Plex Mono',monospace", fontSize:11 }}>{m}</button>
              ))}
            </div>
          </div>

          {/* API key / Ollama URL */}
          {provider==='ollama' ? (<>
            <div style={{ fontSize:10, color:'#545f72', letterSpacing:'0.1em', textTransform:'uppercase',
              fontFamily:"'IBM Plex Mono',monospace", marginBottom:8 }}>Ollama URL</div>
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

        {status && (
          <div style={{ marginBottom:14, padding:'12px 16px', borderRadius:8,
            background: status.ok ? 'rgba(0,229,160,0.08)' : 'rgba(255,68,85,0.08)',
            border: `1px solid ${status.ok ? 'rgba(0,229,160,0.2)' : 'rgba(255,68,85,0.2)'}`,
            fontFamily:"'Figtree',sans-serif", fontSize:13,
            color: status.ok ? '#00e5a0' : '#ff4455' }}>
            {status.msg}
          </div>
        )}

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

  /* ── add project modal ────────────────────────────────────────────────────── */
  const AddProject = () => {
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
        provider:'github', branch: branch||'main', status:'active',
        description:'', language:'', framework:'', health_score:0,
        created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
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
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:6 }}>
            <h3 style={{ fontFamily:"'Figtree',sans-serif", fontSize:18, fontWeight:700,
              color:'#fff', margin:0, letterSpacing:'-0.02em' }}>Connect Repository</h3>
            <button onClick={()=>{ setAddProj(false); setAddProjToFolder(null); }}
              style={{ background:'none', border:'none', cursor:'pointer', color:'#545f72', lineHeight:0 }}>
              <X size={16}/>
            </button>
          </div>
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
          {([['Project Name','my-service',name,setName],
             ['Repository URL','github.com/org/repo',repo,setRepo],
             ['Default Branch','main',branch,setBranch]] as [string,string,string,(v:string)=>void][]).map(([l,ph,v,s])=>(
            <div key={l} style={{ marginBottom:14 }}>
              <div style={{ fontSize:12, color:'#545f72', marginBottom:5, fontFamily:"'Figtree',sans-serif" }}>{l}</div>
              <input ref={l==='Project Name'?nameRef:undefined} value={v} onChange={e=>s(e.target.value)}
                onKeyDown={e=>e.key==='Enter'&&submit()} placeholder={ph}
                style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                  borderRadius:7, padding:'10px 14px', color:'#e8eaf0',
                  fontFamily:"'Figtree',sans-serif", fontSize:13, outline:'none' }}/>
            </div>
          ))}
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
              Stored as GIT_TOKEN secret. Generate at GitHub → Settings → Developer settings → Personal access tokens.
            </div>
          </div>
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
                      borderRadius:6, cursor:'pointer', fontSize:12, fontFamily:"'Figtree',sans-serif",
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
  const AddFolderModal = () => {
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

  /* ── render ───────────────────────────────────────────────────────────────── */
  const main = () => {
    if (view === 'llm-config') return <LLMConfigView/>;
    if (view === 'secrets')    return <Secrets/>;
    if (view === 'settings')   return <SettingsView/>;
    if (view === 'versions')   return <VersionsView/>;
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
      </div>
    </>
  );
}
