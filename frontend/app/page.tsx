'use client';
import { useEffect, useState, useRef } from 'react';
import {
  Play, CheckCircle, XCircle, Clock, Plus, Settings, Terminal,
  Shield, Search, Sparkles, Command, Lock, FileCode, Loader2,
  GitCommit, X, Send, FolderOpen, Folder, ChevronDown,
  Trash2, GitBranch, Zap, Activity, ChevronRight
} from 'lucide-react';
import { pageApi as api, Project } from '@/lib/api';

// Local Build type — compatible with both the API response and demo data
type Build = {
  id: string; project_id: string; status: string; branch: string;
  commit_sha: string; commit_message: string; duration: number;
  created_at: string; started_at: string; finished_at: string;
};
import { formatDuration, timeAgo, statusStyles } from '@/lib/utils';

type View = 'dashboard' | 'builds' | 'pipeline' | 'secrets' | 'settings';
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

/* ─── main app ────────────────────────────────────────────────────────────── */
export default function App() {
  const [projects, setProjects]   = useState<Project[]>(DEMO);
  const [builds, setBuilds]       = useState<Build[]>(DEMO_BUILDS);
  const [sel, setSel]             = useState<Project|null>(null);
  const [view, setView]           = useState<View>('dashboard');
  const [selBuild, setSelBuild]   = useState<Build|null>(null);
  const [aiOpen, setAiOpen]       = useState(false);
  const [cmdOpen, setCmdOpen]     = useState(false);
  const [addProj, setAddProj]     = useState(false);
  const [addFolder, setAddFolder] = useState(false);
  const [msgs, setMsgs]           = useState<ChatMsg[]>([
    { role:'assistant', content:"Hey — I'm Callahan AI. Ask me to generate a pipeline, explain a failure, or review your code." }
  ]);
  const [input, setInput]         = useState('');
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
  useEffect(() => { api.getProjects().then(setProjects).catch(()=>{}); api.getBuilds().then(setBuilds).catch(()=>{}); }, []);

  const projBuilds = sel ? builds.filter(b=>b.project_id===sel.id) : builds;

  const triggerBuild = async () => {
    if (!sel) return;
    const mock: Build = { id:`b-${Date.now()}`, project_id:sel.id, status:'running', branch:sel.branch,
      commit_sha: Math.random().toString(36).slice(2,9), commit_message:'Manual trigger',
      duration:0, created_at:new Date().toISOString(), started_at:'', finished_at:'' };
    setBuilds(p=>[mock,...p]);
    try { const b = await api.triggerBuild(sel.id); setBuilds(p=>[b,...p.filter(x=>x.id!==mock.id)]); } catch {}
  };

  const deleteProject = (id: string) => {
    setProjects(p => p.filter(x => x.id !== id));
    setBuilds(b => b.filter(x => x.project_id !== id));
    setFolders(f => f.map(fo => ({ ...fo, projects: fo.projects.filter(p => p.id !== id) })));
    if (sel?.id === id) { setSel(null); setView('dashboard'); }
    try { api.triggerBuild(id); } catch {} // best-effort API delete (no delete endpoint yet)
  };

  const sendChat = async () => {
    if (!input.trim()||loading) return;
    const msg = input.trim(); setInput('');
    setMsgs(m=>[...m,{role:'user',content:msg}]); setLoading(true);
    try {
      const r = await api.aiChat(msg, sel?.id);
      setMsgs(m=>[...m,{role:'assistant',content:r.message}]);
    } catch {
      setMsgs(m=>[...m,{role:'assistant',content:'Start the backend first: `go run ./cmd/callahan` in the backend folder.'}]);
    }
    setLoading(false);
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
            <button onClick={()=>setFolders(fs=>fs.map(x=>x.id===f.id?{...x,expanded:!x.expanded}:x))}
              style={{ display:'flex', alignItems:'center', gap:7, padding:'6px 8px', width:'100%',
                background:'none', border:'none', cursor:'pointer', borderRadius:6,
                color:'#8892a4', fontSize:13, fontFamily:"'Figtree',sans-serif" }}>
              <ChevronDown size={11} style={{ transform:f.expanded?'none':'rotate(-90deg)', transition:'0.15s', color:'#545f72' }}/>
              {f.expanded ? <FolderOpen size={13} style={{ color:'#00d4ff' }}/> : <Folder size={13} style={{ color:'#545f72' }}/>}
              <span style={{ fontWeight:500, fontSize:12 }}>{f.name}</span>
            </button>
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
          {(['dashboard','builds','pipeline','secrets','settings'] as View[]).map(v=>{
            const icons: Record<View, React.ReactNode> = {
              dashboard:<Activity size={13}/>, builds:<Zap size={13}/>,
              pipeline:<GitBranch size={13}/>, secrets:<Lock size={13}/>, settings:<Settings size={13}/>
            };
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

      {/* status dot */}
      <div style={{ padding:'10px 16px', borderTop:'1px solid rgba(255,255,255,0.07)',
        display:'flex', alignItems:'center', gap:7 }}>
        <span style={{ width:6, height:6, borderRadius:'50%', background:'#00e5a0',
          boxShadow:'0 0 6px #00e5a0', display:'inline-block',
          animation:'blink 2s ease-in-out infinite' }}/>
        <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
          letterSpacing:'0.04em' }}>API :8080</span>
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
  const Builds = () => (
    <div style={{ padding:28 }}>
      <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
        <h2 style={{ fontFamily:"'Figtree',sans-serif", fontSize:22, fontWeight:800,
          color:'#fff', letterSpacing:'-0.03em', margin:0 }}>Builds</h2>
        <button onClick={triggerBuild} style={{ display:'flex', alignItems:'center', gap:7,
          padding:'9px 20px', background:'#00d4ff', color:'#000', border:'none',
          borderRadius:7, fontSize:13, fontWeight:700, cursor:'pointer',
          fontFamily:"'Figtree',sans-serif" }}>
          <Play size={13} fill="#000"/> Run Build
        </button>
      </div>

      {selBuild ? (
        <div>
          <button onClick={()=>setSelBuild(null)} style={{ display:'flex', alignItems:'center', gap:6,
            background:'none', border:'none', color:'#8892a4', cursor:'pointer', fontSize:13,
            marginBottom:16, padding:0, fontFamily:"'Figtree',sans-serif" }}>
            ← Back
          </button>
          <Card style={{ marginBottom:12 }}>
            <div style={{ display:'grid', gridTemplateColumns:'repeat(4,1fr)', gap:16, marginBottom:16 }}>
              {[
                { l:'Status',   n:<Badge status={selBuild.status}/> },
                { l:'Branch',   n:<span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:'#00d4ff' }}>{selBuild.branch}</span> },
                { l:'Commit',   n:<span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:'#8892a4' }}>{selBuild.commit_sha?.slice(0,7)}</span> },
                { l:'Duration', n:<span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:12, color:'#8892a4' }}>{selBuild.duration?formatDuration(selBuild.duration):'Running…'}</span> },
              ].map(m=>(
                <div key={m.l}>
                  <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
                    letterSpacing:'0.08em', textTransform:'uppercase', marginBottom:8 }}>{m.l}</div>
                  {m.n}
                </div>
              ))}
            </div>
            <div style={{ fontSize:14, color:'#8892a4', fontFamily:"'Figtree',sans-serif" }}>{selBuild.commit_message}</div>
          </Card>
          <Card>
            <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:14 }}>
              <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
                letterSpacing:'0.1em', textTransform:'uppercase' }}>Build Log</span>
              <button onClick={()=>setAiOpen(true)} style={{ display:'flex', alignItems:'center', gap:6,
                padding:'5px 12px', background:'rgba(0,212,255,0.08)', border:'1px solid rgba(0,212,255,0.2)',
                borderRadius:5, color:'#00d4ff', cursor:'pointer', fontSize:12,
                fontFamily:"'Figtree',sans-serif" }}>
                <Sparkles size={12}/> AI Explain
              </button>
            </div>
            <div style={{ background:'#080a0f', borderRadius:8, padding:16,
              fontFamily:"'IBM Plex Mono',monospace", fontSize:12, lineHeight:2, color:'#8892a4' }}>
              {selBuild.status==='success' ? <>
                <div style={{ color:'#00e5a0' }}>✔ Pipeline started</div>
                <div style={{ color:'#00d4ff' }}>▶ step[1] — install dependencies</div>
                <div style={{ color:'#00e5a0' }}>✔ npm ci completed (12.3s, cached)</div>
                <div style={{ color:'#00d4ff' }}>▶ step[2] — run tests</div>
                <div style={{ color:'#00e5a0' }}>✔ 142 passed, 0 failed (8.1s)</div>
                <div style={{ color:'#00d4ff' }}>▶ step[3] — build</div>
                <div style={{ color:'#00e5a0' }}>✔ Build complete — pipeline success</div>
              </> : selBuild.status==='failed' ? <>
                <div style={{ color:'#00e5a0' }}>✔ Pipeline started</div>
                <div style={{ color:'#00d4ff' }}>▶ step[1] — install</div>
                <div style={{ color:'#00e5a0' }}>✔ npm ci (11.2s)</div>
                <div style={{ color:'#00d4ff' }}>▶ step[2] — run tests</div>
                <div style={{ color:'#ff4455' }}>✖ Error: 3 tests failed</div>
                <div style={{ color:'#a078ff' }}>✦ Click "AI Explain" to diagnose this failure</div>
              </> : <>
                <div style={{ color:'#00d4ff' }}>▶ Pipeline running…</div>
                <div style={{ color:'#545f72' }}>  Fetching packages…</div>
              </>}
            </div>
          </Card>
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
    </div>
  );

  /* ── pipeline ─────────────────────────────────────────────────────────────── */
  const Pipeline = () => {
    const [yaml, setYaml] = useState(
`name: ${sel?.name??'my-pipeline'}
on: [push, pull_request]

jobs:
  build:
    runs-on: callahan:latest
    steps:
      - name: Install
        run: npm ci

      - name: Test
        run: npm test

      - name: Build
        run: npm run build

    ai:
      review: true
      explain-failures: true
      security-scan: true`);
    return (
      <div style={{ padding:28 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
          <h2 style={{ fontFamily:"'Figtree',sans-serif", fontSize:22, fontWeight:800,
            color:'#fff', letterSpacing:'-0.03em', margin:0 }}>Pipeline</h2>
          <div style={{ display:'flex', gap:8 }}>
            <button onClick={()=>setAiOpen(true)} style={{ display:'flex', alignItems:'center', gap:7,
              padding:'9px 16px', background:'rgba(0,212,255,0.08)', border:'1px solid rgba(0,212,255,0.2)',
              borderRadius:7, color:'#00d4ff', cursor:'pointer', fontSize:13,
              fontFamily:"'Figtree',sans-serif" }}>
              <Sparkles size={13}/> Generate with AI
            </button>
            <button style={{ padding:'9px 18px', background:'#00d4ff', color:'#000', border:'none',
              borderRadius:7, fontSize:13, fontWeight:700, cursor:'pointer',
              fontFamily:"'Figtree',sans-serif" }}>Save</button>
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
  const Secrets = () => {
    const [list] = useState([
      { key:'ANTHROPIC_API_KEY', updated:'2 days ago' },
      { key:'FLY_API_TOKEN', updated:'5 days ago' },
    ]);
    return (
      <div style={{ padding:28 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
          <h2 style={{ fontFamily:"'Figtree',sans-serif", fontSize:22, fontWeight:800,
            color:'#fff', letterSpacing:'-0.03em', margin:0 }}>Secrets</h2>
          <button style={{ display:'flex', alignItems:'center', gap:7,
            padding:'9px 18px', background:'#00d4ff', color:'#000', border:'none',
            borderRadius:7, fontSize:13, fontWeight:700, cursor:'pointer',
            fontFamily:"'Figtree',sans-serif" }}>
            <Plus size={14}/> Add Secret
          </button>
        </div>
        <Card>
          {list.map((s,i)=>(
            <div key={s.key} style={{ display:'flex', alignItems:'center', gap:14, padding:'14px 0',
              borderBottom: i<list.length-1?'1px solid rgba(255,255,255,0.07)':'none' }}>
              <Lock size={14} style={{ color:'#545f72' }}/>
              <div style={{ flex:1 }}>
                <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:13,
                  color:'#fff', marginBottom:2 }}>{s.key}</div>
                <div style={{ fontSize:11, color:'#545f72',
                  fontFamily:"'Figtree',sans-serif" }}>Updated {s.updated}</div>
              </div>
              <span style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:11,
                color:'#545f72' }}>••••••••</span>
              <button style={{ background:'none', border:'none', cursor:'pointer',
                color:'#545f72', padding:4, lineHeight:0 }}><Trash2 size={13}/></button>
            </div>
          ))}
        </Card>
      </div>
    );
  };

  /* ── settings ─────────────────────────────────────────────────────────────── */
  const SettingsView = () => (
    <div style={{ padding:28 }}>
      <h2 style={{ fontFamily:"'Figtree',sans-serif", fontSize:22, fontWeight:800,
        color:'#fff', letterSpacing:'-0.03em', marginBottom:24 }}>Settings</h2>
      <Card style={{ marginBottom:12 }}>
        <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
          letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:18 }}>Project</div>
        {[{l:'Name',v:sel?.name},{l:'Repository',v:sel?.repo_url},{l:'Branch',v:sel?.branch}].map(f=>(
          <div key={f.l} style={{ marginBottom:14 }}>
            <div style={{ fontSize:12, color:'#545f72', marginBottom:5,
              fontFamily:"'Figtree',sans-serif" }}>{f.l}</div>
            <input defaultValue={f.v} style={{ width:'100%', background:'#080a0f',
              border:'1px solid rgba(255,255,255,0.12)', borderRadius:6, padding:'9px 12px',
              color:'#e8eaf0', fontFamily:"'Figtree',sans-serif", fontSize:13, outline:'none' }}/>
          </div>
        ))}
        <button style={{ padding:'9px 20px', background:'#00d4ff', color:'#000',
          border:'none', borderRadius:7, fontWeight:700, fontSize:13, cursor:'pointer',
          fontFamily:"'Figtree',sans-serif" }}>Save Changes</button>
      </Card>
      <Card>
        <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72',
          letterSpacing:'0.1em', textTransform:'uppercase', marginBottom:14 }}>Danger Zone</div>
        <button style={{ padding:'9px 20px', background:'rgba(255,68,85,0.1)',
          color:'#ff4455', border:'1px solid rgba(255,68,85,0.2)',
          borderRadius:7, fontSize:13, cursor:'pointer',
          fontFamily:"'Figtree',sans-serif" }}>Delete Project</button>
      </Card>
    </div>
  );

  /* ── AI panel ─────────────────────────────────────────────────────────────── */
  const AiPanel = () => (
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
              <div style={{ fontFamily:"'IBM Plex Mono',monospace", fontSize:10, color:'#545f72' }}>claude-3-5-sonnet</div>
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
              <button key={s} onClick={()=>setInput(s)} style={{ padding:'8px 12px',
                background:'#111620', border:'1px solid rgba(255,255,255,0.12)',
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
                fontWeight: m.role==='user'?600:400 }}>
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
          <input value={input} onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>e.key==='Enter'&&!e.shiftKey&&sendChat()}
            placeholder="Ask anything…"
            style={{ flex:1, background:'#111620', border:'1px solid rgba(255,255,255,0.12)',
              borderRadius:8, padding:'10px 14px', color:'#e8eaf0',
              fontFamily:"'Figtree',sans-serif", fontSize:13, outline:'none' }}/>
          <button onClick={sendChat} disabled={loading}
            style={{ padding:'10px 14px', background:'#00d4ff', color:'#000',
              border:'none', borderRadius:8, cursor:'pointer', lineHeight:0 }}>
            <Send size={14}/>
          </button>
        </div>
      </div>
    </div>
  );

  /* ── command palette ──────────────────────────────────────────────────────── */
  const CmdPalette = () => {
    const cmds = [
      { label:'Connect Repository',  icon:<Plus size={14}/>,      fn:()=>{setAddProj(true);setCmdOpen(false);} },
      { label:'Run Build',           icon:<Play size={14}/>,      fn:()=>{triggerBuild();setCmdOpen(false);} },
      { label:'Open Callahan AI',    icon:<Sparkles size={14}/>,  fn:()=>{setAiOpen(true);setCmdOpen(false);} },
      { label:'View Builds',         icon:<Zap size={14}/>,       fn:()=>{setView('builds');setCmdOpen(false);} },
      { label:'Edit Pipeline',       icon:<FileCode size={14}/>,  fn:()=>{setView('pipeline');setCmdOpen(false);} },
      { label:'Manage Secrets',      icon:<Lock size={14}/>,      fn:()=>{setView('secrets');setCmdOpen(false);} },
      { label:'Settings',            icon:<Settings size={14}/>,  fn:()=>{setView('settings');setCmdOpen(false);} },
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
  const AddProject = () => {
    const [name, setName] = useState('');
    const [repo, setRepo] = useState('');
    const nameRef = useRef<HTMLInputElement>(null);
    useEffect(() => { setTimeout(() => nameRef.current?.focus(), 50); }, []);
    const submit = () => {
      if (!name.trim()) return;
      const p: Project = { id: Date.now().toString(), name: name.trim(), repo_url: repo,
        provider:'github', branch:'main', status:'pending', created_at: new Date().toISOString() };
      setProjects(prev => [...prev, p]);
      setSel(p);
      setAddProj(false);
    };
    return (
      <div style={{ position:'fixed', inset:0, zIndex:100, display:'flex', alignItems:'center',
        justifyContent:'center', background:'rgba(0,0,0,0.6)', backdropFilter:'blur(8px)' }}
        onClick={()=>setAddProj(false)}>
        <div style={{ width:480, background:'#0d1117', border:'1px solid rgba(255,255,255,0.12)',
          borderRadius:12, padding:28, boxShadow:'0 32px 80px rgba(0,0,0,0.6)' }}
          onClick={e=>e.stopPropagation()}>
          <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:24 }}>
            <h3 style={{ fontFamily:"'Figtree',sans-serif", fontSize:18, fontWeight:700,
              color:'#fff', margin:0, letterSpacing:'-0.02em' }}>Connect Repository</h3>
            <button onClick={()=>setAddProj(false)} style={{ background:'none', border:'none',
              cursor:'pointer', color:'#545f72', lineHeight:0 }}><X size={16}/></button>
          </div>
          <div style={{ marginBottom:16 }}>
            <div style={{ fontSize:12, color:'#545f72', marginBottom:6, fontFamily:"'Figtree',sans-serif" }}>Project Name</div>
            <input ref={nameRef} value={name} onChange={e=>setName(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&submit()}
              placeholder="my-service"
              style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                borderRadius:7, padding:'10px 14px', color:'#e8eaf0',
                fontFamily:"'Figtree',sans-serif", fontSize:13, outline:'none' }}/>
          </div>
          <div style={{ marginBottom:16 }}>
            <div style={{ fontSize:12, color:'#545f72', marginBottom:6, fontFamily:"'Figtree',sans-serif" }}>Repository URL</div>
            <input value={repo} onChange={e=>setRepo(e.target.value)}
              onKeyDown={e=>e.key==='Enter'&&submit()}
              placeholder="github.com/org/repo"
              style={{ width:'100%', background:'#080a0f', border:'1px solid rgba(255,255,255,0.12)',
                borderRadius:7, padding:'10px 14px', color:'#e8eaf0',
                fontFamily:"'Figtree',sans-serif", fontSize:13, outline:'none' }}/>
          </div>
          <div style={{ display:'flex', gap:10, marginTop:24 }}>
            <button onClick={()=>setAddProj(false)} style={{ flex:1, padding:10,
              background:'transparent', border:'1px solid rgba(255,255,255,0.12)',
              borderRadius:7, color:'#8892a4', cursor:'pointer',
              fontFamily:"'Figtree',sans-serif", fontSize:13 }}>Cancel</button>
            <button onClick={submit} style={{ flex:1, padding:10, background:'#00d4ff',
              color:'#000', border:'none', borderRadius:7, fontWeight:700, cursor:'pointer',
              fontFamily:"'Figtree',sans-serif", fontSize:13 }}>Connect</button>
          </div>
        </div>
      </div>
    );
  };
    </div>
  );

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
    if (!sel) return <Welcome/>;
    switch(view) {
      case 'dashboard': return <Dashboard/>;
      case 'builds':    return <Builds/>;
      case 'pipeline':  return <Pipeline/>;
      case 'secrets':   return <Secrets/>;
      case 'settings':  return <SettingsView/>;
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
