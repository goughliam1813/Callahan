<div align="center">

# 🛸 Callahan CI

**AI-native, self-hosted CI/CD — local-first, zero cloud required**

![Version](https://img.shields.io/badge/version-1.1.0-blue.svg)

[![License: MIT](https://img.shields.io/badge/License-MIT-orange.svg)](LICENSE)
[![Go Version](https://img.shields.io/badge/Go-1.22+-00ADD8.svg)](https://go.dev)
[![Next.js](https://img.shields.io/badge/Next.js-15-black.svg)](https://nextjs.org)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

[Quick Start](#-quick-start) · [Features](#-features) · [Configuration](#-configuration) · [AI Agents](#-ai-agents) · [Contributing](#-contributing)

</div>

---

Callahan is an open-source CI/CD platform that runs entirely on your machine. Think Jenkins + GitHub Actions + an AI co-pilot — all in a single binary, no cloud account required.

```
✓ First pipeline running in under 5 minutes
✓ No Kubernetes, no cloud bill, no plugin hell
✓ AI agents built-in: code review, security scanning, build debugging
✓ Works with GitHub, GitLab, Bitbucket, Gitea, and any self-hosted Git
```

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| **Local-first execution** | Runs directly on your machine — no agents, no VMs. Docker container mode coming soon. |
| **AI Pipeline Architect** | Describe your pipeline in plain English — Callahan writes the YAML. |
| **AI Build Debugger** | Click **Explain** on any failed step to get an instant AI explanation of exactly what went wrong. |
| **AI Code Reviewer** | Automatic code review on every build — runs as a job card with severity, findings, and fix suggestions. |
| **Security built-in** | AI-powered security scanning on every build. Supports Trivy and Semgrep if installed. |
| **Environments & Deployments** | Deploy to dev/test/staging/prod from the Builds view. Each deployment has its own logs. |
| **Any LLM** | OpenAI, Anthropic Claude, Groq, Ollama (local), and more. Switch provider from the UI. |
| **Project folders** | Organise repos into folders in the sidebar. |
| **Version History** | Automatic SemVer tagging on every successful build with full changelog timeline. |
| **Beautiful UI** | Modern dark dashboard with build history, expandable job cards, and command palette (⌘K). |
| **Single binary** | Go backend + SQLite. No external database or message queue. |

---

## 🚀 Quick Start

### Option A — From source (recommended)

```bash
# Prerequisites: Go 1.22+, Node.js 18+
git clone https://github.com/goughliam1813/Callahan.git
cd Callahan

# Terminal 1 — Backend
cd backend && go mod tidy && go run ./cmd/callahan

# Terminal 2 — Frontend
cd frontend && npm install && npm run dev
```

Open **http://localhost:3000**

---

### Option B — Docker Compose

```bash
git clone https://github.com/goughliam1813/Callahan.git
cd Callahan
docker compose up --build
```

Open **http://localhost:8080**

---

### Option C — One-liner

```bash
git clone https://github.com/goughliam1813/Callahan.git && cd Callahan/backend && go run ./cmd/callahan
```

---

## 📁 Project Structure

```
callahan/
├── backend/                  # Go API server
│   ├── cmd/callahan/         # Entry point
│   ├── internal/
│   │   ├── api/              # REST + WebSocket handlers
│   │   ├── llm/              # Unified LLM client (OpenAI/Anthropic/Ollama)
│   │   ├── pipeline/         # YAML parser + executor
│   │   └── storage/          # SQLite store
│   └── pkg/
│       ├── config/           # Env-based configuration
│       └── models/           # Shared types
├── frontend/                 # Next.js 15 dashboard
│   ├── app/                  # App router pages
│   └── lib/                  # API client, store, utilities
├── examples/                 # Callahanfile.yaml for 5 languages
│   ├── nextjs/
│   ├── python-fastapi/
│   ├── go/
│   ├── rust/
│   └── java-spring/
├── docs/                     # Documentation
├── docker-compose.yml
├── Dockerfile
└── start.sh                  # Smart launcher
```

---

## ⚙️ Configuration

Copy `.env.example` to `.env` and set your values:

```bash
cp .env.example .env
```

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | API server port | `8080` |
| `DB_PATH` | SQLite database path | `./callahan.db` |
| `ANTHROPIC_API_KEY` | Claude API key (optional) | — |
| `OPENAI_API_KEY` | OpenAI API key (optional) | — |
| `GROQ_API_KEY` | Groq API key (optional) | — |
| `OLLAMA_URL` | Local Ollama endpoint | `http://localhost:11434` |
| `DEFAULT_LLM_PROVIDER` | Which LLM to use first | `anthropic` |
| `DOCKER_SOCK` | Docker socket path | `/var/run/docker.sock` |
| `DATA_DIR` | Artifact storage directory | `./data` |

**No LLM key?** Callahan falls back to Ollama (local models) automatically. AI features are disabled gracefully if no model is available.

---

## 🤖 AI Agents

### Pipeline Architect
Generate a full `Callahanfile.yaml` from natural language:

```
"Build my Next.js app, run Playwright E2E tests, scan with Trivy,
 and deploy to Vercel on green PRs"
```

### Build Debugger
Open any failed build → click **Explain** on the failed step. The agent reads that step's output and explains exactly what went wrong with specific fix suggestions.

### Code Reviewer
Runs an AI code review on every successful build. Results appear as expandable job cards with severity, findings, and fix suggestions. Enable in your `Callahanfile.yaml`:

```yaml
ai:
  review: true
  security-scan: true
```

### Security Analyst
AI-powered source code security analysis on every build. Uses Trivy and Semgrep if installed, or runs AI-only scanning out of the box. Findings are shown as expandable job cards with severity ratings and fix suggestions.

---

## 📝 Callahanfile.yaml

Callahan uses a GitHub Actions-compatible YAML format with AI extensions:

```yaml
name: my-app
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: local
    steps:
      - name: Install
        run: npm ci
      - name: Test
        run: npm test
  build:
    runs-on: local
    needs: [test]
    steps:
      - name: Build
        run: npm run build

ai:
  review: true            # AI code review after every build
  security-scan: true     # AI security analysis after every build
  explain-failures: true  # AI explains failed steps automatically
```

---

## 🌐 Git Provider Setup

### GitHub
1. Click **+** in the sidebar to add a project
2. Paste your GitHub repo URL
3. Add a Personal Access Token (scope: `repo`) — stored as a project secret called `GIT_TOKEN`
4. Click **Connect** — Callahan auto-detects your language

### GitLab / Bitbucket / Gitea
Same flow — Callahan auto-detects the provider from the repo URL.

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Callahan Node                      │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐ │
│  │ Next.js  │  │  Go API  │  │  LLM Client       │ │
│  │ Dashboard│  │  + WS    │  │  (OpenAI/Claude/  │ │
│  │ :3000    │  │  :8080   │  │   Ollama)         │ │
│  └──────────┘  └────┬─────┘  └───────────────────┘ │
│                     │                               │
│              ┌──────▼──────┐                        │
│              │   SQLite    │                        │
│              │   + WAL     │                        │
│              └──────┬──────┘                        │
│                     │                               │
│         ┌───────────▼───────────┐                   │
│         │  Pipeline Executor    │                   │
│         │  (Local execution,    │                   │
│         │   Docker coming soon) │                   │
│         └───────────────────────┘                   │
└─────────────────────────────────────────────────────┘
```

---

## 🛠️ Development

```bash
# Backend (Go)
cd backend
go mod tidy
go run ./cmd/callahan

# Frontend (Next.js)
cd frontend
npm install
npm run dev        # http://localhost:3000

# Run tests
cd backend && go test ./...
cd frontend && npm test

# Build for production
cd frontend && npm run build
cd backend && go build -o callahan ./cmd/callahan
```

---

## 📦 Supported Languages

Callahan auto-detects and configures runners for:

`Node.js` · `Python` · `Go` · `Rust` · `Java` · `.NET` · `PHP` · `Ruby` · `Elixir` · `Swift`

---


## ⚠️ Disclaimer

Callahan CI is provided **"as is"** without warranty of any kind. The authors are not liable for any damages arising from the use of this software. See [LICENSE](LICENSE) for full terms.

## 🤝 Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

1. Fork the repo
2. Create a branch: `git checkout -b feature/my-feature`
3. Make your changes and add tests
4. Open a PR — Callahan will review it automatically 🛸

---

## 📄 License

MIT — see [LICENSE](LICENSE). Free for personal and commercial use.

---

<div align="center">
  Built with ❤️ by the Callahan community · <a href="https://callahanci.com">callahanci.com</a>
</div>
