import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.floor((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
}

export function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  
  if (diff < 60000) return 'Just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

export function getStatusColor(status: string): string {
  switch (status) {
    case 'success': return 'text-emerald-400';
    case 'failed': return 'text-red-400';
    case 'running': return 'text-orange-400';
    case 'pending': return 'text-yellow-400';
    case 'cancelled': return 'text-slate-400';
    default: return 'text-slate-400';
  }
}

export function getStatusBg(status: string): string {
  switch (status) {
    case 'success': return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'failed': return 'bg-red-50 text-red-700 border-red-200';
    case 'running': return 'bg-orange-50 text-orange-700 border-orange-200';
    case 'pending': return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'cancelled': return 'bg-stone-100 text-stone-500 border-stone-200';
    default: return 'bg-stone-100 text-stone-500 border-stone-200';
  }
}

export function getProviderIcon(provider: string): string {
  switch (provider) {
    case 'github': return '🐙';
    case 'gitlab': return '🦊';
    case 'bitbucket': return '🪣';
    case 'gitea': return '☕';
    default: return '📁';
  }
}

export function getLanguageColor(lang: string): string {
  const colors: Record<string, string> = {
    'Go': 'text-cyan-400',
    'Rust': 'text-orange-400',
    'JavaScript/TypeScript': 'text-yellow-400',
    'Python': 'text-blue-400',
    'Java': 'text-red-400',
    'Ruby': 'text-red-500',
    'PHP': 'text-indigo-400',
  };
  return colors[lang] || 'text-slate-400';
}

export function truncateCommit(commit: string): string {
  return commit ? commit.slice(0, 7) : '';
}

// Seed data for demo
export const demoProjects = [
  {
    id: 'proj-1',
    name: 'callahan-ui',
    description: 'The Callahan dashboard frontend',
    repo_url: 'https://github.com/callahan-ci/callahan-ui',
    provider: 'github',
    branch: 'main',
    language: 'JavaScript/TypeScript',
    framework: 'Next.js',
    status: 'active',
    health_score: 98,
    created_at: new Date(Date.now() - 7 * 86400000).toISOString(),
    updated_at: new Date(Date.now() - 3600000).toISOString(),
  },
  {
    id: 'proj-2',
    name: 'callahan-backend',
    description: 'The Callahan API & execution engine',
    repo_url: 'https://github.com/callahan-ci/callahan',
    provider: 'github',
    branch: 'main',
    language: 'Go',
    framework: 'Gin',
    status: 'active',
    health_score: 100,
    created_at: new Date(Date.now() - 7 * 86400000).toISOString(),
    updated_at: new Date(Date.now() - 1800000).toISOString(),
  },
  {
    id: 'proj-3',
    name: 'ml-service',
    description: 'Python ML inference API',
    repo_url: 'https://github.com/myorg/ml-service',
    provider: 'github',
    branch: 'develop',
    language: 'Python',
    framework: 'FastAPI',
    status: 'active',
    health_score: 84,
    created_at: new Date(Date.now() - 14 * 86400000).toISOString(),
    updated_at: new Date(Date.now() - 7200000).toISOString(),
  },
];

export const demoBuilds = [
  { id: 'b1', project_id: 'proj-1', number: 42, status: 'success', branch: 'main', commit: 'a7f3e2c', commit_message: 'feat: add AI chat panel to build view', author: 'alice', duration_ms: 87000, started_at: new Date(Date.now() - 3600000).toISOString(), finished_at: new Date(Date.now() - 3513000).toISOString(), created_at: new Date(Date.now() - 3600000).toISOString(), trigger: 'push', ai_insight: '' },
  { id: 'b2', project_id: 'proj-1', number: 41, status: 'failed', branch: 'feat/pipeline-editor', commit: 'b2c8d1e', commit_message: 'fix: resolve YAML parsing edge cases', author: 'bob', duration_ms: 43000, started_at: new Date(Date.now() - 7200000).toISOString(), finished_at: new Date(Date.now() - 7157000).toISOString(), created_at: new Date(Date.now() - 7200000).toISOString(), trigger: 'pull_request', ai_insight: 'The test suite failed because the YAML parser did not handle multi-line strings correctly. Fix: use block scalars in test fixtures.' },
  { id: 'b3', project_id: 'proj-1', number: 40, status: 'success', branch: 'main', commit: 'c9f0a3b', commit_message: 'chore: upgrade dependencies', author: 'alice', duration_ms: 94000, started_at: new Date(Date.now() - 86400000).toISOString(), finished_at: new Date(Date.now() - 86306000).toISOString(), created_at: new Date(Date.now() - 86400000).toISOString(), trigger: 'push', ai_insight: '' },
];
