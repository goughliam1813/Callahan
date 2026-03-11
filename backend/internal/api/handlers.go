package api

import (
	"context"
	"fmt"
	"net/http"
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

type Handler struct {
	store    *storage.Store
	llm      *llm.Client
	cfg      *config.Config
	parser   *pipeline.Parser
	wsHub    *WSHub
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

	// Pipeline
	api.GET("/projects/:id/pipeline", h.GetPipeline)
	api.PUT("/projects/:id/pipeline", h.UpdatePipeline)

	// Secrets
	api.GET("/projects/:id/secrets", h.ListSecrets)
	api.POST("/projects/:id/secrets", h.SetSecret)
	api.DELETE("/projects/:id/secrets/:name", h.DeleteSecret)

	// AI endpoints
	api.POST("/ai/generate-pipeline", h.GeneratePipeline)
	api.POST("/ai/explain-build", h.ExplainBuild)
	api.POST("/ai/chat", h.Chat)
	api.POST("/ai/review", h.ReviewCode)
	api.GET("/ai/models", h.ListModels)

	// Webhooks
	api.POST("/webhook/:provider", h.Webhook)

	// WebSocket
	r.GET("/ws", h.WebSocket)

	// Health
	r.GET("/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok", "version": "1.0.0"})
	})
}

// GetStats returns dashboard statistics
func (h *Handler) GetStats(c *gin.Context) {
	stats, err := h.store.GetDashboardStats()
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, stats)
}

// ListProjects returns all projects
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

// CreateProject creates a new project
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

	if req.Provider == "" {
		req.Provider = "github"
	}
	if req.Branch == "" {
		req.Branch = "main"
	}

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
	c.JSON(201, p)
}

func (h *Handler) GetProject(c *gin.Context) {
	p, err := h.store.GetProject(c.Param("id"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if p == nil {
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

// ListBuilds returns builds for a project
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

// TriggerBuild starts a new build
func (h *Handler) TriggerBuild(c *gin.Context) {
	projectID := c.Param("id")
	p, err := h.store.GetProject(projectID)
	if err != nil || p == nil {
		c.JSON(404, gin.H{"error": "project not found"})
		return
	}

	var req struct {
		Branch  string `json:"branch"`
		Commit  string `json:"commit"`
		Message string `json:"message"`
		Trigger string `json:"trigger"`
	}
	c.ShouldBindJSON(&req)
	if req.Branch == "" {
		req.Branch = p.Branch
	}
	if req.Trigger == "" {
		req.Trigger = "manual"
	}

	num, _ := h.store.GetNextBuildNumber(projectID)
	now := time.Now()
	build := &models.Build{
		ID:        uuid.New().String(),
		ProjectID: projectID,
		Number:    num,
		Status:    "running",
		Branch:    req.Branch,
		Commit:    req.Commit,
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

	// Run pipeline asynchronously
	go h.runPipeline(build, p)

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
	now := time.Now()
	h.store.UpdateBuildStatus(c.Param("buildId"), "cancelled", &now, 0, "")
	c.JSON(200, gin.H{"status": "cancelled"})
}

func (h *Handler) ListJobs(c *gin.Context) {
	jobs, err := h.store.ListJobs(c.Param("buildId"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if jobs == nil {
		jobs = []*models.Job{}
	}
	c.JSON(200, jobs)
}

func (h *Handler) ListSteps(c *gin.Context) {
	steps, err := h.store.ListSteps(c.Param("jobId"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if steps == nil {
		steps = []*models.Step{}
	}
	c.JSON(200, steps)
}

func (h *Handler) GetPipeline(c *gin.Context) {
	// In a real impl, read from repo
	p, _ := h.store.GetProject(c.Param("id"))
	if p == nil {
		c.JSON(404, gin.H{"error": "not found"})
		return
	}
	content := pipeline.DefaultPipeline(p.Language, p.Framework)
	c.JSON(200, gin.H{"content": content, "language": p.Language, "framework": p.Framework})
}

func (h *Handler) UpdatePipeline(c *gin.Context) {
	var req struct {
		Content string `json:"content"`
	}
	c.ShouldBindJSON(&req)
	c.JSON(200, gin.H{"status": "saved", "content": req.Content})
}

func (h *Handler) ListSecrets(c *gin.Context) {
	names, err := h.store.ListSecretNames(c.Param("id"))
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	if names == nil {
		names = []string{}
	}
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
		Value:     req.Value, // TODO: encrypt
		CreatedAt: time.Now(),
	}
	if err := h.store.SetSecret(secret); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(201, gin.H{"name": req.Name})
}

func (h *Handler) DeleteSecret(c *gin.Context) {
	c.JSON(204, nil)
}

// AI Endpoints

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
		// Fall back to template
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
		Messages []models.LLMConfig `json:"messages"`
		RawMsgs  []llm.Message      `json:"raw_messages"`
		Context  string             `json:"context"`
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
	var req struct {
		Diff string `json:"diff"`
	}
	c.ShouldBindJSON(&req)

	review, err := h.llm.ReviewCode(c.Request.Context(), req.Diff)
	if err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}
	c.JSON(200, review)
}

func (h *Handler) ListModels(c *gin.Context) {
	models := []gin.H{
		{"provider": "anthropic", "model": "claude-3-5-sonnet-20241022", "name": "Claude 3.5 Sonnet", "available": h.cfg.AnthropicKey != ""},
		{"provider": "anthropic", "model": "claude-3-haiku-20240307", "name": "Claude 3 Haiku", "available": h.cfg.AnthropicKey != ""},
		{"provider": "openai", "model": "gpt-4o", "name": "GPT-4o", "available": h.cfg.OpenAIKey != ""},
		{"provider": "openai", "model": "gpt-4o-mini", "name": "GPT-4o Mini", "available": h.cfg.OpenAIKey != ""},
		{"provider": "groq", "model": "llama-3.1-70b-versatile", "name": "Llama 3.1 70B (Groq)", "available": h.cfg.GroqKey != ""},
		{"provider": "ollama", "model": "llama3.2", "name": "Llama 3.2 (Local)", "available": true},
	}
	c.JSON(200, models)
}

func (h *Handler) Webhook(c *gin.Context) {
	provider := c.Param("provider")
	c.JSON(200, gin.H{"provider": provider, "status": "received"})
}

// WebSocket hub for real-time logs
type WSHub struct {
	mu      sync.RWMutex
	clients map[*websocket.Conn]bool
}

func newWSHub() *WSHub {
	return &WSHub{clients: make(map[*websocket.Conn]bool)}
}

func (h *WSHub) broadcast(msg interface{}) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for conn := range h.clients {
		conn.WriteJSON(msg)
	}
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func (h *Handler) WebSocket(c *gin.Context) {
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	h.wsHub.mu.Lock()
	h.wsHub.clients[conn] = true
	h.wsHub.mu.Unlock()

	defer func() {
		h.wsHub.mu.Lock()
		delete(h.wsHub.clients, conn)
		h.wsHub.mu.Unlock()
	}()

	for {
		if _, _, err := conn.ReadMessage(); err != nil {
			break
		}
	}
}

// runPipeline executes the pipeline for a build
func (h *Handler) runPipeline(build *models.Build, project *models.Project) {
	start := time.Now()

	logWriter := func(jobID, stepID, line string) {
		h.wsHub.broadcast(models.WSMessage{
			Type: "log",
			Payload: models.LogLine{
				JobID:     jobID,
				StepID:    stepID,
				Line:      line,
				Stream:    "stdout",
				Timestamp: time.Now(),
			},
		})
	}

	// Get pipeline content (simplified)
	pipelineContent := pipeline.DefaultPipeline(project.Language, project.Framework)
	parsedPipeline, err := h.parser.Parse([]byte(pipelineContent))
	if err != nil {
		h.finishBuild(build, "failed", time.Since(start).Milliseconds(), fmt.Sprintf("Pipeline parse error: %v", err))
		return
	}

	executor := pipeline.NewExecutor(logWriter)
	allSuccess := true

	for jobName, job := range parsedPipeline.Jobs {
		// Create job record
		dbJob := &models.Job{
			ID:      uuid.New().String(),
			BuildID: build.ID,
			Name:    jobName,
			Status:  "running",
		}
		now := time.Now()
		dbJob.StartedAt = &now
		h.store.CreateJob(dbJob)

		result := executor.ExecuteJob(nil, build.ID, jobName, job, nil)

		finished := time.Now()
		dbJob.Status = result.Status
		dbJob.FinishedAt = &finished
		dbJob.Duration = result.Duration
		dbJob.ExitCode = result.ExitCode
		h.store.UpdateJob(dbJob)

		if result.Status != "success" {
			allSuccess = false
		}

		h.wsHub.broadcast(models.WSMessage{
			Type:    "job_status",
			Payload: dbJob,
		})
	}

	status := "success"
	if !allSuccess {
		status = "failed"
	}

	// Get AI insight for the build
	aiInsight := ""
	if !allSuccess {
		ctx := context.Background()
		aiInsight, _ = h.llm.ExplainBuildFailure(ctx, "Build step failed", pipelineContent)
	}

	h.finishBuild(build, status, time.Since(start).Milliseconds(), aiInsight)
}

func (h *Handler) finishBuild(build *models.Build, status string, duration int64, aiInsight string) {
	now := time.Now()
	h.store.UpdateBuildStatus(build.ID, status, &now, duration, aiInsight)
	h.wsHub.broadcast(models.WSMessage{
		Type: "build_status",
		Payload: gin.H{
			"build_id": build.ID,
			"status":   status,
			"duration": duration,
		},
	})
}
