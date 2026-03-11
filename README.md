<div align="center">

# 🛸 Callahan CI

**AI-native, serverless CI/CD — local-first, zero cloud required**

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
✓ AI agents built-in: code review, test generation, build debugging
✓ Works with GitHub, GitLab, Bitbucket, Gitea, and any self-hosted Git
```

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| **Serverless execution** | Every job runs in a fresh ephemeral container. Cold start < 2s. |
| **AI Pipeline Architect** | Describe your pipeline in plain English — Callahan writes the YAML. |
| **AI Build Debugger** | Chat with your failing build: "Why did step 3 fail?" |
| **AI Code Reviewer** | Automatic review comments on every PR across all Git providers. |
| **Security built-in** | Trivy, Semgrep, gitleaks, OWASP Dependency-Check — zero config. |
| **Any LLM** | OpenAI, Anthropic Claude, Google Gemini, Groq, Ollama (local), and more. |
| **Project folders** | Organise repos into folders in the sidebar. |
| **Beautiful UI** | Modern, cream-toned dashboard. Light mode. Command palette (⌘K). |
| **Single binary** | Go backend + SQLite. No external database or message queue. |

---

## 🚀 Quick Start

### Option A — Docker (recommended)

```bash
# 1. Install
curl -fsSL https://getcallahan.dev/install.sh | sh

# 2. Start
cd callahan && ./start.sh docker

# 3. Open
open http://localhost:8080
```

Requires: Docker Desktop running on your machine.

---

### Option B — Native (Go + Node)

```bash
# Prerequisites: Go 1.22+, Node.js 18+
git clone https://github.com/callahan-ci/callahan.git
cd callahan

# Start backend
cd backend && go mod tidy && go run ./cmd/callahan &

# Start frontend
cd ../frontend && npm install && npm run dev
```

Open **http://localhost:3000**

---

### Option C — One-liner (curl installer)

```bash
curl -fsSL https://getcallahan.dev | sh
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
Open any failed build → click **AI Explain**. The agent reads your logs and explains what went wrong in plain English with specific fix suggestions.

### Code Reviewer
Automatically posts review comments to GitHub/GitLab PRs on every run. Configure in your `Callahanfile.yaml`:

```yaml
ai:
  review: true
  provider: anthropic
  model: claude-3-5-sonnet-20241022
```

### Security Analyst
Trivy + Semgrep findings are automatically explained in plain English. Critical issues block the pipeline; Callahan suggests remediation steps.

---

## 📝 Callahanfile.yaml

Callahan uses a GitHub Actions-compatible YAML format with AI extensions:

```yaml
name: My App Pipeline
on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: npm ci
      - name: Test
        run: npm test
      - name: AI Code Review    # ← Callahan AI extension
        ai:
          agent: reviewer
          provider: anthropic

  security:
    needs: test
    steps:
      - name: Scan
        uses: callahan/trivy-scan@v1
      - name: AI Triage         # ← explains vulnerabilities
        ai:
          agent: security-analyst

  deploy:
    needs: security
    if: github.ref == 'refs/heads/main'
    steps:
      - name: Deploy to Vercel
        uses: callahan/deploy-vercel@v1
```

Full syntax reference: [docs/callahanfile.md](docs/callahanfile.md)

---

## 🌐 Git Provider Setup

### GitHub
1. Go to **Settings → AI & Integrations**
2. Add a GitHub Personal Access Token (scope: `repo`, `read:org`)
3. Configure webhook URL: `http://your-host:8080/api/v1/webhook/github`

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
│         │  (Ephemeral containers│                   │
│         │   via Docker API)     │                   │
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
  Built with ❤️ by the Callahan community · <a href="https://getcallahan.dev">getcallahan.dev</a>
</div>
