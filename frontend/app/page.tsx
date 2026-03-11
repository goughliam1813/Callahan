'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Zap, GitBranch, Play, CheckCircle, XCircle, Clock,
  Plus, Settings, Terminal, Shield, Search,
  ChevronRight, Activity, Layers, Sparkles, Command, ArrowUpRight,
  Lock, Upload, FileCode, TrendingUp, Loader2,
  GitCommit, X, Send, Bot, FolderOpen, Folder, ChevronDown,
  MoreHorizontal, Trash2
} from 'lucide-react';
import { api, Project, Build, Job, DashboardStats } from '@/lib/api';
import {
  formatDuration, formatRelativeTime, getStatusBg,
  getProviderIcon, getLanguageColor, truncateCommit,
  demoProjects, demoBuilds
} from '@/lib/utils';
import { cn } from '@/lib/utils';

type View = 'dashboard' | 'builds' | 'pipeline' | 'secrets' | 'settings';
type ChatMsg = { role: 'user' | 'assistant'; content: string; timestamp: Date };
type Folder = { id: string; name: string; expanded: boolean; projects: Project[] };

// ─── Alien Logo SVG ───────────────────────────────────────────────────────────
function AlienLogo({ size = 40, blue = false }: { size?: number; blue?: boolean }) {
  const bg = blue ? '#2563eb' : '#ea580c';
  const glow = blue ? '#93c5fd' : '#fdba74';
  return (
    <svg viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg"
      style={{ width: size, height: size }}>
      <defs>
        <radialGradient id={`bg-${blue}`} cx="50%" cy="40%" r="60%">
          <stop offset="0%" stopColor={blue ? '#3b82f6' : '#f97316'} />
          <stop offset="100%" stopColor={bg} />
        </radialGradient>
        <radialGradient id={`glow-${blue}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={glow} stopOpacity="0.6" />
          <stop offset="100%" stopColor={glow} stopOpacity="0" />
        </radialGradient>
      </defs>
      {/* outer glow */}
      <ellipse cx="24" cy="24" rx="20" ry="20" fill={`url(#glow-${blue})`} opacity="0.35" />
      {/* head — tall elongated alien skull */}
      <ellipse cx="24" cy="20" rx="12" ry="15" fill={`url(#bg-${blue})`} />
      {/* cranium bump */}
      <ellipse cx="24" cy="11" rx="9" ry="8" fill={blue ? '#60a5fa' : '#fb923c'} opacity="0.7" />
      {/* chin taper */}
      <path d="M18 28 Q24 36 30 28" fill={`url(#bg-${blue})`} />
      {/* large almond left eye */}
      <ellipse cx="18.5" cy="21" rx="5" ry="3.5" fill="white" opacity="0.95" />
      <ellipse cx="18.5" cy="21" rx="3.2" ry="2.4" fill={blue ? '#1d4ed8' : '#9a3412'} />
      <ellipse cx="18.5" cy="21" rx="1.6" ry="1.6" fill="#0f0f0f" />
      <circle cx="17.5" cy="20.2" r="0.7" fill="white" opacity="0.9" />
      {/* large almond right eye */}
      <ellipse cx="29.5" cy="21" rx="5" ry="3.5" fill="white" opacity="0.95" />
      <ellipse cx="29.5" cy="21" rx="3.2" ry="2.4" fill={blue ? '#1d4ed8' : '#9a3412'} />
      <ellipse cx="29.5" cy="21" rx="1.6" ry="1.6" fill="#0f0f0f" />
      <circle cx="28.5" cy="20.2" r="0.7" fill="white" opacity="0.9" />
      {/* tiny nose slits */}
      <ellipse cx="22.5" cy="26.5" rx="0.9" ry="1.2" fill={blue ? '#1e40af' : '#7c2d12'} opacity="0.5" />
      <ellipse cx="25.5" cy="26.5" rx="0.9" ry="1.2" fill={blue ? '#1e40af' : '#7c2d12'} opacity="0.5" />
      {/* thin mouth line */}
      <path d="M20 29.5 Q24 31 28 29.5" stroke={blue ? '#bfdbfe' : '#fed7aa'} strokeWidth="0.9" strokeLinecap="round" fill="none" opacity="0.8" />
      {/* antennae */}
      <line x1="20" y1="7" x2="16" y2="1" stroke={glow} strokeWidth="1.2" strokeLinecap="round" opacity="0.8" />
      <circle cx="15.5" cy="0.8" r="1.4" fill={glow} opacity="0.9" />
      <line x1="28" y1="7" x2="32" y2="1" stroke={glow} strokeWidth="1.2" strokeLinecap="round" opacity="0.8" />
      <circle cx="32.5" cy="0.8" r="1.4" fill={glow} opacity="0.9" />
      {/* thin neck */}
      <rect x="21" y="33" width="6" height="5" rx="2" fill={`url(#bg-${blue})`} opacity="0.8" />
      {/* shoulders */}
      <ellipse cx="24" cy="40" rx="10" ry="5" fill={`url(#bg-${blue})`} opacity="0.6" />
    </svg>
  );
}

// ─── Status Badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }: { status: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold border', getStatusBg(status))}>
      {status === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-orange-500 status-dot-running" />}
      {status === 'success' && <CheckCircle className="w-3 h-3" />}
      {status === 'failed' && <XCircle className="w-3 h-3" />}
      {status === 'pending' && <Clock className="w-3 h-3" />}
      {status}
    </span>
  );
}

// ─── Health Ring ──────────────────────────────────────────────────────────────
function HealthRing({ score }: { score: number }) {
  const color = score >= 90 ? '#16a34a' : score >= 70 ? '#d97706' : '#dc2626';
  const r = 10, c = 2 * Math.PI * r;
  return (
    <svg width="26" height="26" className="-rotate-90">
      <circle cx="13" cy="13" r={r} fill="none" stroke="rgba(0,0,0,0.07)" strokeWidth="2.5" />
      <circle cx="13" cy="13" r={r} fill="none" stroke={color} strokeWidth="2.5"
        strokeDasharray={`${(score / 100) * c} ${c}`} strokeLinecap="round"
        style={{ transition: 'stroke-dasharray 0.5s ease' }} />
    </svg>
  );
}

// ─── Stat Card ────────────────────────────────────────────────────────────────
function StatCard({ label, value, icon: Icon, color }: { label: string; value: string | number; icon: any; color: string }) {
  return (
    <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}
      className="bg-[#fffefb] border-2 border-stone-200 rounded-2xl p-4 hover:border-orange-200 hover:shadow-md transition-all">
      <div className={cn('w-8 h-8 rounded-xl flex items-center justify-center mb-3', color)}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="text-2xl font-bold text-stone-800 tabular-nums">{value}</div>
      <div className="text-xs text-stone-400 mt-0.5 font-medium">{label}</div>
    </motion.div>
  );
}

// ─── AI Chat Panel ─────────────────────────────────────────────────────────────
function AIChat({ onClose, context }: { onClose: () => void; context: string }) {
  const [messages, setMessages] = useState<ChatMsg[]>([
    { role: 'assistant', content: "Hey! I'm Callahan AI. Ask me anything — debug builds, generate pipelines, explain security issues, or optimise your setup.", timestamp: new Date() }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const send = async () => {
    if (!input.trim() || loading) return;
    const userMsg: ChatMsg = { role: 'user', content: input, timestamp: new Date() };
    setMessages(m => [...m, userMsg]);
    setInput('');
    setLoading(true);
    try {
      const result = await api.chat([...messages, userMsg].map(m => ({ role: m.role, content: m.content })), context);
      setMessages(m => [...m, { role: 'assistant', content: result.response, timestamp: new Date() }]);
    } catch {
      setMessages(m => [...m, { role: 'assistant', content: 'AI unavailable — check your LLM config in Settings.', timestamp: new Date() }]);
    } finally { setLoading(false); }
  };

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);

  return (
    <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }}
      className="w-[360px] flex flex-col bg-[#fffefb] border-l-2 border-stone-200 h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b-2 border-stone-200 bg-white">
        <div className="flex items-center gap-2.5">
          <AlienLogo size={28} blue />
          <div>
            <div className="text-sm font-bold text-stone-800">Callahan AI</div>
            <div className="text-[10px] text-blue-500 font-medium">Always-on intelligence</div>
          </div>
        </div>
        <button onClick={onClose} className="p-1.5 hover:bg-stone-100 rounded-lg transition-colors">
          <X className="w-4 h-4 text-stone-400" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.map((msg, i) => (
          <div key={i} className={cn('flex gap-2', msg.role === 'user' ? 'flex-row-reverse' : '')}>
            {msg.role === 'assistant' && (
              <div className="flex-shrink-0 mt-0.5"><AlienLogo size={22} blue /></div>
            )}
            <div className={cn('max-w-[260px] rounded-2xl px-3 py-2 text-sm leading-relaxed',
              msg.role === 'user'
                ? 'bg-blue-500 text-white rounded-br-sm'
                : 'bg-stone-100 text-stone-700 rounded-bl-sm border border-stone-200')}>
              {msg.content}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex gap-2">
            <AlienLogo size={22} blue />
            <div className="bg-stone-100 border border-stone-200 rounded-2xl rounded-bl-sm px-3 py-2.5 flex items-center gap-1">
              {[0,1,2].map(i => (
                <div key={i} className="w-1.5 h-1.5 rounded-full bg-blue-400"
                  style={{ animation: `status-pulse 1.2s ease-in-out ${i*0.2}s infinite` }} />
              ))}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {messages.length < 2 && (
        <div className="px-4 pb-2 flex flex-wrap gap-1.5">
          {["Why did my build fail?", "Generate a Go pipeline", "Optimise for speed", "Explain security scan"].map(s => (
            <button key={s} onClick={() => setInput(s)}
              className="text-[11px] px-2.5 py-1 rounded-full bg-stone-100 hover:bg-blue-50 hover:text-blue-600 text-stone-500 transition-colors border border-stone-200">
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="p-3 border-t-2 border-stone-200 bg-white">
        <div className="flex gap-2">
          <input value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && send()}
            placeholder="Ask anything..."
            className="flex-1 bg-stone-50 border-2 border-stone-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-300 transition-colors" />
          <button onClick={send} disabled={!input.trim() || loading}
            className="p-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 rounded-xl transition-colors">
            <Send className="w-4 h-4 text-white" />
          </button>
        </div>
      </div>
    </motion.div>
  );
}

// ─── Build Row ─────────────────────────────────────────────────────────────────
function BuildRow({ build, onClick }: { build: Build; onClick: () => void }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} onClick={onClick}
      className="flex items-center gap-4 px-5 py-3 hover:bg-orange-50/50 cursor-pointer border-b-2 border-stone-100 last:border-b-0 transition-colors group">
      <span className="text-xs text-stone-400 w-7 font-mono">#{build.number}</span>
      <StatusBadge status={build.status} />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-stone-700 truncate">{build.commit_message || 'No message'}</div>
        <div className="flex items-center gap-2 mt-0.5">
          <GitBranch className="w-3 h-3 text-stone-400" />
          <span className="text-xs text-stone-400">{build.branch}</span>
          <GitCommit className="w-3 h-3 text-stone-400" />
          <span className="text-xs font-mono text-stone-400">{truncateCommit(build.commit)}</span>
        </div>
      </div>
      <div className="text-xs text-stone-400">{build.author}</div>
      <div className="text-right">
        <div className="text-xs text-stone-500 font-medium">{build.duration_ms ? formatDuration(build.duration_ms) : '—'}</div>
        <div className="text-xs text-stone-400">{formatRelativeTime(build.created_at)}</div>
      </div>
      {build.ai_insight && <Sparkles className="w-3.5 h-3.5 text-blue-400 flex-shrink-0" />}
      <ChevronRight className="w-4 h-4 text-stone-300 group-hover:text-stone-500 transition-colors" />
    </motion.div>
  );
}

// ─── Add Project Modal ─────────────────────────────────────────────────────────
function AddProjectModal({ onClose, onAdd, folders }: { onClose: () => void; onAdd: (data: any) => void; folders: Folder[] }) {
  const [form, setForm] = useState({ name: '', repo_url: '', provider: 'github', branch: 'main', description: '', token: '', folderId: '' });
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    if (!form.name || !form.repo_url) return;
    setLoading(true);
    await onAdd(form);
    setLoading(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <motion.div initial={{ opacity: 0, scale: 0.96, y: 8 }} animate={{ opacity: 1, scale: 1, y: 0 }}
        className="bg-[#fffefb] border-2 border-stone-200 rounded-2xl w-full max-w-md p-6 shadow-xl">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h2 className="text-base font-bold text-stone-800">Connect Repository</h2>
            <p className="text-xs text-stone-400 mt-0.5">Add a Git repo to Callahan CI</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-stone-100 rounded-xl transition-colors">
            <X className="w-4 h-4 text-stone-400" />
          </button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-semibold text-stone-500 mb-1 block">Project Name *</label>
            <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              placeholder="my-awesome-app"
              className="w-full bg-stone-50 border-2 border-stone-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-orange-300 transition-colors" />
          </div>
          <div>
            <label className="text-xs font-semibold text-stone-500 mb-1 block">Repository URL *</label>
            <input value={form.repo_url} onChange={e => setForm(f => ({ ...f, repo_url: e.target.value }))}
              placeholder="https://github.com/org/repo"
              className="w-full bg-stone-50 border-2 border-stone-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-orange-300 transition-colors" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-semibold text-stone-500 mb-1 block">Provider</label>
              <select value={form.provider} onChange={e => setForm(f => ({ ...f, provider: e.target.value }))}
                className="w-full bg-stone-50 border-2 border-stone-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-orange-300 transition-colors">
                <option value="github">🐙 GitHub</option>
                <option value="gitlab">🦊 GitLab</option>
                <option value="bitbucket">🪣 Bitbucket</option>
                <option value="gitea">☕ Gitea</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-semibold text-stone-500 mb-1 block">Branch</label>
              <input value={form.branch} onChange={e => setForm(f => ({ ...f, branch: e.target.value }))}
                placeholder="main"
                className="w-full bg-stone-50 border-2 border-stone-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-orange-300 transition-colors" />
            </div>
          </div>
          {folders.length > 0 && (
            <div>
              <label className="text-xs font-semibold text-stone-500 mb-1 block">Add to Folder</label>
              <select value={form.folderId} onChange={e => setForm(f => ({ ...f, folderId: e.target.value }))}
                className="w-full bg-stone-50 border-2 border-stone-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-orange-300 transition-colors">
                <option value="">No folder</option>
                {folders.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label className="text-xs font-semibold text-stone-500 mb-1 block">Access Token (optional)</label>
            <input value={form.token} onChange={e => setForm(f => ({ ...f, token: e.target.value }))}
              type="password" placeholder="ghp_..."
              className="w-full bg-stone-50 border-2 border-stone-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-orange-300 transition-colors" />
          </div>
        </div>

        <div className="flex gap-3 mt-5">
          <button onClick={onClose} className="flex-1 py-2.5 rounded-xl border-2 border-stone-200 text-sm text-stone-600 hover:bg-stone-50 transition-colors font-medium">
            Cancel
          </button>
          <button onClick={submit} disabled={!form.name || !form.repo_url || loading}
            className="flex-1 py-2.5 rounded-xl bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-sm font-semibold text-white transition-colors flex items-center justify-center gap-2">
            {loading && <Loader2 className="w-4 h-4 animate-spin" />}
            Connect Repo
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Add Folder Modal ──────────────────────────────────────────────────────────
function AddFolderModal({ onClose, onAdd }: { onClose: () => void; onAdd: (name: string) => void }) {
  const [name, setName] = useState('');
  return (
    <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50 flex items-center justify-center p-4">
      <motion.div initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
        className="bg-[#fffefb] border-2 border-stone-200 rounded-2xl w-full max-w-xs p-5 shadow-xl">
        <h2 className="text-sm font-bold text-stone-800 mb-4">New Folder</h2>
        <input autoFocus value={name} onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && name.trim()) { onAdd(name.trim()); onClose(); } }}
          placeholder="e.g. Frontend, Backend, Infra"
          className="w-full bg-stone-50 border-2 border-stone-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:border-orange-300 transition-colors mb-4" />
        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 py-2 rounded-xl border-2 border-stone-200 text-sm text-stone-500 hover:bg-stone-50 transition-colors">Cancel</button>
          <button onClick={() => { if (name.trim()) { onAdd(name.trim()); onClose(); } }}
            disabled={!name.trim()}
            className="flex-1 py-2 rounded-xl bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-sm font-semibold text-white transition-colors">
            Create
          </button>
        </div>
      </motion.div>
    </div>
  );
}

// ─── Pipeline Editor ───────────────────────────────────────────────────────────
function PipelineEditor({ project }: { project: Project }) {
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [showAiInput, setShowAiInput] = useState(false);

  useEffect(() => {
    api.getPipeline(project.id).then(r => setContent(r.content)).catch(() => setContent('# No Callahanfile.yaml found')).finally(() => setLoading(false));
  }, [project.id]);

  const save = async () => {
    setSaving(true);
    await api.updatePipeline(project.id, content).catch(() => {});
    setSaving(false);
  };

  const generate = async () => {
    if (!aiPrompt.trim()) return;
    setGenerating(true);
    try {
      const r = await api.generatePipeline(aiPrompt, project.language, project.framework);
      setContent(r.content); setShowAiInput(false); setAiPrompt('');
    } finally { setGenerating(false); }
  };

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="w-6 h-6 animate-spin text-stone-400" /></div>;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-5 py-3 border-b-2 border-stone-200 bg-white">
        <div className="flex items-center gap-2">
          <FileCode className="w-4 h-4 text-orange-400" />
          <span className="text-sm font-semibold text-stone-700">Callahanfile.yaml</span>
          <span className="text-xs text-stone-400">— {project.name}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setShowAiInput(!showAiInput)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 border-2 border-blue-200 text-blue-600 text-xs font-semibold hover:bg-blue-100 transition-colors">
            <Sparkles className="w-3 h-3" /> Generate with AI
          </button>
          <button onClick={save} disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-orange-50 border-2 border-orange-200 text-orange-600 text-xs font-semibold hover:bg-orange-100 transition-colors">
            {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Upload className="w-3 h-3" />} Save
          </button>
        </div>
      </div>
      <AnimatePresence>
        {showAiInput && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            className="border-b-2 border-stone-200 overflow-hidden">
            <div className="p-4 bg-blue-50/50 flex gap-2">
              <textarea value={aiPrompt} onChange={e => setAiPrompt(e.target.value)} rows={2}
                placeholder='Describe your pipeline… e.g. "Build Next.js, run Playwright, scan with Trivy, deploy to Vercel on green PRs"'
                className="flex-1 bg-white border-2 border-blue-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-blue-400 resize-none transition-colors" />
              <button onClick={generate} disabled={!aiPrompt.trim() || generating}
                className="px-4 py-2 rounded-xl bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-sm font-semibold text-white transition-colors flex items-center gap-1.5">
                {generating ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />} Generate
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="flex-1 overflow-hidden">
        <textarea value={content} onChange={e => setContent(e.target.value)}
          className="w-full h-full bg-stone-900 p-5 text-sm text-emerald-300 focus:outline-none resize-none leading-relaxed"
          spellCheck={false} />
      </div>
    </div>
  );
}

// ─── Build Detail ──────────────────────────────────────────────────────────────
function BuildDetail({ build, onBack }: { build: Build; onBack: () => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [explaining, setExplaining] = useState(false);
  const [explanation, setExplanation] = useState(build.ai_insight || '');

  useEffect(() => { api.listJobs(build.id).then(setJobs).catch(() => {}); }, [build.id]);

  const explain = async () => {
    setExplaining(true);
    try {
      const r = await api.explainBuild(build.id, '', '');
      setExplanation(r.explanation);
    } finally { setExplaining(false); }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-3 border-b-2 border-stone-200 bg-white">
        <button onClick={onBack} className="p-1.5 hover:bg-stone-100 rounded-lg transition-colors">
          <ChevronRight className="w-4 h-4 rotate-180 text-stone-400" />
        </button>
        <StatusBadge status={build.status} />
        <span className="text-sm font-semibold text-stone-700">Build #{build.number}</span>
        <span className="text-sm text-stone-400 truncate flex-1">{build.commit_message}</span>
        {build.status === 'failed' && (
          <button onClick={explain} disabled={explaining}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 border-2 border-blue-200 text-blue-600 text-xs font-semibold hover:bg-blue-100 transition-colors">
            {explaining ? <Loader2 className="w-3 h-3 animate-spin" /> : <AlienLogo size={14} blue />}
            AI Explain
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Branch', value: build.branch, icon: GitBranch },
            { label: 'Commit', value: truncateCommit(build.commit) || '—', icon: GitCommit },
            { label: 'Duration', value: build.duration_ms ? formatDuration(build.duration_ms) : '—', icon: Clock },
            { label: 'Trigger', value: build.trigger, icon: Zap },
          ].map(({ label, value, icon: Icon }) => (
            <div key={label} className="bg-[#fffefb] border-2 border-stone-200 rounded-xl p-3">
              <div className="flex items-center gap-1.5 mb-1.5">
                <Icon className="w-3 h-3 text-stone-400" />
                <span className="text-[10px] font-semibold text-stone-400 uppercase tracking-wider">{label}</span>
              </div>
              <div className="text-sm font-semibold text-stone-700 font-mono">{value}</div>
            </div>
          ))}
        </div>
        {explanation && (
          <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
            className="bg-blue-50 border-2 border-blue-200 rounded-2xl p-4">
            <div className="flex items-center gap-2 mb-2">
              <AlienLogo size={18} blue />
              <span className="text-sm font-bold text-blue-700">AI Analysis</span>
            </div>
            <p className="text-sm text-blue-800 leading-relaxed whitespace-pre-wrap">{explanation}</p>
          </motion.div>
        )}
        <div>
          <div className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-2">Jobs</div>
          <div className="space-y-2">
            {jobs.length === 0 ? (
              <div className="text-center py-10 text-stone-400 text-sm">
                {build.status === 'running' ? <div className="flex flex-col items-center gap-2"><Loader2 className="w-5 h-5 animate-spin text-orange-400" /><span>Running…</span></div> : 'No jobs found'}
              </div>
            ) : jobs.map(job => (
              <div key={job.id} className="bg-[#fffefb] border-2 border-stone-200 rounded-xl p-3 flex items-center gap-3">
                <StatusBadge status={job.status} />
                <span className="text-sm font-semibold text-stone-700 flex-1">{job.name}</span>
                <span className="text-xs text-stone-400 font-mono">{job.duration_ms ? formatDuration(job.duration_ms) : '—'}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-xs font-bold text-stone-400 uppercase tracking-widest mb-2">Logs</div>
          <div className="bg-stone-900 border-2 border-stone-700 rounded-xl p-4 h-52 overflow-y-auto">
            {build.status === 'running' ? (
              <div className="text-orange-400">▶ Pipeline running…</div>
            ) : (
              <div className="space-y-0.5">
                <div className="text-emerald-400">✓ Checkout repository</div>
                <div className="text-blue-400">$ npm ci</div>
                <div className="text-stone-400">added 847 packages in 2.3s</div>
                <div className="text-blue-400">$ npm test</div>
                <div className="text-emerald-400">✓ 142 tests passed (3.2s)</div>
                <div className="text-blue-400">$ npm run build</div>
                <div className="text-emerald-400">✓ Build complete → .next/ (2.1MB)</div>
                <div className={build.status === 'success' ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
                  {build.status === 'success' ? '✓ Pipeline completed successfully' : '✗ Pipeline failed'}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Secrets Panel ─────────────────────────────────────────────────────────────
function SecretsPanel({ project }: { project: Project }) {
  const [secrets, setSecrets] = useState<string[]>([]);
  const [newName, setNewName] = useState(''); const [newValue, setNewValue] = useState(''); const [adding, setAdding] = useState(false);
  useEffect(() => { api.listSecrets(project.id).then(setSecrets).catch(() => setSecrets(['GITHUB_TOKEN', 'NPM_TOKEN'])); }, [project.id]);
  const add = async () => {
    if (!newName || !newValue) return; setAdding(true);
    try { await api.setSecret(project.id, newName, newValue); setSecrets(s => [...s, newName]); setNewName(''); setNewValue(''); }
    catch { setSecrets(s => [...s, newName]); } finally { setAdding(false); }
  };
  return (
    <div className="max-w-xl space-y-5">
      <div><h2 className="text-base font-bold text-stone-800">Secrets</h2><p className="text-xs text-stone-400 mt-0.5">Stored encrypted. Available as env vars in your pipeline.</p></div>
      <div className="bg-[#fffefb] border-2 border-stone-200 rounded-2xl overflow-hidden">
        {secrets.length === 0 ? <div className="py-10 text-center text-stone-400 text-sm">No secrets yet</div>
          : secrets.map(name => (
            <div key={name} className="flex items-center gap-3 px-4 py-3 border-b-2 border-stone-100 last:border-b-0">
              <Lock className="w-4 h-4 text-stone-300" /><span className="text-sm font-mono text-stone-700 flex-1">{name}</span>
              <span className="text-xs text-stone-300">••••••••</span>
            </div>
          ))}
      </div>
      <div className="bg-[#fffefb] border-2 border-stone-200 rounded-2xl p-4">
        <div className="text-xs font-bold text-stone-500 mb-3 uppercase tracking-wider">Add Secret</div>
        <div className="flex gap-2">
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="SECRET_NAME"
            className="flex-1 bg-stone-50 border-2 border-stone-200 rounded-xl px-3 py-2 text-sm font-mono focus:outline-none focus:border-orange-300 transition-colors" />
          <input value={newValue} onChange={e => setNewValue(e.target.value)} type="password" placeholder="value"
            className="flex-1 bg-stone-50 border-2 border-stone-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:border-orange-300 transition-colors" />
          <button onClick={add} disabled={!newName || !newValue || adding}
            className="px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-600 disabled:opacity-40 text-sm font-semibold text-white transition-colors">
            {adding ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Settings Panel ────────────────────────────────────────────────────────────
function SettingsPanel({ project }: { project: Project }) {
  const [models, setModels] = useState<any[]>([]);
  useEffect(() => { api.listModels().then(setModels).catch(() => setModels([
    { provider: 'anthropic', model: 'claude-3-5-sonnet-20241022', name: 'Claude 3.5 Sonnet', available: false },
    { provider: 'openai', model: 'gpt-4o', name: 'GPT-4o', available: false },
    { provider: 'ollama', model: 'llama3.2', name: 'Llama 3.2 (Local)', available: true },
  ])); }, []);
  return (
    <div className="max-w-xl space-y-5">
      <div><h2 className="text-base font-bold text-stone-800">Settings</h2><p className="text-xs text-stone-400 mt-0.5">{project.name}</p></div>
      <div className="bg-[#fffefb] border-2 border-stone-200 rounded-2xl overflow-hidden">
        <div className="px-4 py-3 border-b-2 border-stone-100 flex items-center gap-2">
          <AlienLogo size={16} blue /><span className="text-sm font-bold text-stone-700">AI Models</span>
        </div>
        <div className="p-4 space-y-2">
          {models.map(m => (
            <div key={m.model} className="flex items-center justify-between py-1.5 border-b-2 border-stone-50 last:border-b-0">
              <div><div className="text-sm font-semibold text-stone-700">{m.name}</div><div className="text-xs text-stone-400">{m.provider} · {m.model}</div></div>
              <span className={cn('text-xs px-2 py-0.5 rounded-full border font-semibold', m.available ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-stone-100 text-stone-400 border-stone-200')}>
                {m.available ? 'Ready' : 'No key'}
              </span>
            </div>
          ))}
          <p className="text-xs text-stone-400 pt-2">Set keys via env vars: <code className="bg-stone-100 px-1 rounded text-[11px]">ANTHROPIC_API_KEY</code>, <code className="bg-stone-100 px-1 rounded text-[11px]">OPENAI_API_KEY</code></p>
        </div>
      </div>
      <div className="bg-[#fffefb] border-2 border-stone-200 rounded-2xl p-4 space-y-2.5">
        <div className="text-xs font-bold text-stone-500 uppercase tracking-wider mb-3">Project Details</div>
        {[['Repo', project.repo_url], ['Language', project.language], ['Framework', project.framework], ['Branch', project.branch]].map(([l, v]) => (
          <div key={l} className="flex justify-between items-center text-sm">
            <span className="text-stone-400 font-medium">{l}</span>
            <span className="font-mono text-xs text-stone-600 max-w-[200px] truncate">{v || '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main App ─────────────────────────────────────────────────────────────────
export default function DashboardPage() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [builds, setBuilds] = useState<Build[]>([]);
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [selectedBuild, setSelectedBuild] = useState<Build | null>(null);
  const [view, setView] = useState<View>('dashboard');
  const [showAI, setShowAI] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);
  const [showAddFolder, setShowAddFolder] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState('');
  const [triggering, setTriggering] = useState(false);
  const [apiAvailable, setApiAvailable] = useState(false);

  const loadAll = useCallback(async () => {
    try {
      const [ps, st] = await Promise.all([api.listProjects(), api.getStats()]);
      setProjects(ps || []); setStats(st); setApiAvailable(true);
    } catch {
      setProjects(demoProjects as Project[]);
      setStats({ total_projects: 3, total_builds: 127, success_rate: 94.2, avg_duration_ms: 87000, running_builds: 1 });
    }
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);
  useEffect(() => {
    if (selectedProject) api.listBuilds(selectedProject.id).then(setBuilds).catch(() => setBuilds(demoBuilds as Build[]));
  }, [selectedProject]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); setCommandOpen(o => !o); }
      if (e.key === 'Escape') setCommandOpen(false);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const triggerBuild = async (projectId: string) => {
    setTriggering(true);
    try {
      await api.triggerBuild(projectId, { trigger: 'manual' });
      if (selectedProject?.id === projectId) setBuilds(await api.listBuilds(projectId));
    } catch {
      const nb: Build = { id: `b-${Date.now()}`, project_id: projectId, number: builds.length + 1, status: 'running', branch: 'main', commit: Math.random().toString(16).slice(2,9), commit_message: 'Manual trigger', author: 'you', duration_ms: 0, started_at: new Date().toISOString(), finished_at: null, created_at: new Date().toISOString(), trigger: 'manual', ai_insight: '' };
      setBuilds(b => [nb, ...b]);
      setTimeout(() => setBuilds(b => b.map(x => x.id === nb.id ? { ...x, status: 'success', duration_ms: 87000 } : x)), 3500);
    } finally { setTriggering(false); }
  };

  const addProject = async (data: any) => {
    let proj: Project;
    try { proj = await api.createProject(data); } catch {
      proj = { ...data, id: `proj-${Date.now()}`, status: 'active', health_score: 100, language: 'JavaScript/TypeScript', framework: 'Node.js', created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    }
    setProjects(ps => [proj, ...ps]);
    if (data.folderId) {
      setFolders(fs => fs.map(f => f.id === data.folderId ? { ...f, projects: [...f.projects, proj] } : f));
    }
  };

  const addFolder = (name: string) => {
    setFolders(fs => [...fs, { id: `folder-${Date.now()}`, name, expanded: true, projects: [] }]);
  };

  const toggleFolder = (id: string) => setFolders(fs => fs.map(f => f.id === id ? { ...f, expanded: !f.expanded } : f));

  // Projects not in any folder
  const unfoldered = projects.filter(p => !folders.some(f => f.projects.find(fp => fp.id === p.id)));

  const navItems = [
    { id: 'dashboard', label: 'Overview', icon: Activity },
    { id: 'builds', label: 'Builds', icon: Zap },
    { id: 'pipeline', label: 'Pipeline', icon: Layers },
    { id: 'secrets', label: 'Secrets', icon: Lock },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  const aiCtx = selectedProject
    ? `Project: ${selectedProject.name} (${selectedProject.language}). Builds: ${builds.slice(0,3).map(b => `#${b.number} ${b.status}`).join(', ')}`
    : 'No project selected';

  const selectProject = (p: Project) => { setSelectedProject(p); setView('dashboard'); setSelectedBuild(null); };

  return (
    <div className="flex h-screen bg-[#f5f2ed] overflow-hidden">

      {/* ══ SIDEBAR ══════════════════════════════════════════════════════════════ */}
      <div className="w-[232px] flex-shrink-0 flex flex-col bg-[#faf7f2] border-r-2 border-stone-200">

        {/* Logo */}
        <div className="flex items-center gap-3 px-4 py-4 border-b-2 border-stone-200">
          <AlienLogo size={38} />
          <div>
            <div className="text-[18px] font-bold text-stone-800 leading-tight">
              Callahan
            </div>
            <div className="text-[9px] font-bold text-orange-500 tracking-[0.14em] uppercase">CI/CD Platform</div>
          </div>
        </div>

        {/* ── Top-level actions ── */}
        <div className="px-3 pt-3 pb-2 space-y-1.5">
          <button onClick={() => setShowAI(!showAI)}
            className={cn('w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-semibold transition-all border-2',
              showAI ? 'bg-blue-50 border-blue-200 text-blue-700' : 'bg-white border-stone-200 text-stone-600 hover:border-blue-200 hover:bg-blue-50/50 hover:text-blue-700')}>
            <AlienLogo size={16} blue />
            Callahan AI
            {showAI && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-400 status-dot-running" />}
          </button>

          <button onClick={() => setCommandOpen(true)}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl bg-white border-2 border-stone-200 text-stone-500 hover:border-stone-300 hover:text-stone-700 text-sm font-semibold transition-all">
            <Command className="w-3.5 h-3.5" />
            Command
            <span className="ml-auto text-[10px] bg-stone-100 px-1.5 py-0.5 rounded-md font-mono">⌘K</span>
          </button>
        </div>

        <div className="mx-3 border-b-2 border-stone-200 my-1" />

        {/* ── Projects section ── */}
        <div className="flex-1 overflow-y-auto px-3 py-2">
          <div className="flex items-center justify-between px-1 mb-2">
            <span className="text-[10px] font-bold text-stone-400 uppercase tracking-widest">Projects</span>
            <div className="flex items-center gap-1">
              <button onClick={() => setShowAddFolder(true)} title="New folder"
                className="p-1 hover:bg-stone-200 rounded-lg transition-colors" >
                <FolderOpen className="w-3.5 h-3.5 text-stone-400" />
              </button>
              <button onClick={() => setShowAddProject(true)} title="Add project"
                className="p-1 hover:bg-stone-200 rounded-lg transition-colors">
                <Plus className="w-3.5 h-3.5 text-stone-400" />
              </button>
            </div>
          </div>

          {/* Folders */}
          {folders.map(folder => (
            <div key={folder.id} className="mb-1">
              <button onClick={() => toggleFolder(folder.id)}
                className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-stone-100 transition-colors group">
                <ChevronDown className={cn('w-3 h-3 text-stone-400 transition-transform', !folder.expanded && '-rotate-90')} />
                {folder.expanded ? <FolderOpen className="w-3.5 h-3.5 text-orange-400" /> : <Folder className="w-3.5 h-3.5 text-orange-400" />}
                <span className="text-[12px] font-semibold text-stone-600 flex-1 text-left">{folder.name}</span>
                <span className="text-[10px] text-stone-400">{folder.projects.length}</span>
              </button>
              <AnimatePresence>
                {folder.expanded && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                    className="ml-4 overflow-hidden">
                    {folder.projects.map(p => <ProjectItem key={p.id} project={p} selected={selectedProject?.id === p.id} onClick={() => selectProject(p)} />)}
                    <button onClick={() => setShowAddProject(true)}
                      className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-stone-400 hover:text-orange-500 hover:bg-orange-50 transition-colors text-xs">
                      <Plus className="w-3 h-3" /> Add project
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          ))}

          {/* Unfoldered projects */}
          <div className="space-y-0.5">
            {unfoldered.map(p => <ProjectItem key={p.id} project={p} selected={selectedProject?.id === p.id} onClick={() => selectProject(p)} />)}
          </div>

          {projects.length === 0 && (
            <button onClick={() => setShowAddProject(true)}
              className="w-full flex items-center gap-2 px-2 py-2 rounded-xl border-2 border-dashed border-stone-300 text-stone-400 hover:border-orange-300 hover:text-orange-500 transition-colors text-xs font-semibold mt-1">
              <Plus className="w-3.5 h-3.5" /> Connect repository
            </button>
          )}
        </div>

        <div className="mx-3 border-b-2 border-stone-200" />

        {/* ── Per-project nav ── */}
        {selectedProject && (
          <div className="px-3 py-2 space-y-0.5">
            {navItems.map(({ id, label, icon: Icon }) => (
              <button key={id} onClick={() => setView(id as View)}
                className={cn('w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-left transition-all text-[13px] font-semibold border-2',
                  view === id ? 'bg-orange-50 border-orange-200 text-orange-700' : 'border-transparent text-stone-500 hover:bg-stone-100 hover:text-stone-700')}>
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </div>
        )}

        {/* ── Status indicator ── */}
        <div className="px-4 py-3 border-t-2 border-stone-200">
          <div className={cn('flex items-center gap-2 text-[10px] font-semibold', apiAvailable ? 'text-emerald-600' : 'text-amber-600')}>
            <div className={cn('w-1.5 h-1.5 rounded-full', apiAvailable ? 'bg-emerald-500' : 'bg-amber-400')} />
            {apiAvailable ? 'API connected' : 'Demo mode'}
          </div>
        </div>
      </div>

      {/* ══ MAIN CONTENT ════════════════════════════════════════════════════════ */}
      <div className="flex-1 flex min-w-0">
        <div className="flex-1 flex flex-col min-w-0">

          {/* Top bar */}
          <div className="flex items-center justify-between h-14 px-6 border-b-2 border-stone-200 bg-[#fffefb] flex-shrink-0">
            <div className="flex items-center gap-2 min-w-0 text-sm">
              {selectedProject ? (
                <>
                  <span>{getProviderIcon(selectedProject.provider)}</span>
                  <span className="font-bold text-stone-700">{selectedProject.name}</span>
                  <ChevronRight className="w-4 h-4 text-stone-300" />
                  <span className="text-stone-400 capitalize">{view}</span>
                  {selectedBuild && <><ChevronRight className="w-4 h-4 text-stone-300" /><span className="text-stone-400">Build #{selectedBuild.number}</span></>}
                </>
              ) : (
                <span className="font-bold text-stone-600">Welcome to Callahan</span>
              )}
            </div>
            <div className="flex items-center gap-2">
              {selectedProject && (
                <button onClick={() => triggerBuild(selectedProject.id)} disabled={triggering}
                  className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-orange-500 hover:bg-orange-600 disabled:opacity-50 text-sm font-bold text-white transition-colors shadow-sm">
                  {triggering ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-white" />}
                  Run Build
                </button>
              )}
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto">
            <AnimatePresence mode="wait">

              {/* Welcome */}
              {!selectedProject && (
                <motion.div key="welcome" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                  className="flex flex-col items-center justify-center h-full p-8 text-center">
                  {/* Big alien logo in the centre */}
                  <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 120 }}
                    className="mb-6">
                    <AlienLogo size={88} blue />
                  </motion.div>
                  <h1 className="text-3xl font-bold text-stone-800 mb-2">
                    Callahan CI
                  </h1>
                  <p className="text-stone-400 max-w-sm mb-8 text-sm leading-relaxed">
                    AI-native, serverless CI/CD. Connect a repository to get started — your AI co-pilot handles the rest.
                  </p>
                  <button onClick={() => setShowAddProject(true)}
                    className="flex items-center gap-2 px-6 py-3 rounded-2xl bg-orange-500 hover:bg-orange-600 font-bold text-white transition-colors shadow-md text-sm">
                    <Plus className="w-5 h-5" /> Connect Repository
                  </button>
                  <div className="grid grid-cols-3 gap-4 mt-12 max-w-xl">
                    {[
                      { icon: AlienLogo, title: 'AI-Native', desc: 'Claude, GPT-4o, Llama built-in', accent: 'border-blue-200 bg-blue-50', badge: 'text-blue-600' },
                      { icon: Zap, title: 'Serverless', desc: 'Ephemeral containers, <2s start', accent: 'border-orange-200 bg-orange-50', badge: 'text-orange-600' },
                      { icon: Shield, title: 'Security', desc: 'Trivy, Semgrep, SBOM included', accent: 'border-emerald-200 bg-emerald-50', badge: 'text-emerald-600' },
                    ].map(({ icon: Icon, title, desc, accent, badge }) => (
                      <div key={title} className={cn('border-2 rounded-2xl p-4 text-left', accent)}>
                        <div className={cn('text-sm font-bold mb-1', badge)}>{title}</div>
                        <div className="text-xs text-stone-500">{desc}</div>
                      </div>
                    ))}
                  </div>
                </motion.div>
              )}

              {/* Dashboard */}
              {selectedProject && view === 'dashboard' && !selectedBuild && (
                <motion.div key="dash" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="p-6 space-y-5">
                  {stats && (
                    <div className="grid grid-cols-4 gap-4">
                      <StatCard label="Total Builds" value={stats.total_builds} icon={Zap} color="bg-orange-100 text-orange-600" />
                      <StatCard label="Success Rate" value={`${stats.success_rate.toFixed(1)}%`} icon={TrendingUp} color="bg-emerald-100 text-emerald-600" />
                      <StatCard label="Avg Duration" value={formatDuration(stats.avg_duration_ms)} icon={Clock} color="bg-blue-100 text-blue-600" />
                      <StatCard label="Running" value={stats.running_builds} icon={Activity} color="bg-amber-100 text-amber-600" />
                    </div>
                  )}
                  <div className="bg-[#fffefb] border-2 border-stone-200 rounded-2xl overflow-hidden">
                    <div className="flex items-center justify-between px-5 py-3 border-b-2 border-stone-100">
                      <div className="flex items-center gap-2"><Zap className="w-4 h-4 text-orange-400" /><span className="text-sm font-bold text-stone-700">Recent Builds</span></div>
                      <button onClick={() => setView('builds')} className="text-xs text-stone-400 hover:text-orange-500 transition-colors flex items-center gap-1 font-semibold">
                        View all <ArrowUpRight className="w-3 h-3" />
                      </button>
                    </div>
                    {builds.length === 0 ? (
                      <div className="flex flex-col items-center py-14 text-stone-400">
                        <Terminal className="w-8 h-8 mb-3 opacity-30" />
                        <p className="text-sm font-medium">No builds yet</p>
                        <p className="text-xs mt-1">Click Run Build to get started</p>
                      </div>
                    ) : builds.slice(0, 8).map(build => <BuildRow key={build.id} build={build} onClick={() => setSelectedBuild(build)} />)}
                  </div>
                  <div className="bg-[#fffefb] border-2 border-stone-200 rounded-2xl p-4">
                    <div className="flex items-center gap-2 mb-3">
                      <AlienLogo size={16} blue /><span className="text-sm font-bold text-stone-700">AI Insights</span>
                    </div>
                    <div className="space-y-2">
                      {[
                        { icon: TrendingUp, color: 'text-emerald-500', text: `Pipeline health is ${selectedProject.health_score}%. Performing well.` },
                        { icon: Zap, color: 'text-orange-500', text: 'Cache hit rate 94%. Build times improved 23% this week.' },
                        { icon: Shield, color: 'text-blue-500', text: 'Last scan: 0 critical vulnerabilities. 2 medium issues acknowledged.' },
                      ].map(({ icon: Icon, color, text }, i) => (
                        <div key={i} className="flex items-start gap-2.5 text-sm text-stone-500">
                          <Icon className={cn('w-4 h-4 flex-shrink-0 mt-0.5', color)} />{text}
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              )}

              {selectedProject && selectedBuild && (
                <motion.div key="build-detail" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
                  <BuildDetail build={selectedBuild} onBack={() => setSelectedBuild(null)} />
                </motion.div>
              )}

              {selectedProject && view === 'builds' && !selectedBuild && (
                <motion.div key="builds" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="p-6">
                  <div className="bg-[#fffefb] border-2 border-stone-200 rounded-2xl overflow-hidden">
                    <div className="px-5 py-3 border-b-2 border-stone-100">
                      <span className="text-sm font-bold text-stone-700">All Builds — {selectedProject.name}</span>
                    </div>
                    {builds.length === 0 ? <div className="py-16 text-center text-stone-400 text-sm">No builds yet</div>
                      : builds.map(b => <BuildRow key={b.id} build={b} onClick={() => setSelectedBuild(b)} />)}
                  </div>
                </motion.div>
              )}

              {selectedProject && view === 'pipeline' && (
                <motion.div key="pipeline" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="h-full">
                  <PipelineEditor project={selectedProject} />
                </motion.div>
              )}

              {selectedProject && view === 'secrets' && (
                <motion.div key="secrets" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="p-6">
                  <SecretsPanel project={selectedProject} />
                </motion.div>
              )}

              {selectedProject && view === 'settings' && (
                <motion.div key="settings" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="p-6">
                  <SettingsPanel project={selectedProject} />
                </motion.div>
              )}

            </AnimatePresence>
          </div>
        </div>

        {/* AI Panel */}
        <AnimatePresence>
          {showAI && <AIChat key="ai" onClose={() => setShowAI(false)} context={aiCtx} />}
        </AnimatePresence>
      </div>

      {/* Modals */}
      <AnimatePresence>
        {showAddProject && <AddProjectModal key="addproj" onClose={() => setShowAddProject(false)} onAdd={addProject} folders={folders} />}
        {showAddFolder && <AddFolderModal key="addfolder" onClose={() => setShowAddFolder(false)} onAdd={addFolder} />}
      </AnimatePresence>

      {/* Command Palette */}
      <AnimatePresence>
        {commandOpen && (
          <div className="fixed inset-0 bg-black/25 backdrop-blur-sm z-50 flex items-start justify-center pt-32 p-4">
            <motion.div initial={{ opacity: 0, scale: 0.96, y: -8 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }}
              className="bg-[#fffefb] border-2 border-stone-300 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 border-b-2 border-stone-200">
                <Search className="w-4 h-4 text-stone-400" />
                <input autoFocus value={commandQuery} onChange={e => setCommandQuery(e.target.value)}
                  onKeyDown={e => e.key === 'Escape' && setCommandOpen(false)}
                  placeholder="Type a command..."
                  className="flex-1 bg-transparent text-sm focus:outline-none text-stone-700 placeholder:text-stone-400" />
                <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-stone-100 text-stone-400 border border-stone-200 font-mono">ESC</kbd>
              </div>
              <div className="py-2 max-h-72 overflow-y-auto">
                {[
                  { icon: Plus, label: 'Connect Repository', action: () => { setShowAddProject(true); setCommandOpen(false); } },
                  { icon: FolderOpen, label: 'New Folder', action: () => { setShowAddFolder(true); setCommandOpen(false); } },
                  { icon: Play, label: 'Trigger Build', action: () => { selectedProject && triggerBuild(selectedProject.id); setCommandOpen(false); } },
                  { icon: Sparkles, label: 'Open AI Assistant', action: () => { setShowAI(true); setCommandOpen(false); } },
                  { icon: Layers, label: 'Edit Pipeline', action: () => { setView('pipeline'); setCommandOpen(false); } },
                  { icon: Lock, label: 'Manage Secrets', action: () => { setView('secrets'); setCommandOpen(false); } },
                  { icon: Settings, label: 'Settings', action: () => { setView('settings'); setCommandOpen(false); } },
                ].filter(item => !commandQuery || item.label.toLowerCase().includes(commandQuery.toLowerCase()))
                  .map(({ icon: Icon, label, action }) => (
                    <button key={label} onClick={action}
                      className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-orange-50 transition-colors text-sm text-stone-600 hover:text-stone-800 font-medium">
                      <Icon className="w-4 h-4 text-stone-400" />{label}
                    </button>
                  ))}
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

    </div>
  );
}

// ─── Project Item (sidebar) ───────────────────────────────────────────────────
function ProjectItem({ project: p, selected, onClick }: { project: Project; selected: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick}
      className={cn('w-full flex items-center gap-2 px-2 py-2 rounded-xl text-left transition-all border-2',
        selected ? 'bg-orange-50 border-orange-200 text-stone-800' : 'border-transparent hover:bg-stone-100 text-stone-500 hover:text-stone-800')}>
      <span className="text-sm leading-none flex-shrink-0">{getProviderIcon(p.provider)}</span>
      <div className="flex-1 min-w-0">
        <div className="text-[12px] font-semibold truncate leading-tight">{p.name}</div>
        <div className={cn('text-[10px] leading-tight font-medium', getLanguageColor(p.language))}>{p.language}</div>
      </div>
      <HealthRing score={p.health_score} />
    </button>
  );
}
