# Getting Started with Callahan CI

## Installation (< 2 minutes)

### Option 1: One-line install
```bash
curl -fsSL https://getcallahan.dev | sh
```

### Option 2: Docker Compose
```bash
git clone https://github.com/callahan-ci/callahan
cd callahan
cp .env.example .env
# Edit .env and add your LLM API key
docker-compose up -d
```

### Option 3: Binary
```bash
# Download the latest release
curl -fsSL https://github.com/callahan-ci/callahan/releases/latest/download/callahan-linux-amd64 -o callahan
chmod +x callahan
./callahan
```

Open **http://localhost:8080** — you're in! 🔥

---

## Step 1: Connect Your Repository

1. Click **Connect Repository** (or press `⌘K` → "Connect Repository")
2. Enter your repository URL
3. Select your Git provider (GitHub, GitLab, Bitbucket, etc.)
4. Add an access token if the repo is private
5. Click **Connect**

Callahan auto-detects your language and suggests a pipeline.

---

## Step 2: Configure AI

Set at least one LLM API key in your `.env` file:

```bash
# Best option: Anthropic Claude (most capable)
ANTHROPIC_API_KEY=sk-ant-...

# Alternative: OpenAI GPT-4
OPENAI_API_KEY=sk-...

# Free tier: Groq (fast Llama)
GROQ_API_KEY=gsk_...

# No internet: Ollama (local models)
docker-compose --profile with-ollama up -d
# Then set: LLM_PROVIDER=ollama
```

Restart Callahan after changing env vars:
```bash
docker-compose restart callahan
```

---

## Step 3: Your First Pipeline

### Option A: AI-Generated Pipeline

Open the **Pipeline** tab and click **Generate with AI**:

> "Build my Node.js app, run Jest tests, scan with Trivy, and deploy to Vercel when tests pass"

Callahan AI writes the complete `Callahanfile.yaml` for you.

### Option B: Copy an Example

Examples for all major languages are in the `/examples` directory:
- `examples/nextjs/Callahanfile.yaml`
- `examples/python-fastapi/Callahanfile.yaml`
- `examples/go/Callahanfile.yaml`
- `examples/rust/Callahanfile.yaml`
- `examples/java-spring/Callahanfile.yaml`

### Option C: Write Your Own

Create `Callahanfile.yaml` in your repo root. The syntax follows GitHub Actions:

```yaml
name: My Pipeline

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build
        run: npm ci && npm run build
      - name: Test  
        run: npm test
```

---

## Step 4: Trigger a Build

- **Manual**: Click the **Run** button in the dashboard
- **Automatic**: Set up a webhook from your Git provider
- **API**: `POST /api/v1/projects/{id}/builds`

---

## Step 5: Use the AI Features

### Build Debugger
When a build fails, click **AI Explain** to get:
- Plain English explanation
- Root cause
- Fix steps

### AI Chat
Click **Callahan AI** in the sidebar to open the chat panel:
- "Why did build #42 fail?"
- "Optimize my pipeline for speed"
- "Generate tests for my Go service"
- "Explain this CVE-2024-XXXX"

### Code Review
Add to your pipeline:
```yaml
- name: AI Code Review
  ai:
    action: review
    model: claude-3-5-sonnet-20241022
    prompt: "Review for bugs, security issues, and best practices"
```

### Security Analysis
```yaml
- name: AI Security Scan
  ai:
    action: scan
    prompt: "Analyze findings and explain vulnerabilities in plain English"
```

---

## Webhooks Setup

### GitHub
1. Go to your repo → Settings → Webhooks → Add webhook
2. Payload URL: `http://your-callahan-host:8080/api/v1/webhook/github`
3. Content type: `application/json`
4. Events: Push, Pull requests

### GitLab
1. Settings → Webhooks
2. URL: `http://your-callahan-host:8080/api/v1/webhook/gitlab`
3. Trigger: Push events, Merge request events

---

## Secrets Management

Add secrets in the **Secrets** tab. Reference them in your pipeline:

```yaml
env:
  AWS_ACCESS_KEY: ${{ secrets.AWS_ACCESS_KEY }}
  NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

All secrets are stored encrypted at rest.

---

## Command Palette

Press `⌘K` (Mac) or `Ctrl+K` (Linux/Windows) to open the command palette:
- Connect Repository
- Trigger Build
- Open AI Assistant
- Edit Pipeline
- Manage Secrets
- Settings

---

## FAQ

**Q: Does Callahan store my code?**  
A: No. Callahan only stores build logs, metadata, and secrets (encrypted). Your code stays in your repo.

**Q: Can I use it offline?**  
A: Yes! Use Ollama with a local model. `docker-compose --profile with-ollama up -d` and pull a model: `docker exec callahan-ollama ollama pull llama3.2`

**Q: What if the AI is down?**  
A: Callahan gracefully degrades. Builds continue normally; AI features show "unavailable" messages.

**Q: How is this different from GitHub Actions?**  
A: 100% local, no per-minute billing, AI built in, no YAML debugging via commit-push loop. Edit and run pipelines instantly.

**Q: Can my team use it?**  
A: Yes. Run it on a shared server. The REST API supports multi-user setups. Team features coming in v1.1.

---

## Getting Help

- 📖 Docs: https://docs.callahan.dev
- 💬 Discord: https://discord.gg/callahan
- 🐛 Issues: https://github.com/callahan-ci/callahan/issues
- 🤖 In-app AI chat (always available)
