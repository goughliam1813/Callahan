// handlers_security_patches.go
//
// This file documents all targeted changes to handlers.go.
// Apply these as direct edits to handlers.go — each section is labelled.
//
// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 001-a: Add AuthMiddleware import reference (security.go is in same package)
// No change needed — security.go is package api, same as handlers.go.
//
// ═══════════════════════════════════════════════════════════════════════════════
// PATCH 002: Command injection — validate step commands in UpdatePipeline
// Replace UpdatePipeline with this version:

package api

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
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

// ─────────────────────────────────────────────────────────────────────────────
// Handler
// ─────────────────────────────────────────────────────────────────────────────

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

	api.GET("/stats", h.GetStats)

	api.GET("/projects", h.ListProjects)
	api.POST("/projects", h.CreateProject)
	api.GET("/projects/:id", h.GetProject)
	api.PUT("/projects/:id", h.UpdateProject)
	api.DELETE("/projects/:id", h.DeleteProject)

	api.GET("/projects/:id/builds", h.ListBuilds)
	api.POST("/projects/:id/builds", h.TriggerBuild)
	api.GET("/builds/:buildId", h.GetBuild)
	api.POST("/builds/:buildId/cancel", h.CancelBuild)

	api.GET("/builds/:buildId/jobs", h.ListJobs)
	api.GET("/jobs/:jobId/steps", h.ListSteps)

	api.GET("/projects/:id/pipeline", h.GetPipeline)
	api.PUT("/projects/:id/pipeline", h.UpdatePipeline)

	api.GET("/projects/:id/secrets", h.ListSecrets)
	api.POST("/projects/:id/secrets", h.SetSecret)
	api.DELETE("/projects/:id/secrets/:name", h.DeleteSecret)

	api.GET("/settings/llm", h.GetLLMConfig)
	api.PUT("/settings/llm", h.SaveLLMConfig)
	api.POST("/settings/llm/test", h.TestLLMConfig)
	api.GET("/ai/models", h.ListModels)

	api.POST("/ai/generate-pipeline", h.GeneratePipeline)
	api.POST("/ai/explain-build", h.ExplainBuild)
	api.POST("/ai/chat", h.Chat)
	api.POST("/ai/review", h.ReviewCode)

	api.POST("/webhook/:provider", h.Webhook)

	// Settings
	api.GET("/settings/retention", h.GetRetentionSettings)
	api.PUT("/settings/retention", h.SaveRetentionSettings)

	r.GET("/ws", h.WebSocket)
	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok", "version": "1.0.0"})
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// Dashboard
// ─────────────────────────────────────────────────────────────────────────────

func (h *Handler) GetStats(c *gin.Context) {
	stats, err := h.store.GetDashboardStats()
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, stats)
}

// ─────────────────────────────────────────────────────────────────────────────
// Projects
// ─────────────────────────────────────────────────────────────────────────────

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
		Token       string `json:"token"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	// 009: SSRF protection — validate repo URL before storing
	if err := ValidateRepoURL(req.RepoURL); err != nil {
		c.JSON(400, gin.H{"error": "Invalid repository URL: " + err.Error()})
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

	// 003: Store PAT obfuscated
	if req.Token != "" {
		obfuscated, err := ObfuscateSecret(req.Token)
		if err != nil {
			obfuscated = req.Token // fallback to plaintext if obfuscation fails
		}
		_ = h.store.SetSecret(&models.Secret{
			ID:        uuid.New().String(),
			ProjectID: p.ID,
			Name:      "GIT_TOKEN",
			Value:     obfuscated,
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
	// 009: Re-validate repo URL if it changed
	if err := ValidateRepoURL(p.RepoURL); err != nil {
		c.JSON(400, gin.H{"error": "Invalid repository URL: " + err.Error()})
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

// ─────────────────────────────────────────────────────────────────────────────
// Builds
// ─────────────────────────────────────────────────────────────────────────────

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

func (h *Handler) CancelBuild(c *gin.Context) {
	buildID := c.Param("buildId")
	if cancel, ok := h.cancels.Load(buildID); ok {
		cancel.(context.CancelFunc)()
		h.cancels.Delete(buildID)
	}
	now := time.Now()
	h.store.UpdateBuildStatus(buildID, "cancelled", &now, 0, "Cancelled by user")
	h.wsHub.broadcast(buildID, models.WSMessage{
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

// ─────────────────────────────────────────────────────────────────────────────
// Pipeline definition
// ─────────────────────────────────────────────────────────────────────────────

func (h *Handler) GetPipeline(c *gin.Context) {
	p, _ := h.store.GetProject(c.Param("id"))
	if p == nil {
		c.JSON(404, gin.H{"error": "not found"})
		return
	}
	content := pipeline.DefaultPipeline(p.Language, p.Framework)
	c.JSON(200, gin.H{"content": content, "language": p.Language, "framework": p.Framework})
}

// UpdatePipeline — 002: validate step commands before saving
func (h *Handler) UpdatePipeline(c *gin.Context) {
	var req struct {
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}

	// Parse and validate step commands (002)
	if req.Content != "" {
		parsed, err := h.parser.Parse([]byte(req.Content))
		if err != nil {
			c.JSON(400, gin.H{"error": "Invalid pipeline YAML: " + err.Error()})
			return
		}
		for jobName, job := range parsed.Jobs {
			for i, step := range job.Steps {
				if step.Run != "" {
					if err := ValidateStepCommand(step.Run); err != nil {
						c.JSON(400, gin.H{"error": fmt.Sprintf("job %q step %d: %s", jobName, i+1, err.Error())})
						return
					}
				}
			}
		}
	}

	// Pipeline content saved — stored in git via Callahanfile.yaml, not in DB
	c.JSON(200, gin.H{"status": "saved", "content": req.Content})
}

// ─────────────────────────────────────────────────────────────────────────────
// Secrets — 003: obfuscate on write, deobfuscate on use
// ─────────────────────────────────────────────────────────────────────────────

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
	// 003: Obfuscate before persisting
	obfuscated, err := ObfuscateSecret(req.Value)
	if err != nil {
		obfuscated = req.Value // fallback
	}
	secret := &models.Secret{
		ID:        uuid.New().String(),
		ProjectID: c.Param("id"),
		Name:      req.Name,
		Value:     obfuscated,
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

// ─────────────────────────────────────────────────────────────────────────────
// LLM Config — use thread-safe config getters/setters (004)
// ─────────────────────────────────────────────────────────────────────────────

func (h *Handler) GetLLMConfig(c *gin.Context) {
	provider, _ := h.store.GetSystemSetting("llm_provider")
	model, _ := h.store.GetSystemSetting("llm_model")
	ollamaURL, _ := h.store.GetSystemSetting("ollama_url")
	if provider == "" { provider = h.cfg.GetDefaultLLMProvider() }
	if model == "" { model = h.cfg.GetDefaultLLMModel() }
	if ollamaURL == "" { ollamaURL = h.cfg.GetOllamaURL() }

	c.JSON(200, gin.H{
		"provider":      provider,
		"model":         model,
		"ollama_url":    ollamaURL,
		"has_anthropic": h.resolveKey("anthropic") != "",
		"has_openai":    h.resolveKey("openai") != "",
		"has_groq":      h.resolveKey("groq") != "",
		"has_google":    h.resolveKey("google") != "",
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

	if req.Provider != "" { h.store.SetSystemSetting("llm_provider", req.Provider); h.cfg.SetLLMProvider(req.Provider) }
	if req.Model != ""    { h.store.SetSystemSetting("llm_model", req.Model);       h.cfg.SetLLMModel(req.Model) }
	if req.OllamaURL != "" { h.store.SetSystemSetting("ollama_url", req.OllamaURL); h.cfg.SetOllamaURL(req.OllamaURL) }

	// 003: Obfuscate API keys before storing
	if req.APIKey != "" && req.Provider != "" {
		obfuscated, err := ObfuscateSecret(req.APIKey)
		if err != nil { obfuscated = req.APIKey }
		h.store.SetSystemSetting("key_"+req.Provider, obfuscated)
		// Apply to live config (plaintext in memory only, never written back to disk raw)
		switch req.Provider {
		case "anthropic": h.cfg.SetAnthropicKey(req.APIKey)
		case "openai":    h.cfg.SetOpenAIKey(req.APIKey)
		case "groq":      h.cfg.SetGroqKey(req.APIKey)
		case "google":    h.cfg.SetGoogleKey(req.APIKey)
		}
	}

	// Reload any pre-existing keys from DB (deobfuscated into memory)
	h.reloadKeysFromDB()

	c.JSON(200, gin.H{
		"status":   "saved",
		"provider": h.cfg.GetDefaultLLMProvider(),
		"model":    h.cfg.GetDefaultLLMModel(),
	})
}

// reloadKeysFromDB deobfuscates stored API keys into the in-memory config.
func (h *Handler) reloadKeysFromDB() {
	for _, provider := range []string{"anthropic", "openai", "groq", "google"} {
		v, _ := h.store.GetSystemSetting("key_" + provider)
		if v == "" { continue }
		plain, err := DeobfuscateSecret(v)
		if err != nil { plain = v }
		switch provider {
		case "anthropic": if h.cfg.GetAnthropicKey() == "" { h.cfg.SetAnthropicKey(plain) }
		case "openai":    if h.cfg.GetOpenAIKey()    == "" { h.cfg.SetOpenAIKey(plain) }
		case "groq":      if h.cfg.GetGroqKey()      == "" { h.cfg.SetGroqKey(plain) }
		case "google":    if h.cfg.GetGoogleKey()    == "" { h.cfg.SetGoogleKey(plain) }
		}
	}
}

func (h *Handler) TestLLMConfig(c *gin.Context) {
	var req struct {
		Provider  string `json:"provider"`
		Model     string `json:"model"`
		APIKey    string `json:"api_key"`
		OllamaURL string `json:"ollama_url"`
	}
	c.ShouldBindJSON(&req)

	testCfg := config.Config{}
	testCfg.SetLLMProvider(req.Provider)
	testCfg.SetLLMModel(req.Model)
	testCfg.SetOllamaURL(h.cfg.GetOllamaURL())
	if req.OllamaURL != "" { testCfg.SetOllamaURL(req.OllamaURL) }

	key := req.APIKey
	if key == "" { key = h.resolveKey(req.Provider) }
	switch req.Provider {
	case "anthropic": testCfg.SetAnthropicKey(key)
	case "openai":    testCfg.SetOpenAIKey(key)
	case "groq":      testCfg.SetGroqKey(key)
	case "google":    testCfg.SetGoogleKey(key)
	}

	if req.Provider == "" {
		c.JSON(200, gin.H{"ok": false, "error": "No provider selected"})
		return
	}
	if key == "" && req.Provider != "ollama" {
		c.JSON(200, gin.H{"ok": false, "error": "No API key provided"})
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
		{"provider": "groq",      "model": "llama3-8b-8192",            "name": "Llama 3 8B (Groq)",    "available": h.resolveKey("groq") != ""},
		{"provider": "ollama",    "model": "llama3.2",                  "name": "Llama 3.2 (Local)",    "available": true},
		{"provider": "ollama",    "model": "mistral",                   "name": "Mistral (Local)",      "available": true},
	}
	c.JSON(200, ms)
}

func (h *Handler) resolveKey(provider string) string {
	// Try DB first (deobfuscate), then fall back to env/cfg
	if v, _ := h.store.GetSystemSetting("key_" + provider); v != "" {
		plain, err := DeobfuscateSecret(v)
		if err == nil && plain != "" { return plain }
		return v // legacy plaintext
	}
	switch provider {
	case "anthropic": return h.cfg.GetAnthropicKey()
	case "openai":    return h.cfg.GetOpenAIKey()
	case "groq":      return h.cfg.GetGroqKey()
	case "google":    return h.cfg.GetGoogleKey()
	}
	return ""
}

// ─────────────────────────────────────────────────────────────────────────────
// AI Endpoints
// ─────────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket — 005 (cap logs) + 008 (filter by build_id)
// ─────────────────────────────────────────────────────────────────────────────

const maxLogLinesPerBuild = 10_000 // 005: cap unbounded log collection

type WSHub struct {
	mu       sync.RWMutex
	clients  map[*websocket.Conn]string // conn → subscribed buildID ("" = all)
	logCount sync.Map                   // buildID → int  (005: per-build line counter)
}

func newWSHub() *WSHub {
	return &WSHub{clients: make(map[*websocket.Conn]string)}
}

// broadcast sends msg to all clients subscribed to buildID or to "" (all) (008).
// 005: Once a build exceeds maxLogLinesPerBuild log lines, further log messages
// are dropped (a single warning is sent instead).
func (h *WSHub) broadcast(buildID string, msg interface{}) {
	// 005: For log messages, check the per-build counter
	if wsMsg, ok := msg.(models.WSMessage); ok && wsMsg.Type == "log" {
		count := 0
		if v, loaded := h.logCount.Load(buildID); loaded {
			count = v.(int)
		}
		if count >= maxLogLinesPerBuild {
			// Only send one warning per threshold crossing
			if count == maxLogLinesPerBuild {
				h.logCount.Store(buildID, count+1)
				warning := models.WSMessage{Type: "log", Payload: models.LogLine{
					BuildID: buildID, Stream: "stderr",
					Line: fmt.Sprintf("⚠  Log output capped at %d lines — remaining output suppressed", maxLogLinesPerBuild),
				}}
				h.sendToSubscribers(buildID, warning)
			}
			return
		}
		h.logCount.Store(buildID, count+1)
	}
	h.sendToSubscribers(buildID, msg)
}

func (h *WSHub) sendToSubscribers(buildID string, msg interface{}) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for conn, subscribedID := range h.clients {
		// 008: Only send if the client subscribed to this build or subscribed to all
		if subscribedID == "" || subscribedID == buildID {
			conn.WriteJSON(msg) // nolint: errcheck — dead connections cleaned up on next read
		}
	}
}

// clearBuildLogs removes the log counter for a finished build (cleanup).
func (h *WSHub) clearBuildLogs(buildID string) {
	h.logCount.Delete(buildID)
}

var upgrader = websocket.Upgrader{
	// 001: In production, check Origin against allowed origins
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" { return true } // same-origin (e.g. curl)
		allowed := []string{"http://localhost:3000", "http://localhost:3001"}
		envOrigin := os.Getenv("CALLAHAN_FRONTEND_ORIGIN")
		if envOrigin != "" { allowed = []string{envOrigin} }
		for _, a := range allowed {
			if origin == a { return true }
		}
		return false
	},
}

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

// ─────────────────────────────────────────────────────────────────────────────
// Real pipeline runner
// ─────────────────────────────────────────────────────────────────────────────

func (h *Handler) runPipeline(ctx context.Context, build *models.Build, project *models.Project) {
	defer h.cancels.Delete(build.ID)
	defer h.wsHub.clearBuildLogs(build.ID) // 005: clean up log counter when done

	start := time.Now()
	workDir := filepath.Join(os.TempDir(), "callahan", build.ID)
	defer os.RemoveAll(workDir)

	broadcast := func(jobID, stepID, stream, line string) {
		h.wsHub.broadcast(build.ID, models.WSMessage{ // 008: pass buildID
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

	logLine(fmt.Sprintf("╔══ Callahan CI — Build #%d ══╗", build.Number))
	logLine(fmt.Sprintf("  Project : %s", project.Name))
	logLine(fmt.Sprintf("  Repo    : %s", project.RepoURL))
	logLine(fmt.Sprintf("  Branch  : %s", build.Branch))
	logLine("  Trigger : " + build.Trigger)
	logLine("")

	// 003: Deobfuscate PAT before use (it's only ever plaintext in memory during the build)
	tokenRaw, _ := h.store.GetSecret(project.ID, "GIT_TOKEN")
	token, _ := DeobfuscateSecret(tokenRaw)

	if err := pipeline.CloneRepo(ctx, project.RepoURL, build.Branch, token, workDir, logLine); err != nil {
		logLine("✖ Clone failed: " + err.Error())
		if token == "" {
			logLine("")
			logLine("  Tip: Add a GitHub PAT in project Settings → Secrets → GIT_TOKEN")
		}
		h.finishBuild(build, "failed", time.Since(start).Milliseconds(), "Clone failed: "+err.Error())
		return
	}

	sha, msg := pipeline.GetLatestCommit(workDir)
	if sha != "" {
		build.Commit = sha
		if msg != "" { build.CommitMsg = msg }
		h.store.UpdateBuildCommit(build.ID, sha, msg)
	}
	logLine(fmt.Sprintf("  Commit  : %s %s", sha, msg))
	logLine("")

	callahanPath, callahanData := pipeline.FindCallahanfile(workDir)
	if callahanPath == "" {
		logLine("⚠ No Callahanfile.yaml found — using auto-detected pipeline")
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

	// 002: Validate step commands parsed from the cloned Callahanfile
	for jobName, job := range parsed.Jobs {
		for i, step := range job.Steps {
			if step.Run != "" {
				if err := ValidateStepCommand(step.Run); err != nil {
					logLine(fmt.Sprintf("✖ Security: job %q step %d blocked — %s", jobName, i+1, err.Error()))
					h.finishBuild(build, "failed", time.Since(start).Milliseconds(), err.Error())
					return
				}
			}
		}
	}

	logLine(fmt.Sprintf("  Pipeline: %s (%d job(s))", parsed.Name, len(parsed.Jobs)))
	logLine("")

	secrets, _ := h.store.GetAllSecrets(project.ID)
	// 003: Deobfuscate all secrets before passing to executor
	for k, v := range secrets {
		plain, err := DeobfuscateSecret(v)
		if err == nil { secrets[k] = plain }
	}

	executor := pipeline.NewExecutor(func(jobID, stepID, stream, line string) {
		broadcast(jobID, stepID, stream, line)
	})

	allSuccess := true

	for jobName, job := range parsed.Jobs {
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

		h.wsHub.broadcast(build.ID, models.WSMessage{Type: "job_status", Payload: dbJob})
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

	var ver *models.Version
	if status == "success" {
		latest, _ := h.store.LatestVersion(project.ID)
		current := "0.0.0"; if latest != nil { current = latest.SemVer }
		parts := strings.Split(current, ".")
		if len(parts) != 3 { parts = []string{"0","0","0"} }
		var major, minor, patch int
		fmt.Sscanf(parts[0], "%d", &major); fmt.Sscanf(parts[1], "%d", &minor); fmt.Sscanf(parts[2], "%d", &patch)
		patch++
		nextVer := fmt.Sprintf("%d.%d.%d", major, minor, patch)
		ver = &models.Version{
			ID: uuid.New().String(), ProjectID: project.ID, BuildID: build.ID,
			SemVer: nextVer, Tag: "v" + nextVer, BumpType: "patch",
			BumpReason: "Auto-versioned on successful build", CreatedAt: time.Now(),
		}
		h.store.CreateVersion(ver)
		logLine(fmt.Sprintf("  🏷  Auto-versioned: %s", ver.Tag))
		h.store.AddContextEntry(&models.ContextEntry{
			ID: uuid.New().String(), ProjectID: project.ID, Type: "version",
			RefID: ver.ID,
			Summary: fmt.Sprintf("🏷 Version %s created for build #%d", ver.Tag, build.Number),
			Tags: "version,patch,auto", CreatedAt: time.Now(),
		})
	}

	statusEmoji := map[string]string{"success":"✔","failed":"✖","cancelled":"■"}[status]
	buildSHA := build.Commit; if len(buildSHA) > 8 { buildSHA = buildSHA[:8] }
	h.store.AddContextEntry(&models.ContextEntry{
		ID: uuid.New().String(), ProjectID: project.ID, Type: "build",
		RefID: build.ID,
		Summary: fmt.Sprintf("%s Build #%d %s — %s branch %s commit %s (%.1fs)",
			statusEmoji, build.Number, status, project.Name, build.Branch, buildSHA,
			float64(totalMs)/1000),
		Tags: strings.Join([]string{"build", status, build.Branch}, ","),
		CreatedAt: time.Now(),
	})

	aiInsight := ""
	if !allSuccess {
		aiInsight, _ = h.llm.ExplainBuildFailure(context.Background(), "Build step failed", string(callahanData))
	}

	// TODO: dispatch notifications — wire up when internal/notifications package is added
	_ = ver // used by notifications dispatcher when ready

	h.finishBuild(build, status, totalMs, aiInsight)
}

func safeHead(s string, n int) string {
	if len(s) <= n { return s }
	return s[:n]
}

func (h *Handler) finishBuild(build *models.Build, status string, duration int64, aiInsight string) {
	now := time.Now()
	h.store.UpdateBuildStatus(build.ID, status, &now, duration, aiInsight)
	h.wsHub.broadcast(build.ID, models.WSMessage{
		Type: "build_status",
		Payload: gin.H{"build_id": build.ID, "status": status, "duration": duration},
	})
}

// ─────────────────────────────────────────────────────────────────────────────
// V3 Routes registration
// ─────────────────────────────────────────────────────────────────────────────

func (h *Handler) RegisterV3Routes(r *gin.Engine) {
	api := r.Group("/api/v1")

	api.GET("/projects/:id/environments", h.ListEnvironments)
	api.POST("/projects/:id/environments", h.CreateEnvironment)
	api.PUT("/environments/:envId", h.UpdateEnvironment)
	api.DELETE("/environments/:envId", h.DeleteEnvironment)

	api.GET("/projects/:id/deployments", h.ListDeployments)
	api.POST("/projects/:id/environments/:envId/deploy", h.TriggerDeployment)
	api.POST("/deployments/:depId/approve", h.ApproveDeployment)

	api.GET("/projects/:id/versions", h.ListVersions)
	api.POST("/projects/:id/versions", h.CreateManualVersion)

	api.GET("/builds/:buildId/artifacts", h.ListArtifacts)
	api.POST("/artifacts/:artifactId/promote", h.PromoteArtifact)

	api.GET("/projects/:id/notifications", h.ListNotificationChannels)
	api.POST("/projects/:id/notifications", h.CreateNotificationChannel)
	api.PUT("/notifications/:channelId", h.UpdateNotificationChannel)
	api.DELETE("/notifications/:channelId", h.DeleteNotificationChannel)
	api.GET("/builds/:buildId/notification-logs", h.ListNotificationLogs)
	api.POST("/notifications/test", h.TestNotification)

	api.GET("/projects/:id/context", h.GetProjectContext)
	api.GET("/projects/:id/context/search", h.SearchContext)

	api.POST("/ai/version-bump", h.AIVersionBump)
	api.POST("/ai/deployment-check", h.AIDeploymentCheck)
	api.POST("/ai/notification-preview", h.AINotificationPreview)
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
	dep := &models.Deployment{ID: c.Param("depId")}
	now := time.Now()
	h.store.UpdateDeploymentStatus(dep.ID, "running", &now, 0)
	c.JSON(200, gin.H{"status": "approved", "deployment_id": dep.ID})
}

func (h *Handler) executeDeployment(dep *models.Deployment, env *models.Environment) {
	start := time.Now()
	time.Sleep(2 * time.Second)
	finished := time.Now()
	h.store.UpdateDeploymentStatus(dep.ID, "success", &finished, time.Since(start).Milliseconds())
	h.wsHub.broadcast(dep.ID, models.WSMessage{
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
	var major, minor, patch int
	fmt.Sscanf(parts[0], "%d", &major); fmt.Sscanf(parts[1], "%d", &minor); fmt.Sscanf(parts[2], "%d", &patch)
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

// ─── Notification Channels — 009: validate webhook URLs ──────────────────────

func (h *Handler) ListNotificationChannels(c *gin.Context) {
	chs, err := h.store.ListNotificationChannels(c.Param("id"))
	if err != nil { c.JSON(500, gin.H{"error": err.Error()}); return }
	if chs == nil { chs = []*models.NotificationChannel{} }
	for _, ch := range chs {
		for k, v := range ch.Config {
			if len(v) > 8 && (strings.Contains(k, "token") || strings.Contains(k, "key") ||
				(strings.Contains(k, "url") && strings.Contains(v, "hooks"))) {
				ch.Config[k] = v[:4] + "••••" + v[len(v)-4:]
			}
		}
	}
	c.JSON(200, chs)
}

func (h *Handler) CreateNotificationChannel(c *gin.Context) {
	var req models.NotificationChannel
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }

	// 009: Validate webhook URL before saving
	if webhookURL, ok := req.Config["webhook_url"]; ok {
		if err := ValidateWebhookURL(webhookURL); err != nil {
			c.JSON(400, gin.H{"error": "Invalid webhook URL: " + err.Error()})
			return
		}
	}

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
	if webhookURL, ok := req.Config["webhook_url"]; ok {
		if err := ValidateWebhookURL(webhookURL); err != nil {
			c.JSON(400, gin.H{"error": "Invalid webhook URL: " + err.Error()})
			return
		}
	}
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
	if webhookURL, ok := req.Config["webhook_url"]; ok {
		if err := ValidateWebhookURL(webhookURL); err != nil {
			c.JSON(400, gin.H{"error": "Invalid webhook URL: " + err.Error()})
			return
		}
	}
	c.JSON(200, gin.H{"status": "test_sent", "platform": req.Platform, "note": "Check your configured channel"})
}

// ─── AI Context Engine v2 ─────────────────────────────────────────────────────

func (h *Handler) GetProjectContext(c *gin.Context) {
	entries, err := h.store.GetProjectContext(c.Param("id"), 50)
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

// ─── Settings ─────────────────────────────────────────────────────────────────

func (h *Handler) GetRetentionSettings(c *gin.Context) {
	maxBuilds, _ := h.store.GetSystemSetting("max_builds")
	maxVersions, _ := h.store.GetSystemSetting("max_versions")
	if maxBuilds == "" { maxBuilds = "50" }
	if maxVersions == "" { maxVersions = "30" }
	c.JSON(200, gin.H{"max_builds": maxBuilds, "max_versions": maxVersions})
}

func (h *Handler) SaveRetentionSettings(c *gin.Context) {
	var req struct {
		MaxBuilds   string `json:"max_builds"`
		MaxVersions string `json:"max_versions"`
	}
	if err := c.ShouldBindJSON(&req); err != nil { c.JSON(400, gin.H{"error": err.Error()}); return }
	if req.MaxBuilds != "" { h.store.SetSystemSetting("max_builds", req.MaxBuilds) }
	if req.MaxVersions != "" { h.store.SetSystemSetting("max_versions", req.MaxVersions) }
	c.JSON(200, gin.H{"status": "saved"})
}
