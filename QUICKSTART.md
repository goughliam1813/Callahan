# 🛸 Callahan CI — Quick Start

Get your first pipeline running in under 5 minutes.

---

## 1. Install

**Mac / Linux:**
```bash
curl -fsSL https://getcallahan.dev | sh
cd callahan
```

**Or clone directly:**
```bash
git clone https://github.com/callahan-ci/callahan.git
cd callahan
```

---

## 2. Start

```bash
chmod +x start.sh

./start.sh          # auto-detect (Docker if running, else Go dev mode)
./start.sh docker   # requires Docker Desktop to be open
./start.sh dev      # requires Go 1.22+ and Node.js 18+
```

> **Mac users:** If using `./start.sh docker`, open Docker Desktop from Applications first and wait for the whale icon to appear in your menu bar.

---

## 3. Open the dashboard

| Mode | URL |
|------|-----|
| Docker | http://localhost:8080 |
| Dev (frontend) | http://localhost:3000 |
| Dev (API only) | http://localhost:8080/api/v1/stats |

---

## 4. Connect your first repo

1. Click **+ Connect Repository** (or press `⌘K` → "Connect Repository")
2. Paste your GitHub/GitLab/Bitbucket repo URL
3. Add a Personal Access Token if the repo is private
4. Click **Connect Repo** — Callahan auto-detects your language and stack

---

## 5. Run your first build

Click **Run Build** in the top-right corner. Callahan will:

1. Pull your repo
2. Detect the language and run the appropriate commands
3. Stream live logs to the dashboard
4. Show an AI summary when complete

---

## 6. Add AI (optional but powerful)

Add at least one LLM key to `.env`:

```bash
cp .env.example .env
# Edit .env and add one of:
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GROQ_API_KEY=gsk_...
```

Then restart: `./start.sh`

**Or use a local model (no API key needed):**
```bash
# Install Ollama: https://ollama.ai
ollama pull llama3.2
# Callahan auto-connects to http://localhost:11434
```

---

## 7. Generate a pipeline with AI

In the dashboard → **Pipeline** tab:

1. Click **Generate with AI**
2. Type what you want: _"Build my Python FastAPI app, run pytest with coverage, scan with Trivy, push Docker image to GHCR"_
3. Callahan writes your `Callahanfile.yaml` instantly

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `backend: No such file or directory` | Run `./start.sh` from the `callahan/` root directory |
| `missing go.sum entries` | Run `cd backend && go mod tidy` |
| `next: command not found` | Run `cd frontend && npm install` |
| `Failed to initialize storage: near "commit"` | Run `sed -i '' 's/commit TEXT/commit_sha TEXT/g' backend/internal/storage/store.go` |
| Docker not running | Open Docker Desktop, wait for whale icon ✓ |
| Port 8080 in use | Set `PORT=8081` in `.env` |

---

## What's next?

- 📖 [Full documentation](docs/getting-started.md)
- 🔧 [Callahanfile.yaml reference](docs/callahanfile.md)
- 🤖 [AI agents guide](docs/ai-agents.md)
- 🌐 [Git provider setup](docs/git-providers.md)
