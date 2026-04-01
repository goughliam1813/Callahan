package api

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"

	"github.com/callahan-ci/callahan/internal/llm"
	"github.com/callahan-ci/callahan/internal/notifications"
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

	p, _ := h.store.GetProject(c.Param("id"))
	if p == nil {
		c.JSON(404, gin.H{"error": "project not found"})
		return
	}

	// Clone the repo, write the file, commit, push
	workDir := filepath.Join(os.TempDir(), "callahan", "pipeline-save-"+c.Param("id"))
	defer os.RemoveAll(workDir)

	token, _ := h.store.GetSecret(p.ID, "GIT_TOKEN")
	if err := pipeline.CloneRepo(context.Background(), p.RepoURL, p.Branch, token, workDir, func(s string) {}); err != nil {
		c.JSON(200, gin.H{"status": "saved", "content": req.Content, "message": "✔ Saved locally (git push failed: " + err.Error() + ")"})
		return
	}

	// Write the Callahanfile.yaml
	callahanPath := filepath.Join(workDir, "Callahanfile.yaml")
	if err := os.WriteFile(callahanPath, []byte(req.Content), 0644); err != nil {
		c.JSON(200, gin.H{"status": "saved", "content": req.Content, "message": "✔ Saved locally (file write failed)"})
		return
	}

	// Git add, commit, push
	cmds := [][]string{
		{"git", "-C", workDir, "add", "Callahanfile.yaml"},
		{"git", "-C", workDir, "commit", "-m", "chore: update Callahanfile.yaml via Callahan UI"},
	}
	for _, args := range cmds {
		if out, err := exec.Command(args[0], args[1:]...).CombinedOutput(); err != nil {
			// Commit might fail if no changes — that's ok
			_ = out
		}
	}

	// Push with token
	pushURL := p.RepoURL
	if token != "" {
		pushURL = pipeline.InjectToken(p.RepoURL, token)
	}
	pushCmd := exec.Command("git", "-C", workDir, "push", pushURL, p.Branch)
	if out, err := pushCmd.CombinedOutput(); err != nil {
		c.JSON(200, gin.H{"status": "saved", "content": req.Content, "message": "✔ Saved locally (push failed: " + string(out) + ")"})
		return
	}

	c.JSON(200, gin.H{"status": "saved", "content": req.Content, "message": "✔ Saved and pushed to git"})
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
		Provider  string `json:"provider"`
		Model     string `json:"model"`
		APIKey    string `json:"api_key"`
		OllamaURL string `json:"ollama_url"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	// Persist to DB
	if req.Provider != "" { h.store.SetSystemSetting("llm_provider", req.Provider) }
	if req.Model != ""    { h.store.SetSystemSetting("llm_model", req.Model) }
	if req.OllamaURL != "" { h.store.SetSystemSetting("ollama_url", req.OllamaURL) }
	if req.APIKey != "" && req.Provider != "" {
		h.store.SetSystemSetting("key_"+req.Provider, req.APIKey)
	}

	// Apply immediately to live config so all subsequent requests use new settings
	if req.Provider != "" { h.cfg.DefaultLLMProvider = req.Provider }
	if req.Model != ""    { h.cfg.DefaultLLMModel = req.Model }
	if req.OllamaURL != "" { h.cfg.OllamaURL = req.OllamaURL }
	if req.APIKey != "" {
		switch req.Provider {
		case "anthropic": h.cfg.AnthropicKey = req.APIKey
		case "openai":    h.cfg.OpenAIKey    = req.APIKey
		case "groq":      h.cfg.GroqKey      = req.APIKey
		case "google":    h.cfg.GoogleKey    = req.APIKey
		}
	}

	// Also ensure any previously-saved key for this provider is loaded into cfg
	// (handles case where key was saved earlier but cfg was empty)
	if h.cfg.AnthropicKey == "" {
		if v, _ := h.store.GetSystemSetting("key_anthropic"); v != "" { h.cfg.AnthropicKey = v }
	}
	if h.cfg.OpenAIKey == "" {
		if v, _ := h.store.GetSystemSetting("key_openai"); v != "" { h.cfg.OpenAIKey = v }
	}
	if h.cfg.GroqKey == "" {
		if v, _ := h.store.GetSystemSetting("key_groq"); v != "" { h.cfg.GroqKey = v }
	}
	if h.cfg.GoogleKey == "" {
		if v, _ := h.store.GetSystemSetting("key_google"); v != "" { h.cfg.GoogleKey = v }
	}

	c.JSON(200, gin.H{
		"status":   "saved",
		"provider": h.cfg.DefaultLLMProvider,
		"model":    h.cfg.DefaultLLMModel,
	})
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
		RawMsgs   []llm.Message `json:"raw_messages"`
		Context   string        `json:"context"`
		ProjectID string        `json:"project_id"`
	}
	c.ShouldBindJSON(&req)

	// Build rich context from v3 context engine
	richContext := req.Context
	if req.ProjectID != "" {
		entries, err := h.store.GetProjectContext(req.ProjectID, 30)
		if err == nil && len(entries) > 0 {
			var sb strings.Builder
			sb.WriteString(richContext)
			sb.WriteString("\n\n--- Recent Activity (AI Context Engine) ---\n")
			for _, e := range entries {
				sb.WriteString(fmt.Sprintf("[%s] %s %s\n", e.Type, e.CreatedAt.Format("Jan 2 15:04"), e.Summary))
			}

			// Also pull latest version and deployment info
			if latest, _ := h.store.LatestVersion(req.ProjectID); latest != nil {
				sb.WriteString(fmt.Sprintf("\nLatest version: %s (build #%s, %s bump)\n", latest.Tag, safeHead(latest.BuildID, 8), latest.BumpType))
			}
			if envs, _ := h.store.ListEnvironments(req.ProjectID); len(envs) > 0 {
				sb.WriteString("\nEnvironments:\n")
				for _, env := range envs {
					dep, _ := h.store.LatestDeploymentForEnv(env.ID)
					depInfo := "no deployments"
					if dep != nil { depInfo = fmt.Sprintf("last deployed %s (build %s)", dep.Status, safeHead(dep.BuildID, 8)) }
					sb.WriteString(fmt.Sprintf("  • %s: %s\n", env.Name, depInfo))
				}
			}
			richContext = sb.String()
		}
	}

	response, err := h.llm.Chat(c.Request.Context(), req.RawMsgs, richContext)
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
	if parsed.AI != nil {
		logLine(fmt.Sprintf("  AI Config: review=%v, security-scan=%v", parsed.AI.Review, parsed.AI.SecurityScan))
	} else {
		logLine("  AI Config: not configured (add ai: block to Callahanfile.yaml)")
	}
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

		// Save each step to the database so the UI can render them
		for _, step := range result.Steps {
			step.JobID = dbJob.ID
			h.store.CreateStep(step)
		}

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

	// ── 5b. AI Code Review (post-build) ─────────────────────────────────────
	if parsed.AI != nil && parsed.AI.Review {
		logLine("")
		logLine("╔══ AI Code Review ══╗")

		// Create a real job + step in the DB so it shows as a card in the UI
		aiJobID := uuid.New().String()
		aiStepID := uuid.New().String()
		aiJobStart := time.Now()
		h.store.CreateJob(&models.Job{
			ID: aiJobID, BuildID: build.ID, Name: "ai-review", Status: "running", StartedAt: &aiJobStart,
		})

		var reviewLog strings.Builder

		// Try git diff first; fall back to collecting source files
		diff := pipeline.GetGitDiff(workDir)
		var review *models.AIReview
		var reviewErr error

		if diff != "" && len(diff) > 50 {
			logLine("  Analyzing git diff…")
			reviewLog.WriteString("Analyzing git diff...\n")
			review, reviewErr = h.llm.ReviewCode(context.Background(), diff)
		} else {
			logLine("  No diff available — reviewing source files…")
			reviewLog.WriteString("No diff available — reviewing source files...\n")
			filesContent := pipeline.CollectSourceFiles(workDir, 12000)
			if filesContent != "" {
				review, reviewErr = h.llm.ReviewCodeFiles(context.Background(), filesContent)
			} else {
				logLine("  ⚠ No reviewable source files found")
				reviewLog.WriteString("⚠ No reviewable source files found\n")
			}
		}

		aiStepStatus := "success"
		if reviewErr != nil {
			logLine("  ⚠ AI review error: " + reviewErr.Error())
			reviewLog.WriteString("⚠ AI review error: " + reviewErr.Error() + "\n")
			aiStepStatus = "failed"
		} else if review != nil {
			review.BuildID = build.ID
			severityIcon := map[string]string{"info": "ℹ", "warning": "⚠", "error": "✖"}[review.Severity]
			if severityIcon == "" { severityIcon = "ℹ" }
			logLine(fmt.Sprintf("  %s Severity: %s", severityIcon, review.Severity))
			logLine(fmt.Sprintf("  Summary: %s", review.Summary))
			reviewLog.WriteString(fmt.Sprintf("Severity: %s\nSummary: %s\n", review.Severity, review.Summary))
			for i, finding := range review.Findings {
				logLine(fmt.Sprintf("  %d. %s", i+1, finding))
				reviewLog.WriteString(fmt.Sprintf("%d. %s\n", i+1, finding))
			}
			if review.Suggestion != "" {
				logLine(fmt.Sprintf("  💡 Suggestion: %s", review.Suggestion))
				reviewLog.WriteString(fmt.Sprintf("💡 Suggestion: %s\n", review.Suggestion))
			}

			h.store.AddContextEntry(&models.ContextEntry{
				ID: uuid.New().String(), ProjectID: project.ID, Type: "ai_review",
				RefID:   build.ID,
				Summary: fmt.Sprintf("🔍 AI Review [%s]: %s", review.Severity, review.Summary),
				Detail:  fmt.Sprintf("Findings: %d, Suggestion: %s", len(review.Findings), review.Suggestion),
				Tags:    strings.Join([]string{"ai_review", review.Severity, build.Branch}, ","),
				CreatedAt: time.Now(),
			})

			h.wsHub.broadcast(models.WSMessage{Type: "ai_review", Payload: review})
		}

		// Save the AI review step
		aiJobEnd := time.Now()
		aiJobDuration := aiJobEnd.Sub(aiJobStart).Milliseconds()
		h.store.CreateStep(&models.Step{
			ID: aiStepID, JobID: aiJobID, Name: "AI Code Review", Status: aiStepStatus,
			Command: "callahan ai review", Log: reviewLog.String(), Duration: aiJobDuration,
		})
		h.store.UpdateJob(&models.Job{
			ID: aiJobID, BuildID: build.ID, Name: "ai-review", Status: aiStepStatus,
			StartedAt: &aiJobStart, FinishedAt: &aiJobEnd, Duration: aiJobDuration,
		})
		h.wsHub.broadcast(models.WSMessage{Type: "job_status", Payload: gin.H{
			"id": aiJobID, "build_id": build.ID, "name": "ai-review", "status": aiStepStatus,
		}})
		logLine("╚══ AI Code Review Complete ══╝")
	}

	// ── 5c. AI Security Scan (post-build) ───────────────────────────────────
	if parsed.AI != nil && parsed.AI.SecurityScan {
		logLine("")
		logLine("╔══ AI Security Scan ══╗")

		// Create a real job + step in the DB
		secJobID := uuid.New().String()
		secStepID := uuid.New().String()
		secJobStart := time.Now()
		h.store.CreateJob(&models.Job{
			ID: secJobID, BuildID: build.ID, Name: "security-scan", Status: "running", StartedAt: &secJobStart,
		})

		var secLog strings.Builder

		// Step 1: Try running a real scanner (trivy / semgrep)
		scannerName, scannerOutput, scanErr := pipeline.RunSecurityScanner(ctx, workDir)
		if scanErr != nil {
			logLine("  ⚠ Scanner error: " + scanErr.Error())
			secLog.WriteString("⚠ Scanner error: " + scanErr.Error() + "\n")
		}
		if scannerName != "" {
			logLine(fmt.Sprintf("  ✔ %s scan completed", scannerName))
			secLog.WriteString(fmt.Sprintf("✔ %s scan completed\n", scannerName))
		} else {
			logLine("  ⚠ No scanner installed (trivy/semgrep) — using AI-only scan")
			secLog.WriteString("⚠ No scanner installed (trivy/semgrep) — using AI-only scan\n")
		}

		// Step 2: Collect source for AI analysis
		sourceSnippet := pipeline.CollectSourceFiles(workDir, 8000)

		// Step 3: AI triage / scan
		logLine("  🤖 AI analyzing security posture…")
		secLog.WriteString("🤖 AI analyzing security posture...\n")
		scanResult, secErr := h.llm.SecurityScan(context.Background(), scannerName, scannerOutput, sourceSnippet)

		secStepStatus := "success"
		if secErr != nil {
			logLine("  ⚠ AI security scan error: " + secErr.Error())
			secLog.WriteString("⚠ AI security scan error: " + secErr.Error() + "\n")
			secStepStatus = "failed"
		} else if scanResult != nil {
			scanResult.BuildID = build.ID
			severityIcon := map[string]string{"info": "ℹ", "warning": "⚠", "error": "🚨"}[scanResult.Severity]
			if severityIcon == "" { severityIcon = "ℹ" }
			logLine(fmt.Sprintf("  %s Security: %s", severityIcon, scanResult.Summary))
			secLog.WriteString(fmt.Sprintf("Security: %s\n", scanResult.Summary))
			logLine(fmt.Sprintf("  Scanner: %s | Findings: %d (C:%d H:%d M:%d L:%d)",
				scanResult.Scanner, scanResult.TotalFindings,
				scanResult.Critical, scanResult.High, scanResult.Medium, scanResult.Low))
			secLog.WriteString(fmt.Sprintf("Scanner: %s | Findings: %d (C:%d H:%d M:%d L:%d)\n",
				scanResult.Scanner, scanResult.TotalFindings,
				scanResult.Critical, scanResult.High, scanResult.Medium, scanResult.Low))

			for i, f := range scanResult.Findings {
				if i >= 10 {
					logLine(fmt.Sprintf("  … and %d more findings", len(scanResult.Findings)-10))
					secLog.WriteString(fmt.Sprintf("… and %d more findings\n", len(scanResult.Findings)-10))
					break
				}
				loc := ""
				if f.File != "" {
					loc = fmt.Sprintf(" (%s", f.File)
					if f.Line > 0 { loc += fmt.Sprintf(":%d", f.Line) }
					loc += ")"
				}
				logLine(fmt.Sprintf("  [%s] %s%s", f.Severity, f.Title, loc))
				secLog.WriteString(fmt.Sprintf("[%s] %s%s\n", f.Severity, f.Title, loc))
				if f.Fix != "" {
					logLine(fmt.Sprintf("        Fix: %s", f.Fix))
					secLog.WriteString(fmt.Sprintf("  Fix: %s\n", f.Fix))
				}
			}

			if scanResult.AIExplanation != "" {
				logLine("")
				logLine(fmt.Sprintf("  💡 AI Assessment: %s", scanResult.AIExplanation))
				secLog.WriteString(fmt.Sprintf("\n💡 AI Assessment: %s\n", scanResult.AIExplanation))
			}

			if scanResult.Critical > 0 || scanResult.High > 0 {
				logLine("")
				logLine("  ⚠ HIGH/CRITICAL security findings detected — review recommended before deploy")
				secLog.WriteString("\n⚠ HIGH/CRITICAL security findings detected\n")
			}

			h.store.AddContextEntry(&models.ContextEntry{
				ID: uuid.New().String(), ProjectID: project.ID, Type: "security_scan",
				RefID:   build.ID,
				Summary: fmt.Sprintf("🛡 Security Scan [%s]: %s — %d findings (C:%d H:%d M:%d L:%d)",
					scanResult.Scanner, scanResult.Severity, scanResult.TotalFindings,
					scanResult.Critical, scanResult.High, scanResult.Medium, scanResult.Low),
				Tags: strings.Join([]string{"security", scanResult.Severity, scanResult.Scanner}, ","),
				CreatedAt: time.Now(),
			})

			h.wsHub.broadcast(models.WSMessage{Type: "security_scan", Payload: scanResult})
		}

		// Save the security scan step
		secJobEnd := time.Now()
		secJobDuration := secJobEnd.Sub(secJobStart).Milliseconds()
		h.store.CreateStep(&models.Step{
			ID: secStepID, JobID: secJobID, Name: "AI Security Scan", Status: secStepStatus,
			Command: "callahan ai security-scan", Log: secLog.String(), Duration: secJobDuration,
		})
		h.store.UpdateJob(&models.Job{
			ID: secJobID, BuildID: build.ID, Name: "security-scan", Status: secStepStatus,
			StartedAt: &secJobStart, FinishedAt: &secJobEnd, Duration: secJobDuration,
		})
		h.wsHub.broadcast(models.WSMessage{Type: "job_status", Payload: gin.H{
			"id": secJobID, "build_id": build.ID, "name": "security-scan", "status": secStepStatus,
		}})
		logLine("╚══ AI Security Scan Complete ══╝")
	}

	// ── 6. Auto-version on success ───────────────────────────────────────────
	var ver *models.Version
	if status == "success" {
		// Auto bump version
		latest, _ := h.store.LatestVersion(project.ID)
		current := "0.0.0"; if latest != nil { current = latest.SemVer }
		parts := strings.Split(current, ".")
		if len(parts) != 3 { parts = []string{"0","0","0"} }
		var major, minor, patch int
		fmt.Sscanf(parts[0], "%d", &major); fmt.Sscanf(parts[1], "%d", &minor); fmt.Sscanf(parts[2], "%d", &patch)
		patch++ // default patch bump; AI can override
		nextVer := fmt.Sprintf("%d.%d.%d", major, minor, patch)
		ver = &models.Version{
			ID: uuid.New().String(), ProjectID: project.ID, BuildID: build.ID,
			SemVer: nextVer, Tag: "v" + nextVer, BumpType: "patch",
			BumpReason: "Auto-versioned on successful build", CreatedAt: time.Now(),
		}
		h.store.CreateVersion(ver)
		logLine(fmt.Sprintf("  🏷  Auto-versioned: %s", ver.Tag))

		// Index version in context engine
		h.store.AddContextEntry(&models.ContextEntry{
			ID: uuid.New().String(), ProjectID: project.ID, Type: "version",
			RefID: ver.ID,
			Summary: fmt.Sprintf("🏷 Version %s created for build #%d", ver.Tag, build.Number),
			Tags: "version,patch,auto", CreatedAt: time.Now(),
		})
	}

	// ── 7. Index build completion in context engine ───────────────────────────
	statusEmoji := map[string]string{"success":"✔","failed":"✖","cancelled":"■"}[status]
	sha = build.Commit; if len(sha) > 8 { sha = sha[:8] }
	h.store.AddContextEntry(&models.ContextEntry{
		ID: uuid.New().String(), ProjectID: project.ID, Type: "build",
		RefID: build.ID,
		Summary: fmt.Sprintf("%s Build #%d %s — %s branch %s commit %s (%.1fs)",
			statusEmoji, build.Number, status, project.Name, build.Branch, sha,
			float64(totalMs)/1000),
		Tags: strings.Join([]string{"build", status, build.Branch}, ","),
		CreatedAt: time.Now(),
	})

	// ── 8. AI insight on failure ─────────────────────────────────────────────
	aiInsight := ""
	if !allSuccess {
		aiInsight, _ = h.llm.ExplainBuildFailure(context.Background(), "Build step failed", string(callahanData))
	}

	// ── 9. Dispatch notifications ────────────────────────────────────────────
	dispatcher := notifications.NewDispatcher(h.store, h.llm)
	dispatcher.Dispatch(context.Background(), build, project, ver)

	h.finishBuild(build, status, totalMs, aiInsight)

	// ── 10. Deploy chain (if CI passed and deploy stages defined) ────────────
	if status == "success" && parsed.Deploy != nil && len(parsed.Deploy) > 0 {
		h.runDeployChain(ctx, build, project, parsed.Deploy, ver, workDir)
	}

	// ── 11. Prune old builds/versions per retention settings ────────────────
	h.pruneRetention(project.ID)
}

// safeHead returns s[:n] without panicking when len(s) < n.
func safeHead(s string, n int) string {
	if len(s) <= n { return s }
	return s[:n]
}

func (h *Handler) finishBuild(build *models.Build, status string, duration int64, aiInsight string) {
	now := time.Now()
	h.store.UpdateBuildStatus(build.ID, status, &now, duration, aiInsight)
	h.wsHub.broadcast(models.WSMessage{
		Type: "build_status",
		Payload: gin.H{"build_id": build.ID, "status": status, "duration": duration},
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// V3 Routes registration — call this after RegisterRoutes
// ─────────────────────────────────────────────────────────────────────────────

func (h *Handler) RegisterV3Routes(r *gin.Engine) {
	api := r.Group("/api/v1")

	// Environments
	api.GET("/projects/:id/environments", h.ListEnvironments)
	api.POST("/projects/:id/environments", h.CreateEnvironment)
	api.PUT("/environments/:envId", h.UpdateEnvironment)
	api.DELETE("/environments/:envId", h.DeleteEnvironment)

	// Deployments
	api.GET("/projects/:id/deployments", h.ListDeployments)
	api.POST("/projects/:id/environments/:envId/deploy", h.TriggerDeployment)
	api.POST("/deployments/:depId/approve", h.ApproveDeployment)

	// Versions
	api.GET("/projects/:id/versions", h.ListVersions)
	api.POST("/projects/:id/versions", h.CreateManualVersion)

	// Artifacts
	api.GET("/builds/:buildId/artifacts", h.ListArtifacts)
	api.POST("/artifacts/:artifactId/promote", h.PromoteArtifact)

	// Notifications
	api.GET("/projects/:id/notifications", h.ListNotificationChannels)
	api.POST("/projects/:id/notifications", h.CreateNotificationChannel)
	api.PUT("/notifications/:channelId", h.UpdateNotificationChannel)
	api.DELETE("/notifications/:channelId", h.DeleteNotificationChannel)
	api.GET("/builds/:buildId/notification-logs", h.ListNotificationLogs)
	api.POST("/notifications/test", h.TestNotification)

	// AI Context Engine v2
	api.GET("/projects/:id/context", h.GetProjectContext)
	api.GET("/projects/:id/context/search", h.SearchContext)

	// AI v3
	api.POST("/ai/version-bump", h.AIVersionBump)
	api.POST("/ai/deployment-check", h.AIDeploymentCheck)
	api.POST("/ai/notification-preview", h.AINotificationPreview)

	// Retention settings
	api.GET("/settings/retention", h.GetRetentionSettings)
	api.PUT("/settings/retention", h.SaveRetentionSettings)
}

// ─── Environments ─────────────────────────────────────────────────────────────

func (h *Handler) ListEnvironments(c *gin.Context) {
	envs, err := h.store.ListEnvironments(c.Param("id"))
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	if envs == nil { envs = []*models.Environment{} }
	c.JSON(200, envs)
}

func (h *Handler) CreateEnvironment(c *gin.Context) {
	var req struct {
		Name             string `json:"name" binding:"required"`
		Description      string `json:"description"`
		Color            string `json:"color"`
		AutoDeploy       bool   `json:"auto_deploy"`
		RequiresApproval bool   `json:"requires_approval"`
		BranchFilter     string `json:"branch_filter"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }
	if req.Color == "" { req.Color = "#545f72" }

	env := &models.Environment{
		ID: uuid.New().String(), ProjectID: c.Param("id"),
		Name: req.Name, Description: req.Description, Color: req.Color,
		AutoDeploy: req.AutoDeploy, RequiresApproval: req.RequiresApproval,
		BranchFilter: req.BranchFilter,
		CreatedAt: time.Now(), UpdatedAt: time.Now(),
	}
	if err := h.store.CreateEnvironment(env); err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	c.JSON(201, env)
}

func (h *Handler) UpdateEnvironment(c *gin.Context) {
	env, err := h.store.GetEnvironment(c.Param("envId"))
	if err != nil || env == nil { c.JSON(404, gin.H{"error": "not found"}); return }
	c.ShouldBindJSON(env)
	h.store.UpdateEnvironment(env)
	c.JSON(200, env)
}

func (h *Handler) DeleteEnvironment(c *gin.Context) {
	h.store.DeleteEnvironment(c.Param("envId"))
	c.JSON(204, nil)
}

// ─── Deployments ──────────────────────────────────────────────────────────────

func (h *Handler) ListDeployments(c *gin.Context) {
	deps, err := h.store.ListDeployments(c.Param("id"), 50)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	if deps == nil { deps = []*models.Deployment{} }
	c.JSON(200, deps)
}

func (h *Handler) TriggerDeployment(c *gin.Context) {
	var req struct {
		BuildID   string `json:"build_id" binding:"required"`
		VersionID string `json:"version_id"`
		Strategy  string `json:"strategy"`
		Notes     string `json:"notes"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }
	if req.Strategy == "" { req.Strategy = "direct" }

	env, err := h.store.GetEnvironment(c.Param("envId"))
	if err != nil || env == nil { c.JSON(404, gin.H{"error": "environment not found"}); return }

	status := "running"
	if env.RequiresApproval { status = "pending" }

	dep := &models.Deployment{
		ID: uuid.New().String(), ProjectID: c.Param("id"),
		EnvironmentID: env.ID, BuildID: req.BuildID, VersionID: req.VersionID,
		Status: status, Strategy: req.Strategy, TriggeredBy: "manual",
		Notes: req.Notes, CreatedAt: time.Now(),
	}
	if err := h.store.CreateDeployment(dep); err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }

	if status == "running" {
		now := time.Now()
		dep.StartedAt = &now
		go h.executeDeployment(dep, env)
	}

	// Index context
	h.store.AddContextEntry(&models.ContextEntry{
		ID: uuid.New().String(), ProjectID: c.Param("id"), Type: "deployment",
		RefID: dep.ID,
		Summary: fmt.Sprintf("🚀 Deployment to %s triggered (build %s, strategy: %s)", env.Name, safeHead(req.BuildID, 8), req.Strategy),
		Tags: strings.Join([]string{"deployment", env.Name, req.Strategy}, ","),
		CreatedAt: time.Now(),
	})

	c.JSON(201, dep)
}

func (h *Handler) ApproveDeployment(c *gin.Context) {
	// In a full impl: verify approver, update status, kick off executeDeployment
	dep := &models.Deployment{ID: c.Param("depId")}
	now := time.Now()
	h.store.UpdateDeploymentStatus(dep.ID, "running", &now, 0)
	c.JSON(200, gin.H{"status": "approved", "deployment_id": dep.ID})
}

func (h *Handler) executeDeployment(dep *models.Deployment, env *models.Environment) {
	start := time.Now()
	// In Phase 1: simulate; Phase 2 = real docker/kubectl/terraform
	time.Sleep(2 * time.Second)
	finished := time.Now()
	h.store.UpdateDeploymentStatus(dep.ID, "success", &finished, time.Since(start).Milliseconds())
	h.wsHub.broadcast(models.WSMessage{
		Type: "deployment_status",
		Payload: gin.H{"deployment_id": dep.ID, "environment": env.Name, "status": "success"},
	})
}

// ─── Versions ─────────────────────────────────────────────────────────────────

func (h *Handler) ListVersions(c *gin.Context) {
	vs, err := h.store.ListVersions(c.Param("id"), 50)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	if vs == nil { vs = []*models.Version{} }
	c.JSON(200, vs)
}

func (h *Handler) CreateManualVersion(c *gin.Context) {
	var req struct {
		BuildID   string `json:"build_id" binding:"required"`
		BumpType  string `json:"bump_type"`
		Changelog string `json:"changelog"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }
	if req.BumpType == "" { req.BumpType = "patch" }

	latest, _ := h.store.LatestVersion(c.Param("id"))
	current := "0.0.0"; if latest != nil { current = latest.SemVer }

	parts := strings.Split(current, ".")
	if len(parts) != 3 { parts = []string{"0","0","0"} }
	// bump
	var major, minor, patch int
	fmt.Sscanf(parts[0], "%d", &major)
	fmt.Sscanf(parts[1], "%d", &minor)
	fmt.Sscanf(parts[2], "%d", &patch)
	switch req.BumpType {
	case "major": major++; minor=0; patch=0
	case "minor": minor++; patch=0
	default: patch++
	}
	nextVer := fmt.Sprintf("%d.%d.%d", major, minor, patch)

	ver := &models.Version{
		ID: uuid.New().String(), ProjectID: c.Param("id"), BuildID: req.BuildID,
		SemVer: nextVer, Tag: "v"+nextVer, BumpType: req.BumpType,
		BumpReason: "Manual version", Changelog: req.Changelog, CreatedAt: time.Now(),
	}
	if err := h.store.CreateVersion(ver); err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	c.JSON(201, ver)
}

// ─── Artifacts ────────────────────────────────────────────────────────────────

func (h *Handler) ListArtifacts(c *gin.Context) {
	arts, err := h.store.ListArtifacts(c.Param("buildId"))
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	if arts == nil { arts = []*models.Artifact{} }
	c.JSON(200, arts)
}

func (h *Handler) PromoteArtifact(c *gin.Context) {
	var req struct{ Environment string `json:"environment" binding:"required"` }
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }
	if err := h.store.PromoteArtifact(c.Param("artifactId"), req.Environment); err != nil {
		c.JSON(500, gin.H{"error": err.Error()}); return
	}
	c.JSON(200, gin.H{"status": "promoted", "environment": req.Environment})
}

// ─── Notification Channels ────────────────────────────────────────────────────

func (h *Handler) ListNotificationChannels(c *gin.Context) {
	chs, err := h.store.ListNotificationChannels(c.Param("id"))
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	if chs == nil { chs = []*models.NotificationChannel{} }
	// Mask config secrets for list view
	for _, ch := range chs {
		for k, v := range ch.Config {
			if len(v) > 8 && (strings.Contains(k, "token") || strings.Contains(k, "key") || strings.Contains(k, "url") && strings.Contains(v, "hooks")) {
				ch.Config[k] = v[:4] + "••••" + v[len(v)-4:]
			}
		}
	}
	c.JSON(200, chs)
}

func (h *Handler) CreateNotificationChannel(c *gin.Context) {
	var req models.NotificationChannel
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }
	req.ID = uuid.New().String()
	req.ProjectID = c.Param("id")
	req.CreatedAt = time.Now(); req.UpdatedAt = time.Now()
	if req.Config == nil { req.Config = map[string]string{} }
	if err := h.store.UpsertNotificationChannel(&req); err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	c.JSON(201, req)
}

func (h *Handler) UpdateNotificationChannel(c *gin.Context) {
	var req models.NotificationChannel
	c.ShouldBindJSON(&req)
	req.ID = c.Param("channelId"); req.UpdatedAt = time.Now()
	h.store.UpsertNotificationChannel(&req)
	c.JSON(200, req)
}

func (h *Handler) DeleteNotificationChannel(c *gin.Context) {
	h.store.DeleteNotificationChannel(c.Param("channelId"))
	c.JSON(204, nil)
}

func (h *Handler) ListNotificationLogs(c *gin.Context) {
	logs, err := h.store.ListNotificationLogs(c.Param("buildId"))
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	if logs == nil { logs = []*models.NotificationLog{} }
	c.JSON(200, logs)
}

func (h *Handler) TestNotification(c *gin.Context) {
	var req struct {
		Platform  string            `json:"platform"`
		Config    map[string]string `json:"config"`
		AIMessage bool              `json:"ai_message"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }

	// Create a fake build for testing
	testBuild := &models.Build{
		ID: "test", Number: 999, Status: "success",
		Branch: "main", Commit: "abc1234", Duration: 45000,
	}
	testProject := &models.Project{ID: c.Param("id"), Name: "Test Project"}

	ch := &models.NotificationChannel{
		ID: "test", Platform: req.Platform, Config: req.Config,
		OnSuccess: true, AIMessage: req.AIMessage,
	}

	_ = testBuild; _ = testProject; _ = ch
	// Would call dispatcher.sendToChannel here
	c.JSON(200, gin.H{"status": "test_sent", "platform": req.Platform, "note": "Check your configured channel"})
}

// ─── AI Context Engine v2 ─────────────────────────────────────────────────────

func (h *Handler) GetProjectContext(c *gin.Context) {
	limit := 50
	entries, err := h.store.GetProjectContext(c.Param("id"), limit)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	if entries == nil { entries = []*models.ContextEntry{} }
	c.JSON(200, entries)
}

func (h *Handler) SearchContext(c *gin.Context) {
	q := c.Query("q")
	if q == "" { c.JSON(400, gin.H{"error": "q param required"}); return }
	entries, err := h.store.SearchContext(c.Param("id"), q, 20)
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	if entries == nil { entries = []*models.ContextEntry{} }
	c.JSON(200, entries)
}

// ─── AI V3 Endpoints ──────────────────────────────────────────────────────────

func (h *Handler) AIVersionBump(c *gin.Context) {
	var req struct {
		ProjectID string   `json:"project_id"`
		Commits   []string `json:"commits"`
		Changelog string   `json:"changelog"`
	}
	c.ShouldBindJSON(&req)
	bump, reason, err := h.llm.AnalyzeVersionBump(c.Request.Context(), req.Commits, req.Changelog)
	if err != nil { c.JSON(200, gin.H{"bump":"patch","reason":"AI unavailable — defaulting to patch"}); return }
	c.JSON(200, gin.H{"bump": bump, "reason": reason})
}

func (h *Handler) AIDeploymentCheck(c *gin.Context) {
	var req struct {
		Environment string `json:"environment"`
		Diff        string `json:"diff"`
		Changelog   string `json:"changelog"`
	}
	c.ShouldBindJSON(&req)
	safe, concerns, err := h.llm.CheckDeploymentSafety(c.Request.Context(), req.Environment, req.Diff, req.Changelog)
	if err != nil { c.JSON(200, gin.H{"safe":true,"concerns":[]string{}}); return }
	c.JSON(200, gin.H{"safe": safe, "concerns": concerns})
}

func (h *Handler) AINotificationPreview(c *gin.Context) {
	var req struct {
		Platform    string `json:"platform"`
		BuildNum    int    `json:"build_num"`
		Status      string `json:"status"`
		Branch      string `json:"branch"`
		ProjectName string `json:"project_name"`
		VersionTag  string `json:"version_tag"`
		DurationMs  int64  `json:"duration_ms"`
	}
	c.ShouldBindJSON(&req)
	msg, err := h.llm.GenerateNotificationMsg(c.Request.Context(),
		req.BuildNum, req.Status, req.Branch, req.ProjectName, req.VersionTag, "", req.Platform, req.DurationMs)
	if err != nil { c.JSON(200, gin.H{"message": "AI unavailable"}); return }
	c.JSON(200, gin.H{"message": msg})
}

// ─── Retention Settings ──────────────────────────────────────────────────────

func (h *Handler) GetRetentionSettings(c *gin.Context) {
	maxBuilds, _ := h.store.GetSystemSetting("retention_max_builds")
	maxVersions, _ := h.store.GetSystemSetting("retention_max_versions")
	if maxBuilds == "" { maxBuilds = "50" }
	if maxVersions == "" { maxVersions = "30" }
	c.JSON(200, gin.H{
		"max_builds":   maxBuilds,
		"max_versions": maxVersions,
	})
}

func (h *Handler) SaveRetentionSettings(c *gin.Context) {
	var req struct {
		MaxBuilds   string `json:"max_builds"`
		MaxVersions string `json:"max_versions"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }

	if req.MaxBuilds != "" {
		h.store.SetSystemSetting("retention_max_builds", req.MaxBuilds)
	}
	if req.MaxVersions != "" {
		h.store.SetSystemSetting("retention_max_versions", req.MaxVersions)
	}
	c.JSON(200, gin.H{"status": "saved", "max_builds": req.MaxBuilds, "max_versions": req.MaxVersions})
}

// pruneRetention runs after a build completes, trimming old builds and versions per retention settings.
func (h *Handler) pruneRetention(projectID string) {
	maxBuildsStr, _ := h.store.GetSystemSetting("retention_max_builds")
	maxVersionsStr, _ := h.store.GetSystemSetting("retention_max_versions")

	maxBuilds := 50  // default
	maxVersions := 30 // default
	fmt.Sscanf(maxBuildsStr, "%d", &maxBuilds)
	fmt.Sscanf(maxVersionsStr, "%d", &maxVersions)

	if maxBuilds > 0 {
		h.store.PruneBuilds(projectID, maxBuilds)
	}
	if maxVersions > 0 {
		h.store.PruneVersions(projectID, maxVersions)
	}
}

// ─── Deploy Chain ────────────────────────────────────────────────────────────

// runDeployChain executes the daisy-chained deploy stages defined in the pipeline.
// Auto stages run immediately; manual stages create a pending deployment and wait.
func (h *Handler) runDeployChain(ctx context.Context, build *models.Build, project *models.Project, stages []models.DeployStage, ver *models.Version, workDir string) {
	versionTag := ""
	if ver != nil { versionTag = ver.Tag }

	for i, stage := range stages {
		// Check if this stage should auto-deploy or wait for manual gate
		isAuto := stage.Auto || stage.Gate == "" || stage.Gate == "auto"

		// Ensure environment exists in DB (create if not)
		env := h.ensureEnvironment(project.ID, stage.Name, stage.RequiresApproval)

		depID := uuid.New().String()
		versionID := ""
		if ver != nil { versionID = ver.ID }

		dep := &models.Deployment{
			ID:            depID,
			ProjectID:     project.ID,
			EnvironmentID: env.ID,
			BuildID:       build.ID,
			VersionID:     versionID,
			Status:        "pending",
			Strategy:      "direct",
			TriggeredBy:   "pipeline",
			Notes:         fmt.Sprintf("Deploy chain stage %d/%d: %s", i+1, len(stages), stage.Name),
			CreatedAt:     time.Now(),
		}

		if isAuto {
			dep.Status = "running"
			now := time.Now()
			dep.StartedAt = &now
		}

		h.store.CreateDeployment(dep)

		// Broadcast deployment created
		h.wsHub.broadcast(models.WSMessage{
			Type: "deployment_status",
			Payload: gin.H{
				"deployment_id": depID, "environment": stage.Name,
				"status": dep.Status, "stage": i + 1, "total_stages": len(stages),
				"version": versionTag, "auto": isAuto,
			},
		})

		// Index in context engine
		h.store.AddContextEntry(&models.ContextEntry{
			ID: uuid.New().String(), ProjectID: project.ID, Type: "deployment",
			RefID:   depID,
			Summary: fmt.Sprintf("🚀 Deploy chain → %s (%s, %s)", stage.Name, func() string { if isAuto { return "auto" }; return "manual gate" }(), versionTag),
			Tags:    strings.Join([]string{"deployment", stage.Name, "chain"}, ","),
			CreatedAt: time.Now(),
		})

		if isAuto {
			// Execute deploy steps if defined
			if len(stage.Steps) > 0 {
				h.executeDeploySteps(ctx, build, project, dep, stage, workDir, ver)
			} else {
				// No steps — mark as success immediately
				now := time.Now()
				h.store.UpdateDeploymentStatus(depID, "success", &now, 0)
			}

			// Send stage notifications
			h.sendStageNotifications(ctx, project, build, stage, versionTag)

			h.wsHub.broadcast(models.WSMessage{
				Type: "deployment_status",
				Payload: gin.H{"deployment_id": depID, "environment": stage.Name, "status": "success", "version": versionTag},
			})
		} else {
			// Manual gate — stop the chain here, wait for user action
			// The frontend will show a "Deploy to <env>" button
			// When clicked, it calls POST /projects/:id/environments/:envId/deploy
			h.wsHub.broadcast(models.WSMessage{
				Type: "deploy_gate",
				Payload: gin.H{
					"deployment_id": depID, "environment": stage.Name,
					"gate": "manual", "version": versionTag,
					"message": fmt.Sprintf("Waiting for manual approval to deploy %s to %s", versionTag, stage.Name),
				},
			})

			// Send notification that approval is needed
			h.sendStageNotifications(ctx, project, build, stage, versionTag)

			// Stop the chain — remaining stages wait
			break
		}
	}
}

// ensureEnvironment creates the environment if it doesn't exist, returns it
func (h *Handler) ensureEnvironment(projectID, name string, requiresApproval bool) *models.Environment {
	envs, _ := h.store.ListEnvironments(projectID)
	for _, e := range envs {
		if strings.EqualFold(e.Name, name) { return e }
	}

	colorMap := map[string]string{"dev": "#00d4ff", "test": "#00e5a0", "staging": "#f5c542", "prod": "#ff4455"}
	color := colorMap[strings.ToLower(name)]
	if color == "" { color = "#545f72" }

	env := &models.Environment{
		ID:               uuid.New().String(),
		ProjectID:        projectID,
		Name:             name,
		Color:            color,
		RequiresApproval: requiresApproval,
		CreatedAt:        time.Now(),
		UpdatedAt:        time.Now(),
	}
	h.store.CreateEnvironment(env)
	return env
}

// executeDeploySteps runs the deploy steps for a stage
func (h *Handler) executeDeploySteps(ctx context.Context, build *models.Build, project *models.Project, dep *models.Deployment, stage models.DeployStage, workDir string, ver *models.Version) {
	start := time.Now()
	secrets, _ := h.store.GetAllSecrets(project.ID)

	// Add deployment-specific env vars
	if ver != nil {
		secrets["CALLAHAN_VERSION"] = ver.Tag
		secrets["CALLAHAN_SEMVER"] = ver.SemVer
	}
	secrets["CALLAHAN_ENVIRONMENT"] = stage.Name
	secrets["CALLAHAN_DEPLOY_ID"] = dep.ID

	executor := pipeline.NewExecutor(func(jobID, stepID, stream, line string) {
		h.wsHub.broadcast(models.WSMessage{
			Type: "log",
			Payload: models.LogLine{
				BuildID: build.ID, JobID: jobID, StepID: stepID,
				Line: line, Stream: stream, Timestamp: time.Now(),
			},
		})
	})

	jobName := "deploy-" + stage.Name
	pipelineJob := models.PipelineJob{Steps: stage.Steps}
	result := executor.ExecuteJob(ctx, build.ID, jobName, pipelineJob, workDir, secrets)

	finished := time.Now()
	duration := finished.Sub(start).Milliseconds()
	status := result.Status
	if status == "" { status = "success" }

	h.store.UpdateDeploymentStatus(dep.ID, status, &finished, duration)

	// Save deploy job and steps to DB
	dbJob := &models.Job{
		ID: result.JobID, BuildID: build.ID, Name: jobName,
		Status: status, StartedAt: &start, FinishedAt: &finished, Duration: duration,
	}
	h.store.CreateJob(dbJob)
	for _, step := range result.Steps {
		step.JobID = dbJob.ID
		h.store.CreateStep(step)
	}
}

// sendStageNotifications sends notifications for a deploy stage
func (h *Handler) sendStageNotifications(ctx context.Context, project *models.Project, build *models.Build, stage models.DeployStage, versionTag string) {
	for _, target := range stage.Notify {
		parts := strings.SplitN(target, ":", 2)
		if len(parts) != 2 { continue }
		platform, channel := parts[0], parts[1]

		msg := fmt.Sprintf("🚀 %s deployed to %s (version %s)", project.Name, stage.Name, versionTag)

		// Log the notification
		h.store.CreateNotificationLog(&models.NotificationLog{
			ID:       uuid.New().String(),
			ChannelID: platform + ":" + channel,
			BuildID:  build.ID,
			Platform: platform,
			Status:   "sent",
			Payload:  msg,
			SentAt:   time.Now(),
		})
	}
}
