const API_BASE = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080/api/v1';

export type Project = {
  id: string;
  name: string;
  description: string;
  repo_url: string;
  provider: string;
  branch: string;
  language: string;
  framework: string;
  status: string;
  health_score: number;
  created_at: string;
  updated_at: string;
};

export type Build = {
  id: string;
  project_id: string;
  number: number;
  status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  branch: string;
  commit: string;
  commit_message: string;
  author: string;
  duration_ms: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  trigger: string;
  ai_insight: string;
};

export type Job = {
  id: string;
  build_id: string;
  name: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number;
  exit_code: number;
};

export type Step = {
  id: string;
  job_id: string;
  name: string;
  status: string;
  command: string;
  log: string;
  duration_ms: number;
  exit_code: number;
};

export type DashboardStats = {
  total_projects: number;
  total_builds: number;
  success_rate: number;
  avg_duration_ms: number;
  running_builds: number;
};

export type LLMModel = {
  provider: string;
  model: string;
  name: string;
  available: boolean;
};

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export const api = {
  // Stats
  getStats: () => request<DashboardStats>('/stats'),

  // Projects
  listProjects: () => request<Project[]>('/projects'),
  createProject: (data: Partial<Project> & { token?: string }) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  getProject: (id: string) => request<Project>(`/projects/${id}`),
  updateProject: (id: string, data: Partial<Project>) =>
    request<Project>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProject: (id: string) =>
    request<void>(`/projects/${id}`, { method: 'DELETE' }),

  // Builds
  listBuilds: (projectId: string) => request<Build[]>(`/projects/${projectId}/builds`),
  triggerBuild: (projectId: string, data?: Partial<Build>) =>
    request<Build>(`/projects/${projectId}/builds`, { method: 'POST', body: JSON.stringify(data || {}) }),
  getBuild: (buildId: string) => request<Build>(`/builds/${buildId}`),
  cancelBuild: (buildId: string) =>
    request<void>(`/builds/${buildId}/cancel`, { method: 'POST' }),

  // Jobs
  listJobs: (buildId: string) => request<Job[]>(`/builds/${buildId}/jobs`),
  listSteps: (jobId: string) => request<Step[]>(`/jobs/${jobId}/steps`),

  // Pipeline
  getPipeline: (projectId: string) => request<{ content: string; language: string; framework: string }>(`/projects/${projectId}/pipeline`),
  updatePipeline: (projectId: string, content: string) =>
    request<{ status: string }>(`/projects/${projectId}/pipeline`, { method: 'PUT', body: JSON.stringify({ content }) }),

  // Secrets
  listSecrets: (projectId: string) => request<string[]>(`/projects/${projectId}/secrets`),
  setSecret: (projectId: string, name: string, value: string) =>
    request<void>(`/projects/${projectId}/secrets`, { method: 'POST', body: JSON.stringify({ name, value }) }),

  // AI
  generatePipeline: (description: string, language: string, framework: string) =>
    request<{ content: string }>('/ai/generate-pipeline', {
      method: 'POST',
      body: JSON.stringify({ description, language, framework }),
    }),
  explainBuild: (buildId: string, logs: string, pipeline: string) =>
    request<{ explanation: string }>('/ai/explain-build', {
      method: 'POST',
      body: JSON.stringify({ build_id: buildId, logs, pipeline }),
    }),
  chat: (messages: Array<{ role: string; content: string }>, context: string) =>
    request<{ response: string }>('/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ raw_messages: messages, context }),
    }),
  listModels: () => request<LLMModel[]>('/ai/models'),

  // WebSocket
  connectWS: (): WebSocket => {
    const wsBase = API_BASE.replace('http://', 'ws://').replace('https://', 'wss://').replace('/api/v1', '');
    return new WebSocket(`${wsBase}/ws`);
  },
};

// ── Page aliases — used by app/page.tsx ─────────────────────────────────────
// These map the simpler names page.tsx uses to the real API methods above.
// Also fixes type mismatches between the two Build type definitions.
export const pageApi = {
  getProjects: () => request<Project[]>('/projects'),
  getBuilds:   () => request<any[]>('/builds'),
  getProjectBuilds: (projectId: string) => request<any[]>(`/projects/${projectId}/builds`),
  triggerBuild: (projectId: string, artifactVersionId?: string) =>
    request<any>(`/projects/${projectId}/builds`, {
      method: 'POST',
      body: JSON.stringify({ artifact_version_id: artifactVersionId ?? '' }),
    }),
  aiChat: (message: string, projectId?: string) =>
    request<{ response?: string; message?: string }>('/ai/chat', {
      method: 'POST',
      body: JSON.stringify({ raw_messages: [{ role: 'user', content: message }], context: '', project_id: projectId ?? '' }),
    }).then(r => ({ message: r.response ?? r.message ?? 'No response from AI.' })),
};
