package api

// webhook.go — handles incoming push and pull_request webhooks from GitHub
// and GitLab, finds the matching project, and triggers a build with PR
// metadata populated so the runPipeline can later post results back to the PR.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/callahan-ci/callahan/internal/scm"
	"github.com/callahan-ci/callahan/pkg/models"
)

// Webhook is the unified entry point for /api/v1/webhook/:provider.
// Provider is "github" or "gitlab" (taken from the URL path).
func (h *Handler) Webhook(c *gin.Context) {
	provider := strings.ToLower(c.Param("provider"))
	if provider != "github" && provider != "gitlab" {
		c.JSON(400, gin.H{"error": "unsupported provider " + provider})
		return
	}

	body, err := io.ReadAll(io.LimitReader(c.Request.Body, 5<<20)) // 5 MB cap
	if err != nil {
		c.JSON(400, gin.H{"error": "read body: " + err.Error()})
		return
	}

	// Verify signature/token using shared secret. If secret is empty,
	// verification is skipped (matches the existing API-token "dev convenience" pattern).
	if secret := h.cfg.GetWebhookSecret(); secret != "" {
		if err := verifyWebhookSignature(provider, c.Request.Header, body, secret); err != nil {
			c.JSON(401, gin.H{"error": "webhook signature invalid: " + err.Error()})
			return
		}
	}

	var event *models.WebhookEvent
	switch provider {
	case "github":
		event, err = parseGitHubWebhook(c.GetHeader("X-GitHub-Event"), body)
	case "gitlab":
		event, err = parseGitLabWebhook(c.GetHeader("X-Gitlab-Event"), body)
	}
	if err != nil {
		c.JSON(400, gin.H{"error": err.Error()})
		return
	}
	if event == nil {
		// Event was valid but not one we trigger on (e.g. a comment, a tag)
		c.JSON(200, gin.H{"status": "ignored", "reason": "event type not actionable"})
		return
	}
	event.Provider = provider

	// Match webhook to a configured project by repo URL.
	project := h.findProjectForWebhook(event)
	if project == nil {
		c.JSON(404, gin.H{"status": "no_project_match", "repo": event.Repo})
		return
	}

	// Branch filter: for push, build only the configured branch.
	// For PRs we always build, regardless of source branch.
	if event.Event == "push" && project.Branch != "" && event.Branch != project.Branch {
		c.JSON(200, gin.H{"status": "ignored", "reason": "branch " + event.Branch + " not tracked"})
		return
	}

	num, _ := h.store.GetNextBuildNumber(project.ID)
	now := time.Now()
	build := &models.Build{
		ID:        uuid.New().String(),
		ProjectID: project.ID,
		Number:    num,
		Status:    "running",
		Branch:    event.Branch,
		Commit:    event.Commit,
		CommitMsg: event.CommitMsg,
		Author:    event.Author,
		Trigger:   event.Event, // "push" or "pull_request"
		StartedAt: &now,
		CreatedAt: now,
		PRNumber:  event.PRNumber,
		RepoSlug:  scm.RepoSlugFromURL(project.RepoURL),
	}

	if err := h.store.CreateBuild(build); err != nil {
		c.JSON(500, gin.H{"error": err.Error()})
		return
	}

	ctx, cancel := context.WithCancel(context.Background())
	h.cancels.Store(build.ID, cancel)
	go h.runPipeline(ctx, build, project)

	c.JSON(201, gin.H{
		"status":    "build_triggered",
		"build_id":  build.ID,
		"project":   project.Name,
		"pr_number": event.PRNumber,
	})
}

// findProjectForWebhook matches an incoming webhook to a configured project
// by comparing the repo URL. Strips trailing .git and protocol differences.
func (h *Handler) findProjectForWebhook(event *models.WebhookEvent) *models.Project {
	wantSlug := strings.ToLower(scm.RepoSlugFromURL(event.Repo))
	if wantSlug == "" {
		return nil
	}
	projects, _ := h.store.ListProjects()
	for _, p := range projects {
		if strings.ToLower(scm.RepoSlugFromURL(p.RepoURL)) == wantSlug {
			return p
		}
	}
	return nil
}

// ─── Signature verification ──────────────────────────────────────────────────

// verifyWebhookSignature checks the appropriate signature/token header against
// the configured shared secret. Constant-time compare to avoid timing attacks.
//
//   GitHub: X-Hub-Signature-256: sha256=<hex(HMAC-SHA256(body, secret))>
//   GitLab: X-Gitlab-Token: <secret>   (plain shared token, no HMAC)
//
// `header` is the full request header map (case-insensitive lookup via http.Header).
func verifyWebhookSignature(provider string, header map[string][]string, body []byte, secret string) error {
	switch provider {
	case "github":
		got := firstHeader(header, "X-Hub-Signature-256")
		if !strings.HasPrefix(got, "sha256=") {
			return fmt.Errorf("missing X-Hub-Signature-256 header")
		}
		gotMAC, err := hex.DecodeString(strings.TrimPrefix(got, "sha256="))
		if err != nil {
			return fmt.Errorf("malformed signature")
		}
		mac := hmac.New(sha256.New, []byte(secret))
		mac.Write(body)
		if !hmac.Equal(gotMAC, mac.Sum(nil)) {
			return fmt.Errorf("HMAC mismatch")
		}
		return nil

	case "gitlab":
		got := firstHeader(header, "X-Gitlab-Token")
		if got == "" {
			return fmt.Errorf("missing X-Gitlab-Token header")
		}
		// Constant-time compare even for plain token to avoid timing leaks.
		if !hmac.Equal([]byte(got), []byte(secret)) {
			return fmt.Errorf("token mismatch")
		}
		return nil
	}
	return fmt.Errorf("unsupported provider %q", provider)
}

// firstHeader does a case-insensitive lookup matching net/http canonical form.
func firstHeader(h map[string][]string, key string) string {
	for k, v := range h {
		if strings.EqualFold(k, key) && len(v) > 0 {
			return v[0]
		}
	}
	return ""
}

// ─── GitHub payload parsing ──────────────────────────────────────────────────

func parseGitHubWebhook(eventType string, body []byte) (*models.WebhookEvent, error) {
	switch eventType {
	case "push":
		var p struct {
			Ref        string `json:"ref"`
			After      string `json:"after"`
			HeadCommit struct {
				Message string `json:"message"`
				Author  struct {
					Name string `json:"name"`
				} `json:"author"`
			} `json:"head_commit"`
			Repository struct {
				CloneURL string `json:"clone_url"`
				HTMLURL  string `json:"html_url"`
			} `json:"repository"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			return nil, fmt.Errorf("github push parse: %w", err)
		}
		repo := p.Repository.CloneURL
		if repo == "" {
			repo = p.Repository.HTMLURL
		}
		return &models.WebhookEvent{
			Event: "push", Repo: repo,
			Branch: strings.TrimPrefix(p.Ref, "refs/heads/"),
			Commit: p.After, CommitMsg: p.HeadCommit.Message,
			Author: p.HeadCommit.Author.Name, Timestamp: time.Now(),
		}, nil

	case "pull_request":
		var p struct {
			Action      string `json:"action"`
			Number      int    `json:"number"`
			PullRequest struct {
				Head struct {
					Ref string `json:"ref"`
					SHA string `json:"sha"`
				} `json:"head"`
				Title string `json:"title"`
				User  struct {
					Login string `json:"login"`
				} `json:"user"`
			} `json:"pull_request"`
			Repository struct {
				CloneURL string `json:"clone_url"`
				HTMLURL  string `json:"html_url"`
			} `json:"repository"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			return nil, fmt.Errorf("github pull_request parse: %w", err)
		}
		// Only build on opened/synchronize/reopened — skip closed/labeled/etc.
		if p.Action != "opened" && p.Action != "synchronize" && p.Action != "reopened" {
			return nil, nil
		}
		repo := p.Repository.CloneURL
		if repo == "" {
			repo = p.Repository.HTMLURL
		}
		return &models.WebhookEvent{
			Event: "pull_request", Repo: repo,
			Branch: p.PullRequest.Head.Ref, Commit: p.PullRequest.Head.SHA,
			CommitMsg: p.PullRequest.Title, Author: p.PullRequest.User.Login,
			PRNumber: p.Number, Timestamp: time.Now(),
		}, nil
	}
	// ping, issues, etc. — accept-and-ignore
	return nil, nil
}

// ─── GitLab payload parsing ──────────────────────────────────────────────────

func parseGitLabWebhook(eventType string, body []byte) (*models.WebhookEvent, error) {
	switch eventType {
	case "Push Hook":
		var p struct {
			Ref         string `json:"ref"`
			After       string `json:"after"`
			UserName    string `json:"user_name"`
			Commits     []struct {
				Message string `json:"message"`
			} `json:"commits"`
			Project struct {
				GitHTTPURL string `json:"git_http_url"`
				WebURL     string `json:"web_url"`
			} `json:"project"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			return nil, fmt.Errorf("gitlab push parse: %w", err)
		}
		msg := ""
		if len(p.Commits) > 0 {
			msg = p.Commits[len(p.Commits)-1].Message
		}
		repo := p.Project.GitHTTPURL
		if repo == "" {
			repo = p.Project.WebURL
		}
		return &models.WebhookEvent{
			Event: "push", Repo: repo,
			Branch: strings.TrimPrefix(p.Ref, "refs/heads/"),
			Commit: p.After, CommitMsg: msg,
			Author: p.UserName, Timestamp: time.Now(),
		}, nil

	case "Merge Request Hook":
		var p struct {
			User struct {
				Username string `json:"username"`
			} `json:"user"`
			ObjectAttributes struct {
				IID          int    `json:"iid"`
				Action       string `json:"action"`
				SourceBranch string `json:"source_branch"`
				LastCommit   struct {
					ID      string `json:"id"`
					Message string `json:"message"`
				} `json:"last_commit"`
				Title string `json:"title"`
			} `json:"object_attributes"`
			Project struct {
				GitHTTPURL string `json:"git_http_url"`
				WebURL     string `json:"web_url"`
			} `json:"project"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			return nil, fmt.Errorf("gitlab MR parse: %w", err)
		}
		act := p.ObjectAttributes.Action
		if act != "open" && act != "update" && act != "reopen" {
			return nil, nil
		}
		repo := p.Project.GitHTTPURL
		if repo == "" {
			repo = p.Project.WebURL
		}
		return &models.WebhookEvent{
			Event: "pull_request", Repo: repo,
			Branch: p.ObjectAttributes.SourceBranch,
			Commit: p.ObjectAttributes.LastCommit.ID,
			CommitMsg: p.ObjectAttributes.Title,
			Author:    p.User.Username,
			PRNumber:  p.ObjectAttributes.IID,
			Timestamp: time.Now(),
		}, nil
	}
	return nil, nil
}
