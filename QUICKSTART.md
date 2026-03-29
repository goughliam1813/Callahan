# 🛸 Callahan CI — Quick Start

Get your first pipeline running in under 5 minutes.

---

## 1. Install

**Prerequisites:** Go 1.22+ and Node.js 18+

```bash
git clone https://github.com/goughliam1813/Callahan.git
cd Callahan
```

---

## 2. Start

Open two terminal windows:

**Terminal 1 — Backend:**
```bash
cd backend
go mod tidy
go run ./cmd/callahan
```

**Terminal 2 — Frontend:**
```bash
cd frontend
npm install
npm run dev
```

---

## 3. Open the dashboard

| Service | URL |
|---------|-----|
| Dashboard | http://localhost:3000 |
| Backend API | http://localhost:8080/api/v1 |
| WebSocket | ws://localhost:8080/ws |

---

## 4. Connect your first repo

1. Click the **+** button in the sidebar (or press `⌘K` → "Add Project")
2. Enter a project name and paste your GitHub/GitLab/Bitbucket repo URL
3. Add a Personal Access Token if the repo is private
4. Click **Connect** — Callahan clones the repo and detects your language

---

## 5. Run your first build

Click **Run Build** in the top-right corner. Callahan will:

1. Clone your repo and find the `Callahanfile.yaml`
2. Execute jobs and steps, streaming live logs via WebSocket
3. Run AI code review and security scan (if enabled in `Callahanfile.yaml`)
4. Auto-version on success and show results as expandable job cards

---

## 6. Add AI (optional but powerful)

Click **Configure AI / LLM** in the sidebar and add your API key:

- **Groq** (free tier available) — fastest, recommended for getting started
- **Anthropic** — Claude, best quality reviews
- **OpenAI** — GPT-4o
- **Ollama** — fully offline, no API key needed

Click **Test Connection** to verify, then save.

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
2. Describe what you want: _"Build my Go CLI, run tests with coverage, vet the code"_
3. Callahan writes your `Callahanfile.yaml` and pre-fills the editor

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `backend: No such file or directory` | Run `./start.sh` from the `callahan/` root directory |
| `missing go.sum entries` | Run `cd backend && go mod tidy` |
| `next: command not found` | Run `cd frontend && npm install` |
| WebSocket errors in console | Normal during build transitions — safely ignored |
| Docker not running | Open Docker Desktop, wait for whale icon ✓ |
| Port 8080 in use | Set `PORT=8081` in `.env` |

---

## What's next?

- 📖 [Website & Docs](https://callahanci.com)
- 🔧 [Callahanfile.yaml examples](examples/)
- 🤖 [Report issues](https://github.com/goughliam1813/Callahan/issues)
- 🤝 [Contributing](CONTRIBUTING.md)
