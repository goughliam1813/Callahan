import { create } from 'zustand';
import { Project, Build, DashboardStats, api } from './api';

interface AppState {
  projects: Project[];
  selectedProject: Project | null;
  builds: Build[];
  stats: DashboardStats | null;
  loading: boolean;
  wsConnected: boolean;
  commandPaletteOpen: boolean;
  
  setProjects: (projects: Project[]) => void;
  setSelectedProject: (project: Project | null) => void;
  setBuilds: (builds: Build[]) => void;
  setStats: (stats: DashboardStats) => void;
  setLoading: (loading: boolean) => void;
  setWSConnected: (connected: boolean) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  
  // Actions
  loadProjects: () => Promise<void>;
  loadStats: () => Promise<void>;
  loadBuilds: (projectId: string) => Promise<void>;
  triggerBuild: (projectId: string) => Promise<Build | null>;
  createProject: (data: Partial<Project> & { token?: string }) => Promise<Project | null>;
  deleteProject: (id: string) => Promise<void>;
}

export const useAppStore = create<AppState>((set, get) => ({
  projects: [],
  selectedProject: null,
  builds: [],
  stats: null,
  loading: false,
  wsConnected: false,
  commandPaletteOpen: false,

  setProjects: (projects) => set({ projects }),
  setSelectedProject: (project) => set({ selectedProject: project }),
  setBuilds: (builds) => set({ builds }),
  setStats: (stats) => set({ stats }),
  setLoading: (loading) => set({ loading }),
  setWSConnected: (wsConnected) => set({ wsConnected }),
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),

  loadProjects: async () => {
    try {
      const projects = await api.listProjects();
      set({ projects: projects || [] });
    } catch (err) {
      console.error('Failed to load projects:', err);
      set({ projects: [] });
    }
  },

  loadStats: async () => {
    try {
      const stats = await api.getStats();
      set({ stats });
    } catch (err) {
      console.error('Failed to load stats:', err);
    }
  },

  loadBuilds: async (projectId: string) => {
    try {
      const builds = await api.listBuilds(projectId);
      set({ builds: builds || [] });
    } catch (err) {
      console.error('Failed to load builds:', err);
      set({ builds: [] });
    }
  },

  triggerBuild: async (projectId: string) => {
    try {
      const build = await api.triggerBuild(projectId, { trigger: 'manual' });
      // Refresh builds
      await get().loadBuilds(projectId);
      return build;
    } catch (err) {
      console.error('Failed to trigger build:', err);
      return null;
    }
  },

  createProject: async (data) => {
    try {
      const project = await api.createProject(data);
      await get().loadProjects();
      return project;
    } catch (err) {
      console.error('Failed to create project:', err);
      return null;
    }
  },

  deleteProject: async (id: string) => {
    try {
      await api.deleteProject(id);
      const { selectedProject, projects } = get();
      if (selectedProject?.id === id) {
        set({ selectedProject: null, builds: [] });
      }
      set({ projects: projects.filter(p => p.id !== id) });
    } catch (err) {
      console.error('Failed to delete project:', err);
    }
  },
}));
