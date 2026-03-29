package llm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/callahan-ci/callahan/pkg/config"
	"github.com/callahan-ci/callahan/pkg/models"
)

// Client is the unified LLM client
type Client struct {
	cfg *config.Config
}

func New(cfg *config.Config) *Client {
	return &Client{cfg: cfg}
}

type Message struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type CompletionRequest struct {
	Messages    []Message
	System      string
	MaxTokens   int
	Temperature float32
	Model       string
	Provider    string
	Stream      bool
}

type CompletionResponse struct {
	Content string
	Model   string
	Usage   struct {
		InputTokens  int
		OutputTokens int
	}
}

// Complete sends a completion request to the configured LLM
func (c *Client) Complete(ctx context.Context, req CompletionRequest) (*CompletionResponse, error) {
	provider := req.Provider
	if provider == "" {
		provider = c.cfg.DefaultLLMProvider
	}
	if req.MaxTokens == 0 {
		req.MaxTokens = 4096
	}
	if req.Temperature == 0 {
		req.Temperature = 0.3
	}

	switch provider {
	case "anthropic":
		return c.anthropicComplete(ctx, req)
	case "openai":
		return c.openaiComplete(ctx, req)
	case "ollama":
		return c.ollamaComplete(ctx, req)
	case "groq":
		return c.groqComplete(ctx, req)
	default:
		// Try anthropic as fallback
		if c.cfg.AnthropicKey != "" {
			return c.anthropicComplete(ctx, req)
		}
		if c.cfg.OpenAIKey != "" {
			return c.openaiComplete(ctx, req)
		}
		return c.ollamaComplete(ctx, req) // local fallback
	}
}

// Anthropic API
func (c *Client) anthropicComplete(ctx context.Context, req CompletionRequest) (*CompletionResponse, error) {
	model := req.Model
	if model == "" {
		model = "claude-sonnet-4-5"
	}

	type AnthropicMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	type AnthropicReq struct {
		Model     string         `json:"model"`
		MaxTokens int            `json:"max_tokens"`
		System    string         `json:"system,omitempty"`
		Messages  []AnthropicMsg `json:"messages"`
	}

	msgs := make([]AnthropicMsg, len(req.Messages))
	for i, m := range req.Messages {
		msgs[i] = AnthropicMsg{Role: m.Role, Content: m.Content}
	}

	body, _ := json.Marshal(AnthropicReq{
		Model:     model,
		MaxTokens: req.MaxTokens,
		System:    req.System,
		Messages:  msgs,
	})

	httpReq, err := http.NewRequestWithContext(ctx, "POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("x-api-key", c.cfg.AnthropicKey)
	httpReq.Header.Set("anthropic-version", "2023-06-01")

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("anthropic request: %w", err)
	}
	defer resp.Body.Close()

	var result struct {
		Content []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
		Usage struct {
			InputTokens  int `json:"input_tokens"`
			OutputTokens int `json:"output_tokens"`
		} `json:"usage"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if result.Error != nil {
		return nil, fmt.Errorf("anthropic error: %s", result.Error.Message)
	}

	var content string
	for _, block := range result.Content {
		if block.Type == "text" {
			content += block.Text
		}
	}

	return &CompletionResponse{
		Content: content,
		Model:   model,
		Usage: struct {
			InputTokens  int
			OutputTokens int
		}{result.Usage.InputTokens, result.Usage.OutputTokens},
	}, nil
}

// OpenAI-compatible API (also used for Groq)
func (c *Client) openaiComplete(ctx context.Context, req CompletionRequest) (*CompletionResponse, error) {
	return c.openaiCompatible(ctx, req, "https://api.openai.com/v1/chat/completions", c.cfg.OpenAIKey, "gpt-4o")
}

func (c *Client) groqComplete(ctx context.Context, req CompletionRequest) (*CompletionResponse, error) {
	return c.openaiCompatible(ctx, req, "https://api.groq.com/openai/v1/chat/completions", c.cfg.GroqKey, "llama-3.3-70b-versatile")
}

func (c *Client) openaiCompatible(ctx context.Context, req CompletionRequest, url, apiKey, defaultModel string) (*CompletionResponse, error) {
	model := req.Model
	if model == "" {
		model = defaultModel
	}

	type OpenAIMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	type OpenAIReq struct {
		Model       string      `json:"model"`
		Messages    []OpenAIMsg `json:"messages"`
		MaxTokens   int         `json:"max_tokens"`
		Temperature float32     `json:"temperature"`
	}

	var msgs []OpenAIMsg
	if req.System != "" {
		msgs = append(msgs, OpenAIMsg{Role: "system", Content: req.System})
	}
	for _, m := range req.Messages {
		msgs = append(msgs, OpenAIMsg{Role: m.Role, Content: m.Content})
	}

	body, _ := json.Marshal(OpenAIReq{
		Model:       model,
		Messages:    msgs,
		MaxTokens:   req.MaxTokens,
		Temperature: req.Temperature,
	})

	httpReq, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("Authorization", "Bearer "+apiKey)

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("openai request: %w", err)
	}
	defer resp.Body.Close()

	var result struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
		} `json:"usage"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	if result.Error != nil {
		return nil, fmt.Errorf("openai error: %s", result.Error.Message)
	}
	if len(result.Choices) == 0 {
		return nil, fmt.Errorf("no choices in response")
	}

	return &CompletionResponse{
		Content: result.Choices[0].Message.Content,
		Model:   model,
	}, nil
}

// Ollama local API
func (c *Client) ollamaComplete(ctx context.Context, req CompletionRequest) (*CompletionResponse, error) {
	model := req.Model
	if model == "" {
		model = "llama3.2"
	}
	baseURL := c.cfg.OllamaURL
	if baseURL == "" {
		baseURL = "http://localhost:11434"
	}

	type OllamaMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	type OllamaReq struct {
		Model    string      `json:"model"`
		Messages []OllamaMsg `json:"messages"`
		Stream   bool        `json:"stream"`
	}

	var msgs []OllamaMsg
	if req.System != "" {
		msgs = append(msgs, OllamaMsg{Role: "system", Content: req.System})
	}
	for _, m := range req.Messages {
		msgs = append(msgs, OllamaMsg{Role: m.Role, Content: m.Content})
	}

	body, _ := json.Marshal(OllamaReq{Model: model, Messages: msgs, Stream: false})

	httpReq, err := http.NewRequestWithContext(ctx, "POST", baseURL+"/api/chat", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	httpReq.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		return nil, fmt.Errorf("ollama not available: %w", err)
	}
	defer resp.Body.Close()

	data, _ := io.ReadAll(resp.Body)
	var result struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	}
	json.Unmarshal(data, &result)
	return &CompletionResponse{Content: result.Message.Content, Model: model}, nil
}

// AI Agent methods

// GeneratePipeline creates a Callahanfile.yaml from natural language
func (c *Client) GeneratePipeline(ctx context.Context, description, language, framework string) (string, error) {
	system := `You are an expert CI/CD pipeline architect. Generate a valid Callahanfile.yaml based on the description.
The format follows GitHub Actions syntax with these additions:
- jobs.<job>.steps can include 'ai:' blocks for AI-powered steps
- Support for: build, test, security scan, deploy
Always include: checkout step, dependency caching, and appropriate test runners.
Return ONLY the YAML content, no explanation.`

	prompt := fmt.Sprintf("Generate a Callahanfile.yaml pipeline for: %s\nLanguage: %s\nFramework: %s", description, language, framework)

	resp, err := c.Complete(ctx, CompletionRequest{
		System:   system,
		Messages: []Message{{Role: "user", Content: prompt}},
		Provider: c.cfg.DefaultLLMProvider,
		Model:    c.cfg.DefaultLLMModel,
	})
	if err != nil {
		return "", err
	}
	// Strip markdown fences if present
	content := strings.TrimSpace(resp.Content)
	content = strings.TrimPrefix(content, "```yaml")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")
	return strings.TrimSpace(content), nil
}

// ExplainBuildFailure analyzes build logs and explains the failure
func (c *Client) ExplainBuildFailure(ctx context.Context, logs, pipeline string) (string, error) {
	system := `You are a CI/CD debugging expert. Analyze the build logs and explain:
1. What went wrong (in plain English, 2-3 sentences)
2. The root cause
3. How to fix it (concrete steps)
Be concise and actionable.`

	prompt := fmt.Sprintf("Build logs:\n```\n%s\n```\n\nPipeline config:\n```yaml\n%s\n```", logs, pipeline)

	resp, err := c.Complete(ctx, CompletionRequest{
		System:   system,
		Messages: []Message{{Role: "user", Content: prompt}},
		Provider: c.cfg.DefaultLLMProvider,
		Model:    c.cfg.DefaultLLMModel,
	})
	if err != nil {
		return "Unable to analyze failure (AI unavailable)", nil
	}
	return resp.Content, nil
}

// ReviewCode performs AI code review
func (c *Client) ReviewCode(ctx context.Context, diff string) (*models.AIReview, error) {
	system := `You are a senior code reviewer. Review the git diff and provide:
1. Summary (1 sentence)
2. Severity: info/warning/error
3. Key findings (max 5 bullet points)
4. Actionable suggestion
Return as JSON: {"severity":"info|warning|error","summary":"...","findings":["..."],"suggestion":"...","auto_fix_available":false}`

	resp, err := c.Complete(ctx, CompletionRequest{
		System:   system,
		Messages: []Message{{Role: "user", Content: "Review this diff:\n```diff\n" + diff + "\n```"}},
	})
	if err != nil {
		return &models.AIReview{Summary: "AI review unavailable"}, nil
	}

	var review models.AIReview
	content := strings.TrimSpace(resp.Content)
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")
	if err := json.Unmarshal([]byte(strings.TrimSpace(content)), &review); err != nil {
		review.Summary = resp.Content
		review.Severity = "info"
	}
	return &review, nil
}

// ExplainVulnerability explains a security finding
func (c *Client) ExplainVulnerability(ctx context.Context, vuln string) (string, error) {
	system := `You are a security expert. Explain the vulnerability in plain English and provide a fix. Be concise (max 200 words).`
	resp, err := c.Complete(ctx, CompletionRequest{
		System:   system,
		Messages: []Message{{Role: "user", Content: vuln}},
	})
	if err != nil {
		return "Unable to analyze vulnerability", nil
	}
	return resp.Content, nil
}

// SecurityScan performs AI-powered security analysis on source code
// If scannerOutput is non-empty it will triage those results; otherwise it does a pure AI scan.
func (c *Client) SecurityScan(ctx context.Context, scannerName, scannerOutput, sourceSnippet string) (*models.SecurityScanResult, error) {
	system := `You are a senior application security engineer performing a CI/CD security scan.
Analyze the provided source code and/or scanner output for security vulnerabilities.

Focus on:
- Hardcoded secrets, API keys, tokens, passwords
- SQL injection, XSS, command injection
- Insecure dependencies or known CVEs
- Path traversal, SSRF, insecure deserialization
- Weak cryptography, insecure random number generation
- Missing input validation, improper error handling
- Insecure file permissions

Return as JSON only:
{
  "severity": "info|warning|error",
  "summary": "one sentence overall assessment",
  "total_findings": 0,
  "critical": 0, "high": 0, "medium": 0, "low": 0,
  "findings": [
    {"id":"SEC-001","severity":"HIGH","title":"...","description":"...","file":"...","line":0,"fix":"..."}
  ],
  "ai_explanation": "2-3 sentence plain English summary of the security posture"
}`

	var prompt strings.Builder
	if scannerOutput != "" {
		prompt.WriteString(fmt.Sprintf("Scanner: %s\nScanner output:\n```\n%s\n```\n\n", scannerName, truncate(scannerOutput, 6000)))
	}
	if sourceSnippet != "" {
		prompt.WriteString(fmt.Sprintf("Source code to review:\n```\n%s\n```", truncate(sourceSnippet, 8000)))
	}
	if prompt.Len() == 0 {
		return &models.SecurityScanResult{Summary: "No source code or scanner output provided", Severity: "info"}, nil
	}

	resp, err := c.Complete(ctx, CompletionRequest{
		System:    system,
		Messages:  []Message{{Role: "user", Content: prompt.String()}},
		MaxTokens: 2048,
		Provider:  c.cfg.DefaultLLMProvider,
		Model:     c.cfg.DefaultLLMModel,
	})
	if err != nil {
		return &models.SecurityScanResult{Summary: "AI security scan unavailable", Severity: "info", Scanner: "ai-only"}, nil
	}

	var result models.SecurityScanResult
	content := strings.TrimSpace(resp.Content)
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")
	if err := json.Unmarshal([]byte(strings.TrimSpace(content)), &result); err != nil {
		result.Summary = resp.Content
		result.Severity = "info"
	}
	if scannerName != "" {
		result.Scanner = scannerName
	} else {
		result.Scanner = "ai-only"
	}
	return &result, nil
}

// ReviewCodeFiles performs AI code review on a set of file contents (not just a diff)
func (c *Client) ReviewCodeFiles(ctx context.Context, filesContent string) (*models.AIReview, error) {
	system := `You are a senior code reviewer embedded in a CI/CD pipeline.
Review the changed source files and provide:
1. Summary (1-2 sentences of what changed)
2. Severity: info (clean), warning (minor issues), error (significant problems)
3. Key findings (max 5 — focus on bugs, logic errors, performance, code smells, missing error handling)
4. One actionable suggestion for the most important improvement

Return as JSON: {"severity":"info|warning|error","summary":"...","findings":["..."],"suggestion":"...","auto_fix_available":false}`

	resp, err := c.Complete(ctx, CompletionRequest{
		System:    system,
		Messages:  []Message{{Role: "user", Content: "Review these changed files:\n\n" + truncate(filesContent, 12000)}},
		MaxTokens: 1500,
		Provider:  c.cfg.DefaultLLMProvider,
		Model:     c.cfg.DefaultLLMModel,
	})
	if err != nil {
		return &models.AIReview{Summary: "AI code review unavailable", Severity: "info"}, nil
	}

	var review models.AIReview
	content := strings.TrimSpace(resp.Content)
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")
	if err := json.Unmarshal([]byte(strings.TrimSpace(content)), &review); err != nil {
		review.Summary = resp.Content
		review.Severity = "info"
	}
	return &review, nil
}

// GenerateReleaseNotes creates release notes from commits
func (c *Client) GenerateReleaseNotes(ctx context.Context, commits []string, version string) (string, error) {
	system := `You are a technical writer. Generate clean, user-friendly release notes from the commit messages.
Format: markdown with sections for Features, Bug Fixes, and Other Changes. Keep it concise.`

	commitList := strings.Join(commits, "\n")
	resp, err := c.Complete(ctx, CompletionRequest{
		System:   system,
		Messages: []Message{{Role: "user", Content: fmt.Sprintf("Version: %s\nCommits:\n%s", version, commitList)}},
	})
	if err != nil {
		return fmt.Sprintf("# Release %s\n\nRelease notes unavailable.", version), nil
	}
	return resp.Content, nil
}

// DetectLanguage detects the primary language from repo files
func (c *Client) DetectLanguage(ctx context.Context, files []string) (string, string, error) {
	system := `Detect the primary programming language and framework from these file names. Return JSON: {"language":"Go","framework":"Gin"}`
	fileList := strings.Join(files, "\n")
	resp, err := c.Complete(ctx, CompletionRequest{
		System:   system,
		Messages: []Message{{Role: "user", Content: fileList}},
	})
	if err != nil {
		return "unknown", "unknown", nil
	}
	var result struct {
		Language  string `json:"language"`
		Framework string `json:"framework"`
	}
	content := strings.TrimSpace(resp.Content)
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")
	json.Unmarshal([]byte(strings.TrimSpace(content)), &result)
	return result.Language, result.Framework, nil
}

// Chat handles multi-turn conversation about builds/pipelines
func (c *Client) Chat(ctx context.Context, messages []Message, contextStr string) (string, error) {
	system := fmt.Sprintf(`You are Callahan AI, an expert CI/CD assistant embedded in the Callahan platform.
You help developers understand build failures, optimize pipelines, fix security issues, and improve code quality.
Be concise, technical, and actionable.

Current context:
%s`, contextStr)

	resp, err := c.Complete(ctx, CompletionRequest{
		System:   system,
		Messages: messages,
		Provider: c.cfg.DefaultLLMProvider,
		Model:    c.cfg.DefaultLLMModel,
	})
	if err != nil {
		return "I'm unable to respond right now. Please check your LLM configuration in the sidebar.", nil
	}
	return resp.Content, nil
}

// ─── V3: AI for Notifications ────────────────────────────────────────────────

// GenerateNotificationMsg satisfies the notifications.AIWriter interface.
func (c *Client) GenerateNotificationMsg(ctx context.Context, buildNum int, status, branch, projectName, versionTag, changelog, platform string, durationMs int64) (string, error) {
	statusEmoji := map[string]string{"success":"✅","failed":"❌","cancelled":"⏹"}[status]
	if statusEmoji == "" { statusEmoji = "ℹ️" }

	systemPrompt := fmt.Sprintf(`You are a CI/CD notification writer for %s. Write a concise, professional notification message.
Platform: %s
Keep it under 280 characters for %s. Include status, project, branch, and a brief human-readable summary.
Return only the message text, no JSON or formatting.`, projectName, platform, platform)

	userMsg := fmt.Sprintf("%s Build #%d %s on branch '%s'. Duration: %.1fs.%s",
		statusEmoji, buildNum, status, branch, float64(durationMs)/1000,
		func() string { if versionTag != "" { return " Version: " + versionTag }; return "" }())

	resp, err := c.Complete(ctx, CompletionRequest{
		System:   systemPrompt,
		Messages: []Message{{Role:"user", Content:userMsg}},
		MaxTokens: 200,
		Provider: c.cfg.DefaultLLMProvider,
		Model:    c.cfg.DefaultLLMModel,
	})
	if err != nil { return "", err }
	return strings.TrimSpace(resp.Content), nil
}

// ─── V3: AI Version Bump Advisor ─────────────────────────────────────────────

func (c *Client) AnalyzeVersionBump(ctx context.Context, commitMessages []string, changelog string) (bumpType, reason string, err error) {
	prompt := fmt.Sprintf(`Analyze these commit messages and determine the appropriate SemVer bump type.

Commits:
%s

Rules:
- "major" if any commit has BREAKING CHANGE or "!:" or removes a public API
- "minor" if any commit starts with "feat:" or adds new functionality  
- "patch" for everything else (fix:, chore:, docs:, refactor:, test:)

Respond with JSON only: {"bump":"patch|minor|major","reason":"one sentence explanation"}`,
		strings.Join(commitMessages, "\n"))

	resp, err := c.Complete(ctx, CompletionRequest{
		System:   "You are a semantic versioning expert. Respond only with valid JSON.",
		Messages: []Message{{Role:"user", Content:prompt}},
		MaxTokens: 150,
		Provider: c.cfg.DefaultLLMProvider,
		Model:    c.cfg.DefaultLLMModel,
	})
	if err != nil { return "", "", err }

	// Parse JSON response
	content := strings.TrimSpace(resp.Content)
	content = strings.TrimPrefix(content, "```json")
	content = strings.TrimPrefix(content, "```")
	content = strings.TrimSuffix(content, "```")

	var result struct {
		Bump   string `json:"bump"`
		Reason string `json:"reason"`
	}
	if err := parseJSON(content, &result); err != nil || result.Bump == "" {
		return "", "", fmt.Errorf("could not parse AI response")
	}
	return result.Bump, result.Reason, nil
}

// ─── V3: AI Deployment Guardrail ─────────────────────────────────────────────

func (c *Client) CheckDeploymentSafety(ctx context.Context, environment, diff, changelog string) (safe bool, concerns []string, err error) {
	prompt := fmt.Sprintf(`You are a deployment safety reviewer. Analyze this code diff before deployment to '%s'.

Changelog:
%s

Diff summary (first 2000 chars):
%s

Identify any concerns: breaking changes, missing migrations, security issues, removed APIs.
Respond with JSON only: {"safe":true,"concerns":["list of specific concerns or empty array"]}`,
		environment, changelog, truncate(diff, 2000))

	resp, err := c.Complete(ctx, CompletionRequest{
		System:   "You are a deployment safety expert. Respond only with valid JSON.",
		Messages: []Message{{Role:"user", Content:prompt}},
		MaxTokens: 400,
		Provider: c.cfg.DefaultLLMProvider,
		Model:    c.cfg.DefaultLLMModel,
	})
	if err != nil { return true, nil, err }

	content := strings.TrimSpace(resp.Content)
	content = strings.TrimPrefix(strings.TrimPrefix(content, "```json"), "```")
	content = strings.TrimSuffix(content, "```")

	var result struct {
		Safe     bool     `json:"safe"`
		Concerns []string `json:"concerns"`
	}
	if err := parseJSON(content, &result); err != nil {
		return true, nil, nil // fail open
	}
	return result.Safe, result.Concerns, nil
}

func parseJSON(s string, v interface{}) error {
	d := json.NewDecoder(strings.NewReader(s))
	return d.Decode(v)
}

func truncate(s string, n int) string {
	if len(s) <= n { return s }
	return s[:n] + "…"
}
