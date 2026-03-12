package api

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/callahan-ci/callahan/internal/llm"
	"github.com/callahan-ci/callahan/internal/pipeline"
	"github.com/callahan-ci/callahan/internal/storage"
	"github.com/callahan-ci/callahan/pkg/config"
	"github.com/callahan-ci/callahan/pkg/models"
)

// ──────────────────────────────────────────────────────────────────────────────
// Handler
// ──────────────────────────────────────────────────────────────────────────────

type Handler struct {
	store   *storage.Store
	llm     *llm.Client
	cfg     *config.Config
	parser  *pipeline.Parser
	wsHub   *WSHub
	cancels sync.Map // buildID → context.CancelFunc
}

func NewHandler(store *storage.Store, llmClient *llm.Client, cfg *config.Config) *Handler {
	return &Handler{
		store:  store,
		llm:    llmClient,
		cfg:    cfg,
		parser: pipeline.NewParser(),
		wsHub:  newWSHub(),
	}
}

func (h *Handler) RegisterRoutes(r *gin.Engine) {
	api := r.Group("/api/v1")

	// Dashboard
	api.GET("/stats", h.GetStats)

	// Projects
	api.GET("/projects", h.ListProjects)
	api.POST("/projects", h.CreateProject)
	api.GET("/projects/:id", h.GetProject)
	api.PUT("/projects/:id", h.UpdateProject)
	api.DELETE("/projects/:id", h.DeleteProject)

	// Builds
	api.GET("/projects/:id/builds", h.ListBuilds)
	api.POST("/projects/:id/builds", h.TriggerBuild)
	api.GET("/builds/:buildId", h.GetBuild)
	api.POST("/builds/:buildId/cancel", h.CancelBuild)

	// Jobs & Steps
	api.GET("/builds/:buildId/jobs", h.ListJobs)
	api.GET("/jobs/:jobId/steps", h.ListSteps)

	// Pipeline YAML
	api.GET("/projects/:id/pipeline", h.GetPipeline)
	api.PUT("/projects/:id/pipeline", h.UpdatePipeline)

	// Secrets
	api.GET("/projects/:id/secrets", h.ListSecrets)
	api.POST("/projects/:id/secrets", h.SetSecret)
	api.DELETE("/projects/:id/secrets/:name", h.DeleteSecret)

	// LLM config (frontend-editable, persisted in DB via system secrets)
	api.GET("/settings/llm", h.GetLLMConfig)
	api.PUT("/settings/llm", h.SaveLLMConfig)
	api.POST("/settings/llm/test", h.TestLLMConfig)
	api.GET("/ai/models", h.ListModels)

	// AI
	api.POST("/ai/generate-pipeline", h.GeneratePipeline)
	api.POST("/ai/explain-build", h.ExplainBuild)
	api.POST("/ai/chat", h.Chat)
	api.POST("/ai/review", h.ReviewCode)

	// Webhooks
	api.POST("/webhook/:provider", h.Webhook)

	// WebSocket
	r.GET("/ws", h.WebSocket)

	// Health
	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok", "version": "1.0.0"})
	})
}

// ──────────────────────────────────────────────────────────────────────────────
// Dashboard
// ──────────────────────────────────────────────────────────────────────────────

func (h *Handler) GetStats(c *gin.Context) {
	stats, err := h.store.GetDashboardStats()
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, stats)
}

// ──────────────────────────────────────────────────────────────────────────────
// Projects
// ──────────────────────────────────────────────────────────────────────────────

func (h *Handler) ListProjects(c *gin.Context) {
	projects, err := h.store.ListProjects()
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if projects == nil {
		projects = []*models.Project{}
	}
	c.JSON(200, projects)
}

func (h *Handler) CreateProject(c *gin.Context) {
	var req struct {
		Name        string `json:"name" binding:"required"`
		RepoURL     string `json:"repo_url" binding:"required"`
		Provider    string `json:"provider"`
		Branch      string `json:"branch"`
		Description string `json:"description"`
		Token       string `json:"token"` // PAT — stored as secret
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if req.Provider == "" { req.Provider = "github" }
	if req.Branch == "" { req.Branch = "main" }

	p := &models.Project{
		ID:          uuid.New().String(),
		Name:        req.Name,
		RepoURL:     req.RepoURL,
		Provider:    req.Provider,
		Branch:      req.Branch,
		Description: req.Description,
		Status:      "active",
		HealthScore: 100,
		CreatedAt:   time.Now(),
		UpdatedAt:   time.Now(),
	}
	if err := h.store.CreateProject(p); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Store PAT as a secret on the project
	if req.Token != "" {
		_ = h.store.SetSecret(&models.Secret{
			ID:        uuid.New().String(),
			ProjectID: p.ID,
			Name:      "GIT_TOKEN",
			Value:     req.Token,
			CreatedAt: time.Now(),
		})
	}

	c.JSON(201, p)
}

func (h *Handler) GetProject(c *gin.Context) {
	p, err := h.store.GetProject(c.Param("id"))
	if err != nil || p == nil {
		c.JSON(404, gin.H{"error": "project not found"})
		return
	}
	c.JSON(200, p)
}

func (h *Handler) UpdateProject(c *gin.Context) {
	p, err := h.store.GetProject(c.Param("id"))
	if err != nil || p == nil {
		c.JSON(404, gin.H{"error": "project not found"})
		return
	}
	if err := c.ShouldBindJSON(p); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	p.ID = c.Param("id")
	if err := h.store.UpdateProject(p); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, p)
}

func (h *Handler) DeleteProject(c *gin.Context) {
	if err := h.store.DeleteProject(c.Param("id")); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(204, nil)
}

// ──────────────────────────────────────────────────────────────────────────────
// Builds — real execution
// ──────────────────────────────────────────────────────────────────────────────

func (h *Handler) ListBuilds(c *gin.Context) {
	builds, err := h.store.ListBuilds(c.Param("id"), 50)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if builds == nil {
		builds = []*models.Build{}
	}
	c.JSON(200, builds)
}

func (h *Handler) TriggerBuild(c *gin.Context) {
	projectID := c.Param("id")
	p, err := h.store.GetProject(projectID)
	if err != nil || p == nil {
		c.JSON(404, gin.H{"error": "project not found"})
		return
	}

	var req struct {
		Branch  string `json:"branch"`
		Message string `json:"message"`
		Trigger string `json:"trigger"`
	}
	c.ShouldBindJSON(&req)
	if req.Branch == "" { req.Branch = p.Branch }
	if req.Trigger == "" { req.Trigger = "manual" }
	if req.Message == "" { req.Message = "Manual trigger" }

	num, _ := h.store.GetNextBuildNumber(projectID)
	now := time.Now()
	build := &models.Build{
		ID:        uuid.New().String(),
		ProjectID: projectID,
		Number:    num,
		Status:    "running",
		Branch:    req.Branch,
		CommitMsg: req.Message,
		Author:    "Manual trigger",
		Trigger:   req.Trigger,
		StartedAt: &now,
		CreatedAt: now,
	}

	if err := h.store.CreateBuild(build); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	// Create a cancellable context and store the cancel func
	ctx, cancel := context.WithCancel(context.Background())
	h.cancels.Store(build.ID, cancel)

	go h.runPipeline(ctx, build, p)

	c.JSON(201, build)
}

func (h *Handler) GetBuild(c *gin.Context) {
	build, err := h.store.GetBuild(c.Param("buildId"))
	if err != nil || build == nil {
		c.JSON(404, gin.H{"error": "build not found"})
		return
	}
	c.JSON(200, build)
}

// CancelBuild cancels a running build by calling its context cancel func
func (h *Handler) CancelBuild(c *gin.Context) {
	buildID := c.Param("buildId")
	if cancel, ok := h.cancels.Load(buildID); ok {
		cancel.(context.CancelFunc)()
		h.cancels.Delete(buildID)
	}
	now := time.Now()
	h.store.UpdateBuildStatus(buildID, "cancelled", &now, 0, "Cancelled by user")
	h.wsHub.broadcast(models.WSMessage{
		Type: "build_status",
		Payload: gin.H{"build_id": buildID, "status": "cancelled"},
	})
	c.JSON(200, gin.H{"status": "cancelled"})
}

func (h *Handler) ListJobs(c *gin.Context) {
	jobs, err := h.store.ListJobs(c.Param("buildId"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if jobs == nil { jobs = []*models.Job{} }
	c.JSON(200, jobs)
}

func (h *Handler) ListSteps(c *gin.Context) {
	steps, err := h.store.ListSteps(c.Param("jobId"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if steps == nil { steps = []*models.Step{} }
	c.JSON(200, steps)
}

// ──────────────────────────────────────────────────────────────────────────────
// Pipeline definition
// ──────────────────────────────────────────────────────────────────────────────

func (h *Handler) GetPipeline(c *gin.Context) {
	p, _ := h.store.GetProject(c.Param("id"))
	if p == nil {
		c.JSON(404, gin.H{"error": "not found"})
		return
	}
	content := pipeline.DefaultPipeline(p.Language, p.Framework)
	c.JSON(200, gin.H{"content": content, "language": p.Language, "framework": p.Framework})
}

func (h *Handler) UpdatePipeline(c *gin.Context) {
	var req struct{ Content string `json:"content"` }
	c.ShouldBindJSON(&req)
	c.JSON(200, gin.H{"status": "saved", "content": req.Content})
}

// ──────────────────────────────────────────────────────────────────────────────
// Secrets
// ──────────────────────────────────────────────────────────────────────────────

func (h *Handler) ListSecrets(c *gin.Context) {
	names, err := h.store.ListSecretNames(c.Param("id"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if names == nil { names = []string{} }
	c.JSON(200, names)
}

func (h *Handler) SetSecret(c *gin.Context) {
	var req struct {
		Name  string `json:"name" binding:"required"`
		Value string `json:"value" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	secret := &models.Secret{
		ID:        uuid.New().String(),
		ProjectID: c.Param("id"),
		Name:      req.Name,
		Value:     req.Value,
		CreatedAt: time.Now(),
	}
	if err := h.store.SetSecret(secret); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"name": req.Name})
}

func (h *Handler) DeleteSecret(c *gin.Context) {
	if err := h.store.DeleteSecret(c.Param("id"), c.Param("name")); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(204, nil)
}

// ──────────────────────────────────────────────────────────────────────────────
// LLM Config — stored in DB, editable from the frontend
// ──────────────────────────────────────────────────────────────────────────────

func (h *Handler) GetLLMConfig(c *gin.Context) {
	// Return current provider/model (from env or stored config)
	provider, _ := h.store.GetSystemSetting("llm_provider")
	model, _ := h.store.GetSystemSetting("llm_model")
	ollamaURL, _ := h.store.GetSystemSetting("ollama_url")
	if provider == "" { provider = h.cfg.DefaultLLMProvider }
	if model == "" { model = h.cfg.DefaultLLMModel }
	if ollamaURL == "" { ollamaURL = h.cfg.OllamaURL }

	// Don't return actual keys — just whether they're set
	c.JSON(200, gin.H{
		"provider":         provider,
		"model":            model,
		"ollama_url":       ollamaURL,
		"has_anthropic":    h.resolveKey("anthropic") != "",
		"has_openai":       h.resolveKey("openai") != "",
		"has_groq":         h.resolveKey("groq") != "",
		"has_google":       h.resolveKey("google") != "",
	})
}

func (h *Handler) SaveLLMConfig(c *gin.Context) {
	var req struct {
		Provider    string `json:"provider"`
		Model       string `json:"model"`
		APIKey      string `json:"api_key"`
		OllamaURL   string `json:"ollama_url"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	if req.Provider != "" { h.store.SetSystemSetting("llm_provider", req.Provider) }
	if req.Model != "" { h.store.SetSystemSetting("llm_model", req.Model) }
	if req.OllamaURL != "" { h.store.SetSystemSetting("ollama_url", req.OllamaURL) }

	// Store API key under provider-specific key
	if req.APIKey != "" && req.Provider != "" {
		h.store.SetSystemSetting("key_"+req.Provider, req.APIKey)
		// Also reload into running config
		switch req.Provider {
		case "anthropic": h.cfg.AnthropicKey = req.APIKey
		case "openai":    h.cfg.OpenAIKey = req.APIKey
		case "groq":      h.cfg.GroqKey = req.APIKey
		case "google":    h.cfg.GoogleKey = req.APIKey
		}
	}

	// Update active config
	if req.Provider != "" { h.cfg.DefaultLLMProvider = req.Provider }
	if req.Model != "" { h.cfg.DefaultLLMModel = req.Model }
	if req.OllamaURL != "" { h.cfg.OllamaURL = req.OllamaURL }

	c.JSON(200, gin.H{"status": "saved"})
}

func (h *Handler) TestLLMConfig(c *gin.Context) {
	var req struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
		APIKey   string `json:"api_key"`
		OllamaURL string `json:"ollama_url"`
	}
	c.ShouldBindJSON(&req)

	// Build a clean config scoped to exactly what the user submitted
	testCfg := config.Config{
		DefaultLLMProvider: req.Provider,
		DefaultLLMModel:    req.Model,
		OllamaURL:          h.cfg.OllamaURL,
	}
	if req.OllamaURL != "" { testCfg.OllamaURL = req.OllamaURL }

	// Use the key from the request; fall back to whatever is already stored
	key := req.APIKey
	if key == "" { key = h.resolveKey(req.Provider) }

	switch req.Provider {
	case "anthropic": testCfg.AnthropicKey = key
	case "openai":    testCfg.OpenAIKey    = key
	case "groq":      testCfg.GroqKey      = key
	case "google":    testCfg.GoogleKey    = key
	}

	if req.Provider == "" {
		c.JSON(200, gin.H{"ok": false, "error": "No provider selected"})
		return
	}
	if key == "" && req.Provider != "ollama" {
		c.JSON(200, gin.H{"ok": false, "error": "No API key provided — enter your key above before testing"})
		return
	}

	testClient := llm.New(&testCfg)
	resp, err := testClient.Complete(c.Request.Context(), llm.CompletionRequest{
		Messages:  []llm.Message{{Role: "user", Content: "Reply with exactly: Callahan AI online"}},
		MaxTokens: 30,
		Provider:  req.Provider,
		Model:     req.Model,
	})
	if err != nil {
		c.JSON(200, gin.H{"ok": false, "error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"ok": true, "response": resp.Content, "model": resp.Model})
}

func (h *Handler) ListModels(c *gin.Context) {
	ms := []gin.H{
		{"provider": "anthropic", "model": "claude-opus-4-5",           "name": "Claude Opus 4.5",      "available": h.resolveKey("anthropic") != ""},
		{"provider": "anthropic", "model": "claude-sonnet-4-5",         "name": "Claude Sonnet 4.5",    "available": h.resolveKey("anthropic") != ""},
		{"provider": "anthropic", "model": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5",     "available": h.resolveKey("anthropic") != ""},
		{"provider": "openai",    "model": "gpt-4o",                    "name": "GPT-4o",               "available": h.resolveKey("openai") != ""},
		{"provider": "openai",    "model": "gpt-4o-mini",               "name": "GPT-4o Mini",          "available": h.resolveKey("openai") != ""},
		{"provider": "groq",      "model": "llama-3.3-70b-versatile",   "name": "Llama 3.3 70B (Groq)", "available": h.resolveKey("groq") != ""},
		{"provider": "groq",      "model": "llama3-8b-8192",             "name": "Llama 3 8B (Groq)",    "available": h.resolveKey("groq") != ""},
		{"provider": "ollama",    "model": "llama3.2",                  "name": "Llama 3.2 (Local)",    "available": true},
		{"provider": "ollama",    "model": "mistral",                   "name": "Mistral (Local)",      "available": true},
	}
	c.JSON(200, ms)
}

// resolveKey returns the API key for a provider, checking DB then env
func (h *Handler) resolveKey(provider string) string {
	if v, _ := h.store.GetSystemSetting("key_" + provider); v != "" {
		return v
	}
	switch provider {
	case "anthropic": return h.cfg.AnthropicKey
	case "openai":    return h.cfg.OpenAIKey
	case "groq":      return h.cfg.GroqKey
	case "google":    return h.cfg.GoogleKey
	}
	return ""
}

// ──────────────────────────────────────────────────────────────────────────────
// AI Endpoints
// ──────────────────────────────────────────────────────────────────────────────

func (h *Handler) GeneratePipeline(c *gin.Context) {
	var req struct {
		Description string `json:"description" binding:"required"`
		Language    string `json:"language"`
		Framework   string `json:"framework"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	content, err := h.llm.GeneratePipeline(c.Request.Context(), req.Description, req.Language, req.Framework)
	if err != nil {
		content = pipeline.DefaultPipeline(req.Language, req.Framework)
	}
	c.JSON(200, gin.H{"content": content})
}

func (h *Handler) ExplainBuild(c *gin.Context) {
	var req struct {
		BuildID  string `json:"build_id"`
		Logs     string `json:"logs"`
		Pipeline string `json:"pipeline"`
	}
	c.ShouldBindJSON(&req)
	explanation, err := h.llm.ExplainBuildFailure(c.Request.Context(), req.Logs, req.Pipeline)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"explanation": explanation})
}

func (h *Handler) Chat(c *gin.Context) {
	var req struct {
		RawMsgs []llm.Message `json:"raw_messages"`
		Context string        `json:"context"`
	}
	c.ShouldBindJSON(&req)
	response, err := h.llm.Chat(c.Request.Context(), req.RawMsgs, req.Context)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, gin.H{"response": response})
}

func (h *Handler) ReviewCode(c *gin.Context) {
	var req struct{ Diff string `json:"diff"` }
	c.ShouldBindJSON(&req)
	review, err := h.llm.ReviewCode(c.Request.Context(), req.Diff)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, review)
}

func (h *Handler) Webhook(c *gin.Context) {
	c.JSON(200, gin.H{"provider": c.Param("provider"), "status": "received"})
}

// ──────────────────────────────────────────────────────────────────────────────
// WebSocket
// ──────────────────────────────────────────────────────────────────────────────

type WSHub struct {
	mu      sync.RWMutex
	clients map[*websocket.Conn]string // conn → subscribed buildID ("" = all)
}

func newWSHub() *WSHub {
	return &WSHub{clients: make(map[*websocket.Conn]string)}
}

func (h *WSHub) broadcast(msg interface{}) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for conn := range h.clients {
		conn.WriteJSON(msg)
	}
}

var upgrader = websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}

func (h *Handler) WebSocket(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil { return }
	defer conn.Close()

	buildID := c.Query("build_id")
	h.wsHub.mu.Lock()
	h.wsHub.clients[conn] = buildID
	h.wsHub.mu.Unlock()

	defer func() {
		h.wsHub.mu.Lock()
		delete(h.wsHub.clients, conn)
		h.wsHub.mu.Unlock()
	}()

	for {
		if _, _, err := conn.ReadMessage(); err != nil { break }
	}
}

// ──────────────────────────────────────────────────────────────────────────────
// Real pipeline runner
// ──────────────────────────────────────────────────────────────────────────────

func (h *Handler) runPipeline(ctx context.Context, build *models.Build, project *models.Project) {
	defer h.cancels.Delete(build.ID)

	start := time.Now()
	workDir := filepath.Join(os.TempDir(), "callahan", build.ID)
	defer os.RemoveAll(workDir)

	broadcast := func(jobID, stepID, stream, line string) {
		h.wsHub.broadcast(models.WSMessage{
			Type: "log",
			Payload: models.LogLine{
				BuildID:   build.ID,
				JobID:     jobID,
				StepID:    stepID,
				Line:      line,
				Stream:    stream,
				Timestamp: time.Now(),
			},
		})
	}

	logLine := func(line string) { broadcast("", "", "stdout", line) }

	// ── 1. Clone the repository ──────────────────────────────────────────────
	logLine(fmt.Sprintf("╔══ Callahan CI — Build #%d ══╗", build.Number))
	logLine(fmt.Sprintf("  Project : %s", project.Name))
	logLine(fmt.Sprintf("  Repo    : %s", project.RepoURL))
	logLine(fmt.Sprintf("  Branch  : %s", build.Branch))
	logLine("  Trigger : " + build.Trigger)
	logLine("")

	// Get stored PAT
	token, _ := h.store.GetSecret(project.ID, "GIT_TOKEN")

	if err := pipeline.CloneRepo(ctx, project.RepoURL, build.Branch, token, workDir, logLine); err != nil {
		logLine("✖ Clone failed: " + err.Error())
		if token == "" {
			logLine("")
			logLine("  Tip: Add a GitHub PAT in project Settings → Secrets → GIT_TOKEN")
			logLine("  For public repos no token is needed.")
		}
		h.finishBuild(build, "failed", time.Since(start).Milliseconds(), "Clone failed: "+err.Error())
		return
	}

	// ── 2. Update build with real commit info ────────────────────────────────
	sha, msg := pipeline.GetLatestCommit(workDir)
	if sha != "" {
		build.Commit = sha
		if msg != "" { build.CommitMsg = msg }
		h.store.UpdateBuildCommit(build.ID, sha, msg)
	}
	logLine(fmt.Sprintf("  Commit  : %s %s", sha, msg))
	logLine("")

	// ── 3. Find & parse Callahanfile ────────────────────────────────────────
	callahanPath, callahanData := pipeline.FindCallahanfile(workDir)
	if callahanPath == "" {
		logLine("⚠ No Callahanfile.yaml found — using auto-detected pipeline")
		// Try to detect language from files
		lang, fw := "JavaScript/TypeScript", "Node.js"
		callahanData = []byte(pipeline.DefaultPipeline(lang, fw))
		logLine(fmt.Sprintf("  Detected: %s / %s", lang, fw))
	} else {
		logLine(fmt.Sprintf("✔ Found %s", callahanPath))
	}

	parsed, err := h.parser.Parse(callahanData)
	if err != nil {
		logLine("✖ Pipeline parse error: " + err.Error())
		h.finishBuild(build, "failed", time.Since(start).Milliseconds(), err.Error())
		return
	}

	logLine(fmt.Sprintf("  Pipeline: %s (%d job(s))", parsed.Name, len(parsed.Jobs)))
	logLine("")

	// ── 4. Get project secrets as env vars ───────────────────────────────────
	secrets, _ := h.store.GetAllSecrets(project.ID)

	// ── 5. Execute jobs ──────────────────────────────────────────────────────
	executor := pipeline.NewExecutor(func(jobID, stepID, stream, line string) {
		broadcast(jobID, stepID, stream, line)
	})

	allSuccess := true

	for jobName, job := range parsed.Jobs {
		// Check cancellation
		select {
		case <-ctx.Done():
			h.finishBuild(build, "cancelled", time.Since(start).Milliseconds(), "Cancelled by user")
			return
		default:
		}

		dbJob := &models.Job{
			ID:      uuid.New().String(),
			BuildID: build.ID,
			Name:    jobName,
			Status:  "running",
		}
		now := time.Now()
		dbJob.StartedAt = &now
		h.store.CreateJob(dbJob)

		result := executor.ExecuteJob(ctx, build.ID, jobName, job, workDir, secrets)

		finished := time.Now()
		dbJob.Status = result.Status
		dbJob.FinishedAt = &finished
		dbJob.Duration = result.Duration
		dbJob.ExitCode = result.ExitCode
		h.store.UpdateJob(dbJob)

		if result.Status == "cancelled" {
			h.finishBuild(build, "cancelled", time.Since(start).Milliseconds(), "Cancelled by user")
			return
		}
		if result.Status != "success" { allSuccess = false }

		h.wsHub.broadcast(models.WSMessage{Type: "job_status", Payload: dbJob})
	}

	status := "success"
	if !allSuccess { status = "failed" }

	totalMs := time.Since(start).Milliseconds()
	logLine("")
	if status == "success" {
		logLine(fmt.Sprintf("╚══ ✔ Pipeline PASSED — %.1fs ══╝", float64(totalMs)/1000))
	} else {
		logLine(fmt.Sprintf("╚══ ✖ Pipeline FAILED — %.1fs ══╝", float64(totalMs)/1000))
	}

	// ── 6. AI insight on failure ─────────────────────────────────────────────
	aiInsight := ""
	if !allSuccess {
		aiInsight, _ = h.llm.ExplainBuildFailure(context.Background(), "Build step failed", string(callahanData))
	}

	h.finishBuild(build, status, totalMs, aiInsight)
}

func (h *Handler) finishBuild(build *models.Build, status string, duration int64, aiInsight string) {
	now := time.Now()
	h.store.UpdateBuildStatus(build.ID, status, &now, duration, aiInsight)
	h.wsHub.broadcast(models.WSMessage{
		Type: "build_status",
		Payload: gin.H{"build_id": build.ID, "status": status, "duration": duration},
	})
}
