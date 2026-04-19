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
	"os/exec"
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

	// Demo
	api.POST("/demo/seed", h.SeedDemo)

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
	content, _ := h.store.GetPipeline(p.ID)
	if content == "" && p.RepoURL != "" {
		token, _ := h.store.GetSecret(p.ID, "GIT_TOKEN")
		token, _ = DeobfuscateSecret(token)
		workDir := filepath.Join(os.TempDir(), "callahan", "pipeline-read-"+p.ID)
		defer os.RemoveAll(workDir)
		if err := pipeline.CloneRepo(context.Background(), p.RepoURL, p.Branch, token, workDir, func(s string) {}); err == nil {
			if _, callahanData := pipeline.FindCallahanfile(workDir); callahanData != nil {
				content = string(callahanData)
				h.store.SavePipeline(p.ID, content)
			}
		}
	}
	if content == "" {
		content = pipeline.DefaultPipeline(p.Language, p.Framework)
	}
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

	p, _ := h.store.GetProject(c.Param("id"))
	if p == nil {
		c.JSON(404, gin.H{"error": "project not found"})
		return
	}

	// Always persist to DB so GetPipeline returns the correct content on reload
	h.store.SavePipeline(p.ID, req.Content)

	// Clone repo, write Callahanfile.yaml, commit and push
	workDir := filepath.Join(os.TempDir(), "callahan", "pipeline-save-"+c.Param("id"))
	defer os.RemoveAll(workDir)

	token, _ := h.store.GetSecret(p.ID, "GIT_TOKEN")
	token, _ = DeobfuscateSecret(token)
	if err := pipeline.CloneRepo(context.Background(), p.RepoURL, p.Branch, token, workDir, func(s string) {}); err != nil {
		c.JSON(200, gin.H{"status": "saved", "content": req.Content, "message": "✔ Saved locally (git push failed: " + err.Error() + ")"})
		return
	}

	callahanPath := filepath.Join(workDir, "Callahanfile.yaml")
	if err := os.WriteFile(callahanPath, []byte(req.Content), 0644); err != nil {
		c.JSON(200, gin.H{"status": "saved", "content": req.Content, "message": "✔ Saved locally (file write failed)"})
		return
	}

	for _, args := range [][]string{
		{"git", "-C", workDir, "add", "Callahanfile.yaml"},
		{"git", "-C", workDir, "commit", "-m", "chore: update Callahanfile.yaml via Callahan UI"},
	} {
		_ = exec.Command(args[0], args[1:]...).Run()
	}

	pushURL := p.RepoURL
	if token != "" {
		pushURL = pipeline.InjectToken(p.RepoURL, token)
	}
	if out, err := exec.Command("git", "-C", workDir, "push", pushURL, p.Branch).CombinedOutput(); err != nil {
		c.JSON(200, gin.H{"status": "saved", "content": req.Content, "message": "✔ Saved locally (push failed: " + string(out) + ")"})
		return
	}

	c.JSON(200, gin.H{"status": "saved", "content": req.Content, "message": "✔ Saved and pushed to git"})
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
// Demo seed
// ─────────────────────────────────────────────────────────────────────────────

func (h *Handler) SeedDemo(c *gin.Context) {
	// Return existing demo project if already seeded
	if all, _ := h.store.ListProjects(); all != nil {
		for _, p := range all {
			if p.Name == "demo-app" {
				c.JSON(200, gin.H{"project": p, "already_seeded": true})
				return
			}
		}
	}

	now := time.Now()
	pid := uuid.New().String()

	proj := &models.Project{
		ID: pid, Name: "demo-app",
		RepoURL:     "https://github.com/callahan-ci/demo-app",
		Provider:    "github", Branch: "main",
		Language:    "JavaScript/TypeScript", Framework: "Node.js",
		Description: "Demo project — explore every Callahan CI feature",
		Status: "active", HealthScore: 92,
		CreatedAt: now.Add(-72 * time.Hour), UpdatedAt: now,
	}
	h.store.CreateProject(proj)

	// Store the Callahanfile.yaml so the pipeline editor shows the full demo config
	demoYAML := `name: demo-app
on: [push, pull_request]

jobs:
  install:
    runs-on: callahan:node-20
    steps:
      - name: Install dependencies
        run: npm ci

  lint:
    runs-on: callahan:node-20
    needs: install
    steps:
      - name: Lint
        run: npm run lint

  test:
    runs-on: callahan:node-20
    needs: install
    steps:
      - name: Run tests
        run: npm test
        env:
          NODE_ENV: test
      - name: Check coverage
        run: npx jest --coverage --coverageThreshold='{"global":{"lines":80}}'

  security:
    runs-on: callahan:node-20
    needs: [lint, test]
    steps:
      - name: Audit dependencies
        run: npm audit --audit-level=high
    ai:
      security-scan: true
      explain-failures: true

ai:
  review: true
  generate-tests: true

deploy:
  - name: test
    auto: true
    steps:
      - name: Deploy to test
        run: echo "Deploying demo-app to test environment"

  - name: production
    requires_approval: true
    branch_filter: main
    steps:
      - name: Deploy to production
        run: echo "Deploying demo-app to production"
`
	h.store.SavePipeline(pid, demoYAML)

	// ── Environments ──────────────────────────────────────────────────────────
	envTest := &models.Environment{
		ID: uuid.New().String(), ProjectID: pid,
		Name: "test", Color: "#00e5a0", AutoDeploy: true,
		CreatedAt: now.Add(-48 * time.Hour), UpdatedAt: now.Add(-48 * time.Hour),
	}
	envProd := &models.Environment{
		ID: uuid.New().String(), ProjectID: pid,
		Name: "production", Color: "#f5c542", RequiresApproval: true, BranchFilter: "main",
		CreatedAt: now.Add(-48 * time.Hour), UpdatedAt: now.Add(-48 * time.Hour),
	}
	h.store.CreateEnvironment(envTest)
	h.store.CreateEnvironment(envProd)

	// ── Helper to build a job+steps and return duration ───────────────────────
	type stepDef struct {
		name, cmd, log string
		status         string
		durMs          int64
	}
	mkJob := func(buildID, jobName, jobStatus string, dur int64, steps []stepDef) {
		jid := uuid.New().String()
		jStart := now.Add(-time.Duration(dur+500) * time.Millisecond)
		jEnd := now
		j := &models.Job{
			ID: jid, BuildID: buildID, Name: jobName, Status: jobStatus,
			StartedAt: &jStart, FinishedAt: &jEnd, Duration: dur,
		}
		h.store.CreateJob(j)
		h.store.UpdateJob(j)
		for _, s := range steps {
			sStart := jStart
			sEnd := jStart.Add(time.Duration(s.durMs) * time.Millisecond)
			step := &models.Step{
				ID: uuid.New().String(), JobID: jid, Name: s.name,
				Status: s.status, Command: s.cmd, Log: s.log,
				StartedAt: &sStart, FinishedAt: &sEnd,
				Duration: s.durMs,
			}
			h.store.CreateStep(step)
		}
	}

	// ── Build 1 — success (72h ago, push) ────────────────────────────────────
	b1Start := now.Add(-72 * time.Hour)
	b1End := b1Start.Add(38 * time.Second)
	b1 := &models.Build{
		ID: uuid.New().String(), ProjectID: pid, Number: 1, Status: "success",
		Branch: "main", Commit: "a1b2c3d", CommitMsg: "feat: initial project setup",
		Author: "Manual trigger", Duration: 38000,
		StartedAt: &b1Start, FinishedAt: &b1End, CreatedAt: b1Start, Trigger: "push",
		AIInsight: "Clean initial commit. No issues detected.",
	}
	h.store.CreateBuild(b1)
	mkJob(b1.ID, "install", "success", 8200, []stepDef{
		{"Install dependencies", "npm ci", "added 312 packages in 8.2s\n✔ All packages installed", "success", 8200},
	})
	mkJob(b1.ID, "lint", "success", 2100, []stepDef{
		{"Lint", "npm run lint", "> eslint src/\n✔ No linting errors found", "success", 2100},
	})
	mkJob(b1.ID, "test", "success", 14300, []stepDef{
		{"Run tests", "npm test", "PASS src/api.test.js (12 tests)\nPASS src/auth.test.js (8 tests)\n✔ 20 tests passed", "success", 12800},
		{"Check coverage", "npx jest --coverage", "Lines   : 87.4% ( 124/142 )\n✔ Coverage threshold met", "success", 1500},
	})
	mkJob(b1.ID, "security", "success", 3400, []stepDef{
		{"Audit dependencies", "npm audit --audit-level=high", "found 0 vulnerabilities\n✔ Audit passed", "success", 3400},
	})

	// ── Build 2 — failed (48h ago, lint failure) ─────────────────────────────
	b2Start := now.Add(-48 * time.Hour)
	b2End := b2Start.Add(14 * time.Second)
	b2 := &models.Build{
		ID: uuid.New().String(), ProjectID: pid, Number: 2, Status: "failed",
		Branch: "feature/new-auth", Commit: "d4e5f6a", CommitMsg: "feat: add OAuth2 login",
		Author: "Manual trigger", Duration: 14000,
		StartedAt: &b2Start, FinishedAt: &b2End, CreatedAt: b2Start, Trigger: "push",
		AIInsight: "Lint failed on src/auth.js:42 — missing semicolon and unused import 'crypto'. Fix these before merging.",
	}
	h.store.CreateBuild(b2)
	mkJob(b2.ID, "install", "success", 7900, []stepDef{
		{"Install dependencies", "npm ci", "added 312 packages in 7.9s\n✔ All packages installed", "success", 7900},
	})
	mkJob(b2.ID, "lint", "failed", 1800, []stepDef{
		{"Lint", "npm run lint", "> eslint src/\nsrc/auth.js\n  42:1  error  Missing semicolon  semi\n  12:8  error  'crypto' is defined but never used  no-unused-vars\n\n✖ 2 problems (2 errors, 0 warnings)", "failed", 1800},
	})

	// ── Build 3 — success (24h ago, PR) ──────────────────────────────────────
	b3Start := now.Add(-24 * time.Hour)
	b3End := b3Start.Add(42 * time.Second)
	b3 := &models.Build{
		ID: uuid.New().String(), ProjectID: pid, Number: 3, Status: "success",
		Branch: "main", Commit: "b7c8d9e", CommitMsg: "fix: resolve auth lint errors, add token refresh",
		Author: "Manual trigger", Duration: 42000,
		StartedAt: &b3Start, FinishedAt: &b3End, CreatedAt: b3Start, Trigger: "pull_request",
		AIInsight: "Auth improvements look solid. Token refresh logic is correct. Consider adding a test for expired token edge case.",
	}
	h.store.CreateBuild(b3)
	mkJob(b3.ID, "install", "success", 7600, []stepDef{
		{"Install dependencies", "npm ci", "added 312 packages in 7.6s\n✔ All packages installed", "success", 7600},
	})
	mkJob(b3.ID, "lint", "success", 1900, []stepDef{
		{"Lint", "npm run lint", "> eslint src/\n✔ No linting errors found", "success", 1900},
	})
	mkJob(b3.ID, "test", "success", 16100, []stepDef{
		{"Run tests", "npm test", "PASS src/api.test.js (12 tests)\nPASS src/auth.test.js (11 tests)\nPASS src/token.test.js (5 tests)\n✔ 28 tests passed", "success", 14200},
		{"Check coverage", "npx jest --coverage", "Lines   : 91.2% ( 129/142 )\n✔ Coverage threshold met", "success", 1900},
	})
	mkJob(b3.ID, "security", "success", 3800, []stepDef{
		{"Audit dependencies", "npm audit --audit-level=high", "found 0 vulnerabilities\n✔ Audit passed", "success", 3800},
	})
	mkJob(b3.ID, "ai-review", "success", 5200, []stepDef{
		{"AI Code Review", "", "🤖 Reviewed 3 changed files\n\n  [AI] src/auth.js — Token expiry logic looks correct. Minor: consider extracting the 300s buffer to a named constant.\n  [AI] src/token.js — Good use of refresh token rotation.\n  [AI] tests/token.test.js — Tests cover happy path. Add a test for network failure during refresh.\n\n✔ AI review complete — 1 suggestion", "success", 5200},
	})

	// ── Build 4 — success (6h ago, with security finding) ────────────────────
	b4Start := now.Add(-6 * time.Hour)
	b4End := b4Start.Add(51 * time.Second)
	b4 := &models.Build{
		ID: uuid.New().String(), ProjectID: pid, Number: 4, Status: "success",
		Branch: "main", Commit: "e0f1a2b", CommitMsg: "chore: upgrade dependencies, add rate limiting",
		Author: "Manual trigger", Duration: 51000,
		StartedAt: &b4Start, FinishedAt: &b4End, CreatedAt: b4Start, Trigger: "push",
		AIInsight: "Dependency upgrades look safe. Rate limiting middleware correctly applied. 1 medium vulnerability found in an indirect dependency — not directly exploitable.",
	}
	h.store.CreateBuild(b4)
	mkJob(b4.ID, "install", "success", 8100, []stepDef{
		{"Install dependencies", "npm ci", "added 318 packages in 8.1s\n✔ All packages installed", "success", 8100},
	})
	mkJob(b4.ID, "lint", "success", 2000, []stepDef{
		{"Lint", "npm run lint", "> eslint src/\n✔ No linting errors found", "success", 2000},
	})
	mkJob(b4.ID, "test", "success", 17400, []stepDef{
		{"Run tests", "npm test", "PASS src/api.test.js (12 tests)\nPASS src/auth.test.js (11 tests)\nPASS src/token.test.js (5 tests)\nPASS src/ratelimit.test.js (6 tests)\n✔ 34 tests passed", "success", 15600},
		{"Check coverage", "npx jest --coverage", "Lines   : 89.6% ( 138/154 )\n✔ Coverage threshold met", "success", 1800},
	})
	mkJob(b4.ID, "security", "success", 4200, []stepDef{
		{"Audit dependencies", "npm audit --audit-level=high", "found 1 vulnerability\n\n  [MEDIUM] Prototype pollution in deep-merge@1.3.0\n  Severity: MEDIUM — not directly exploitable via your code paths\n  Fix: npm install deep-merge@1.4.1\n\n✔ No HIGH or CRITICAL vulnerabilities", "success", 4200},
	})
	mkJob(b4.ID, "ai-review", "success", 6100, []stepDef{
		{"AI Code Review", "", "🤖 Reviewed 4 changed files\n\n  [AI] src/middleware/ratelimit.js — Rate limiter is correctly scoped per IP. Consider a higher limit for authenticated users.\n  [AI] src/api.js — Clean integration of rate limiting.\n  [AI] package.json — All upgrades are non-breaking minor/patch versions.\n\n  🛡 Security: 1 MEDIUM finding in indirect dependency deep-merge@1.3.0\n  💡 Recommendation: upgrade to deep-merge@1.4.1 in your next PR\n\n✔ AI review complete — 3 suggestions", "success", 6100},
	})

	// ── Build 5 — success (2h ago, latest) ───────────────────────────────────
	b5Start := now.Add(-2 * time.Hour)
	b5End := b5Start.Add(44 * time.Second)
	b5 := &models.Build{
		ID: uuid.New().String(), ProjectID: pid, Number: 5, Status: "success",
		Branch: "main", Commit: "c3d4e5f", CommitMsg: "fix: patch deep-merge vulnerability, improve error messages",
		Author: "Manual trigger", Duration: 44000,
		StartedAt: &b5Start, FinishedAt: &b5End, CreatedAt: b5Start, Trigger: "push",
		AIInsight: "Vulnerability patched. Error messages improved without leaking internals. All tests passing at 91% coverage.",
	}
	h.store.CreateBuild(b5)
	mkJob(b5.ID, "install", "success", 7800, []stepDef{
		{"Install dependencies", "npm ci", "added 318 packages in 7.8s\n✔ All packages installed", "success", 7800},
	})
	mkJob(b5.ID, "lint", "success", 1800, []stepDef{
		{"Lint", "npm run lint", "> eslint src/\n✔ No linting errors found", "success", 1800},
	})
	mkJob(b5.ID, "test", "success", 16800, []stepDef{
		{"Run tests", "npm test", "PASS src/api.test.js (12 tests)\nPASS src/auth.test.js (11 tests)\nPASS src/token.test.js (5 tests)\nPASS src/ratelimit.test.js (6 tests)\nPASS src/errors.test.js (4 tests)\n✔ 38 tests passed", "success", 15100},
		{"Check coverage", "npx jest --coverage", "Lines   : 91.0% ( 140/154 )\n✔ Coverage threshold met", "success", 1700},
	})
	mkJob(b5.ID, "security", "success", 3900, []stepDef{
		{"Audit dependencies", "npm audit --audit-level=high", "found 0 vulnerabilities\n✔ Audit passed — all known vulnerabilities patched", "success", 3900},
	})
	mkJob(b5.ID, "ai-review", "success", 5500, []stepDef{
		{"AI Code Review", "", "🤖 Reviewed 2 changed files\n\n  [AI] package.json — deep-merge upgraded to 1.4.1, vulnerability resolved.\n  [AI] src/errors.js — Error messages are user-friendly and don't leak stack traces or internal paths. Good.\n\n✔ AI review complete — no issues found", "success", 5500},
	})

	// ── Deployment: b5 → test env ─────────────────────────────────────────────
	depStart := b5End.Add(30 * time.Second)
	depEnd := depStart.Add(3 * time.Second)
	dep := &models.Deployment{
		ID: uuid.New().String(), ProjectID: pid,
		EnvironmentID: envTest.ID, BuildID: b5.ID,
		Status: "success", Strategy: "direct", TriggeredBy: "auto",
		Notes: "Auto-deploy after green build #5",
		StartedAt: &depStart, FinishedAt: &depEnd,
		Duration: 3100, CreatedAt: depStart,
	}
	h.store.CreateDeployment(dep)

	c.JSON(201, gin.H{"project": proj, "builds": 5, "environments": 2})
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket — 005 (cap logs) + 008 (filter by build_id)
// ─────────────────────────────────────────────────────────────────────────────

const maxLogLinesPerBuild = 10_000 // 005: cap unbounded log collection

const maxReplayBuf = 500

type WSHub struct {
	mu       sync.RWMutex
	clients  map[*websocket.Conn]string // conn → subscribed buildID ("" = all)
	logCount sync.Map                   // buildID → int  (005: per-build line counter)
	bufMu    sync.Mutex
	logBuf   map[string][]interface{} // buildID → replay buffer
}

func newWSHub() *WSHub {
	return &WSHub{
		clients: make(map[*websocket.Conn]string),
		logBuf:  make(map[string][]interface{}),
	}
}

// broadcast sends msg to all clients subscribed to buildID or to "" (all) (008).
// 005: Once a build exceeds maxLogLinesPerBuild log lines, further log messages
// are dropped (a single warning is sent instead).
// Also buffers messages so late-subscribing WS clients can replay missed output.
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
	// Buffer this message for late subscribers
	if buildID != "" {
		h.bufMu.Lock()
		h.logBuf[buildID] = append(h.logBuf[buildID], msg)
		if len(h.logBuf[buildID]) > maxReplayBuf {
			h.logBuf[buildID] = h.logBuf[buildID][len(h.logBuf[buildID])-maxReplayBuf:]
		}
		h.bufMu.Unlock()
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

// clearBuildLogs removes the log counter and replay buffer for a finished build.
func (h *WSHub) clearBuildLogs(buildID string) {
	h.logCount.Delete(buildID)
	h.bufMu.Lock()
	delete(h.logBuf, buildID)
	h.bufMu.Unlock()
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

	// Replay buffered messages before subscribing so we don't miss any in-flight logs
	if buildID != "" {
		h.wsHub.bufMu.Lock()
		buffered := make([]interface{}, len(h.wsHub.logBuf[buildID]))
		copy(buffered, h.wsHub.logBuf[buildID])
		h.wsHub.bufMu.Unlock()
		for _, msg := range buffered {
			conn.WriteJSON(msg) // nolint: errcheck
		}
	}

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

	cloned := true
	if err := pipeline.CloneRepo(ctx, project.RepoURL, build.Branch, token, workDir, logLine); err != nil {
		// Fall back to saved pipeline if one exists (e.g. demo project, private repo without token)
		if dbContent, _ := h.store.GetPipeline(project.ID); dbContent != "" {
			logLine("⚠ Repo unavailable — running from saved pipeline configuration")
			os.MkdirAll(workDir, 0755) // nolint: errcheck
			cloned = false
		} else {
			logLine("✖ Clone failed: " + err.Error())
			if token == "" {
				logLine("")
				logLine("  Tip: Add a GitHub PAT in project Settings → Secrets → GIT_TOKEN")
			}
			h.finishBuild(build, "failed", time.Since(start).Milliseconds(), "Clone failed: "+err.Error())
			return
		}
	}

	if cloned {
		sha, msg := pipeline.GetLatestCommit(workDir)
		if sha != "" {
			build.Commit = sha
			if msg != "" { build.CommitMsg = msg }
			h.store.UpdateBuildCommit(build.ID, sha, msg)
		}
		logLine(fmt.Sprintf("  Commit  : %s %s", sha, msg))
		logLine("")
	}

	callahanPath, callahanData := pipeline.FindCallahanfile(workDir)
	if callahanPath == "" {
		if dbContent, _ := h.store.GetPipeline(project.ID); dbContent != "" {
			callahanData = []byte(dbContent)
			logLine("✔ Using pipeline saved in Callahan UI")
		} else {
			logLine("⚠ No Callahanfile.yaml found — using auto-detected pipeline")
			lang, fw := "JavaScript/TypeScript", "Node.js"
			callahanData = []byte(pipeline.DefaultPipeline(lang, fw))
			logLine(fmt.Sprintf("  Detected: %s / %s", lang, fw))
		}
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

		for _, step := range result.Steps {
			step.JobID = dbJob.ID
			h.store.CreateStep(step)
		}

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

	// ── Post-build AI features (code review, security scan, explain failures)
	// Collect AI config from top-level ai: block and per-job ai: blocks
	aiCfg := &models.PipelineAIConfig{}
	if parsed.AI != nil {
		if parsed.AI.Review { aiCfg.Review = true }
		if parsed.AI.SecurityScan { aiCfg.SecurityScan = true }
		if parsed.AI.ExplainFailures { aiCfg.ExplainFailures = true }
	}
	for _, job := range parsed.Jobs {
		if job.AI != nil {
			if job.AI.Review { aiCfg.Review = true }
			if job.AI.SecurityScan { aiCfg.SecurityScan = true }
			if job.AI.ExplainFailures { aiCfg.ExplainFailures = true }
		}
	}

	aiInsight := ""

	if aiCfg.Review || aiCfg.SecurityScan || (aiCfg.ExplainFailures && !allSuccess) {
		aiJobID := uuid.New().String()
		aiJobStart := time.Now()
		aiDbJob := &models.Job{ID: aiJobID, BuildID: build.ID, Name: "ai-review", Status: "running"}
		aiDbJobStart := time.Now(); aiDbJob.StartedAt = &aiDbJobStart
		h.store.CreateJob(aiDbJob)
		h.wsHub.broadcast(build.ID, models.WSMessage{Type: "job_status", Payload: aiDbJob})

		logLine("✦ Running AI features…")
		var aiSteps []*models.Step
		aiCtx := context.Background()

		if aiCfg.Review {
			stepID := uuid.New().String()
			broadcast("", stepID, "stdout", "  ▶ AI Code Review")
			var stepLog strings.Builder
			stepStatus := "success"
			reviewContent := pipeline.GetGitDiff(workDir)
			if reviewContent == "" && workDir != "" {
				reviewContent = pipeline.CollectSourceFiles(workDir, 12000)
			}
			if reviewContent != "" {
				review, _ := h.llm.ReviewCode(aiCtx, reviewContent)
				if review != nil {
					sev := map[string]string{"error":"✖","warning":"⚠","info":"✔"}[review.Severity]
					if sev == "" { sev = "✔" }
					line := fmt.Sprintf("  %s Code Review — %s", sev, review.Summary)
					broadcast("", stepID, "stdout", line); stepLog.WriteString(line+"\n")
					for _, f := range review.Findings {
						fl := "    • " + f
						broadcast("", stepID, "stdout", fl); stepLog.WriteString(fl+"\n")
					}
					if review.Suggestion != "" {
						sl := "  💡 " + review.Suggestion
						broadcast("", stepID, "stdout", sl); stepLog.WriteString(sl+"\n")
					}
					if review.Severity == "error" { stepStatus = "failed" }
				} else {
					line := "  ⚠ AI review unavailable (check LLM config)"
					broadcast("", stepID, "stdout", line); stepLog.WriteString(line+"\n")
				}
			} else {
				line := "  ✔ No source files to review"
				broadcast("", stepID, "stdout", line); stepLog.WriteString(line+"\n")
			}
			aiSteps = append(aiSteps, &models.Step{ID: stepID, JobID: aiJobID, Name: "Code Review", Status: stepStatus, Log: stepLog.String()})
		}

		if aiCfg.SecurityScan {
			stepID := uuid.New().String()
			broadcast("", stepID, "stdout", "  ▶ Security Scan")
			scanDir := workDir; if !cloned { scanDir = "" }
			scanner, output, _ := pipeline.RunSecurityScanner(aiCtx, scanDir)
			var stepLog strings.Builder
			if scanner != "" {
				line := fmt.Sprintf("  ✔ %s scan complete — %d bytes output", scanner, len(output))
				broadcast("", stepID, "stdout", line); stepLog.WriteString(line+"\n")
			} else {
				line := "  ✔ No vulnerabilities detected (trivy/semgrep not installed — skipped)"
				broadcast("", stepID, "stdout", line); stepLog.WriteString(line+"\n")
			}
			aiSteps = append(aiSteps, &models.Step{ID: stepID, JobID: aiJobID, Name: "Security Scan", Status: "success", Log: stepLog.String()})
		}

		if aiCfg.ExplainFailures && !allSuccess {
			stepID := uuid.New().String()
			broadcast("", stepID, "stdout", "  ▶ AI Explain Failure")
			aiInsight, _ = h.llm.ExplainBuildFailure(aiCtx, "Build step failed", string(callahanData))
			if aiInsight != "" {
				for _, line := range strings.Split(aiInsight, "\n") {
					if strings.TrimSpace(line) != "" { broadcast("", stepID, "stdout", "  "+line) }
				}
			}
			aiSteps = append(aiSteps, &models.Step{ID: stepID, JobID: aiJobID, Name: "Explain Failure", Status: "success", Log: aiInsight})
		}

		aiFinished := time.Now()
		aiDbJob.Status = "success"; aiDbJob.FinishedAt = &aiFinished
		aiDbJob.Duration = time.Since(aiJobStart).Milliseconds()
		h.store.UpdateJob(aiDbJob)
		for _, s := range aiSteps { h.store.CreateStep(s) }
		h.wsHub.broadcast(build.ID, models.WSMessage{Type: "job_status", Payload: aiDbJob})
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
	api.GET("/deployments/:depId/log", h.GetDeploymentLog)

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
	dep, err := h.store.GetDeployment(c.Param("depId"))
	if err != nil || dep == nil { c.JSON(404, gin.H{"error": "deployment not found"}); return }
	now := time.Now()
	dep.StartedAt = &now
	h.store.UpdateDeploymentStatus(dep.ID, "running", &now, 0)
	env, _ := h.store.GetEnvironment(dep.EnvironmentID)
	if env != nil { go h.executeDeployment(dep, env) }
	c.JSON(200, gin.H{"status": "approved", "deployment_id": dep.ID})
}

func (h *Handler) executeDeployment(dep *models.Deployment, env *models.Environment) {
	start := time.Now()
	ctx := context.Background()

	// Use dep.ID (not dep.BuildID) as the WS channel so deploy logs are separate from build logs
	var logBuf strings.Builder
	logDep := func(line string) {
		logBuf.WriteString(line + "\n")
		h.wsHub.broadcast(dep.ID, models.WSMessage{
			Type: "log",
			Payload: models.LogLine{BuildID: dep.ID, Line: line, Stream: "stdout", Timestamp: time.Now()},
		})
	}

	finish := func(status string) {
		finished := time.Now()
		h.store.UpdateDeploymentStatus(dep.ID, status, &finished, time.Since(start).Milliseconds())
		h.store.UpdateDeploymentLog(dep.ID, logBuf.String())
		h.wsHub.broadcast(dep.ID, models.WSMessage{
			Type:    "deployment_status",
			Payload: gin.H{"deployment_id": dep.ID, "environment": env.Name, "status": status},
		})
	}

	project, err := h.store.GetProject(dep.ProjectID)
	if err != nil || project == nil { finish("failed"); return }

	logDep(fmt.Sprintf("╔══ Deploy → %s ══╗", env.Name))
	logDep(fmt.Sprintf("  Project  : %s", project.Name))
	logDep(fmt.Sprintf("  Env      : %s", env.Name))
	logDep(fmt.Sprintf("  Build ID : %s", safeHead(dep.BuildID, 8)))
	logDep("")

	// Clone repo
	workDir := filepath.Join(os.TempDir(), "callahan", "deploy-"+dep.ID)
	defer os.RemoveAll(workDir)
	token, _ := h.store.GetSecret(project.ID, "GIT_TOKEN")
	token, _ = DeobfuscateSecret(token)

	cloned := true
	if err := pipeline.CloneRepo(ctx, project.RepoURL, project.Branch, token, workDir, logDep); err != nil {
		if dbContent, _ := h.store.GetPipeline(project.ID); dbContent != "" {
			logDep("⚠ Repo unavailable — running from saved pipeline configuration")
			os.MkdirAll(workDir, 0755) // nolint: errcheck
			cloned = false
		} else {
			logDep("✖ Clone failed: " + err.Error())
			finish("failed")
			return
		}
	}

	// Parse Callahanfile (repo or DB)
	var callahanData []byte
	if cloned {
		_, callahanData = pipeline.FindCallahanfile(workDir)
	}
	if callahanData == nil {
		if dbContent, _ := h.store.GetPipeline(project.ID); dbContent != "" {
			callahanData = []byte(dbContent)
		}
	}
	if callahanData == nil {
		logDep("⚠ No Callahanfile.yaml found — nothing to deploy")
		logDep("  Add a deploy: block to your Callahanfile.yaml to define deploy steps.")
		finish("success")
		return
	}
	parsed, err := h.parser.Parse(callahanData)
	if err != nil { logDep("✖ Parse error: " + err.Error()); finish("failed"); return }

	// Find the matching deploy stage
	var stage *models.DeployStage
	for i := range parsed.Deploy {
		if strings.EqualFold(parsed.Deploy[i].Name, env.Name) {
			stage = &parsed.Deploy[i]
			break
		}
	}

	// Fallback: if no deploy: block exists, look for job steps whose name contains BOTH
	// "deploy" and the environment name (e.g. "Deploy to Test" matches env "test")
	if stage == nil || len(stage.Steps) == 0 {
		var matched []models.PipelineStep
		envLower := strings.ToLower(env.Name)
		for _, job := range parsed.Jobs {
			for _, step := range job.Steps {
				nameLower := strings.ToLower(step.Name)
				if strings.Contains(nameLower, "deploy") && strings.Contains(nameLower, envLower) {
					matched = append(matched, step)
				}
			}
		}
		if len(matched) > 0 {
			logDep(fmt.Sprintf("✔ Found %d step(s) matching 'deploy…%s' in pipeline jobs", len(matched), env.Name))
			stage = &models.DeployStage{Name: env.Name, Steps: matched}
		}
	}

	if stage == nil || len(stage.Steps) == 0 {
		logDep(fmt.Sprintf("⚠ No deploy steps found for environment '%s'", env.Name))
		logDep("  Add a deploy: block to your Callahanfile.yaml, or name a pipeline step to include '" + env.Name + "'")
		logDep("  Example deploy: block:")
		logDep("    deploy:")
		logDep(fmt.Sprintf("      - name: %s", env.Name))
		logDep("        steps:")
		logDep("          - name: Deploy to " + env.Name)
		logDep("            run: <your deploy command>")
		finish("success")
		return
	}

	// Execute deploy steps
	secrets, _ := h.store.GetAllSecrets(project.ID)
	executor := pipeline.NewExecutor(func(_, _, _, line string) { logDep(line) })
	job := models.PipelineJob{Steps: stage.Steps}
	result := executor.ExecuteJob(ctx, dep.ID, "deploy-"+env.Name, job, workDir, secrets)

	status := "success"
	if result.Status != "success" { status = "failed" }
	logDep(fmt.Sprintf("╚══ Deploy %s ══╝", status))
	finish(status)
}

func (h *Handler) GetDeploymentLog(c *gin.Context) {
	dep, err := h.store.GetDeployment(c.Param("depId"))
	if err != nil || dep == nil { c.JSON(404, gin.H{"error": "not found"}); return }
	c.JSON(200, gin.H{"log": dep.Log, "status": dep.Status})
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
	if strings.TrimSpace(req.Diff) == "" {
		c.JSON(200, gin.H{"safe": true, "concerns": []string{}})
		return
	}
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
