import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

export function timeAgo(date: string): string {
  const seconds = Math.floor((Date.now() - new Date(date).getTime()) / 1000);
  if (seconds < 60)    return `${seconds}s ago`;
  if (seconds < 3600)  return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// Status colours — matches callahanci.com exactly
export function statusStyles(status: string): { dot: string; badge: string; text: string } {
  switch (status) {
    case "success":
      return {
        dot:   "bg-ci-green shadow-[0_0_6px_#00e5a0]",
        badge: "bg-[rgba(0,229,160,0.1)] text-ci-green border border-[rgba(0,229,160,0.2)]",
        text:  "text-ci-green",
      };
    case "running":
      return {
        dot:   "bg-ci-accent shadow-[0_0_6px_#00d4ff] animate-status-pulse",
        badge: "bg-[rgba(0,212,255,0.1)] text-ci-accent border border-[rgba(0,212,255,0.2)]",
        text:  "text-ci-accent",
      };
    case "failed":
      return {
        dot:   "bg-ci-red shadow-[0_0_6px_#ff4455]",
        badge: "bg-[rgba(255,68,85,0.1)] text-ci-red border border-[rgba(255,68,85,0.2)]",
        text:  "text-ci-red",
      };
    case "pending":
      return {
        dot:   "bg-ci-yellow",
        badge: "bg-[rgba(245,197,66,0.1)] text-ci-yellow border border-[rgba(245,197,66,0.2)]",
        text:  "text-ci-yellow",
      };
    case "cancelled":
      return {
        dot:   "bg-ci-text3",
        badge: "bg-[rgba(84,95,114,0.15)] text-ci-text3 border border-[rgba(84,95,114,0.2)]",
        text:  "text-ci-text3",
      };
    default:
      return {
        dot:   "bg-ci-text3",
        badge: "bg-[rgba(84,95,114,0.15)] text-ci-text3 border border-[rgba(84,95,114,0.2)]",
        text:  "text-ci-text3",
      };
  }
}

export function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}
