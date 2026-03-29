package notifications

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/callahan-ci/callahan/pkg/models"
)

// Dispatcher sends notifications to all configured channels for a build.
type Dispatcher struct {
	store  Store
	ai     AIWriter
	client *http.Client
}

// Store is the subset of storage methods the notifier needs.
type Store interface {
	ListNotificationChannels(projectID string) ([]*models.NotificationChannel, error)
	CreateNotificationLog(l *models.NotificationLog) error
	AddContextEntry(e *models.ContextEntry) error
}

// AIWriter generates plain-text notification messages.
// *llm.Client satisfies this via its GenerateNotificationMsg method.
type AIWriter interface {
	GenerateNotificationMsg(
		ctx context.Context,
		buildNum int,
		status, branch, projectName, versionTag, changelog, platform string,
		durationMs int64,
	) (string, error)
}

func NewDispatcher(store Store, ai AIWriter) *Dispatcher {
	return &Dispatcher{
		store:  store,
		ai:     ai,
		client: &http.Client{Timeout: 15 * time.Second},
	}
}

// Dispatch fires all applicable channels for a completed build. Non-blocking.
func (d *Dispatcher) Dispatch(ctx context.Context, build *models.Build, project *models.Project, version *models.Version) {
	channels, err := d.store.ListNotificationChannels(project.ID)
	if err != nil || len(channels) == 0 {
		return
	}
	for _, ch := range channels {
		if !ch.Enabled {
			continue
		}
		if !d.shouldSend(ch, build.Status) {
			continue
		}
		ch := ch // capture
		go d.sendToChannel(ctx, ch, build, project, version)
	}
}

func (d *Dispatcher) shouldSend(ch *models.NotificationChannel, status string) bool {
	switch status {
	case "success":   return ch.OnSuccess
	case "failed":    return ch.OnFailure
	case "cancelled": return ch.OnCancel
	}
	return false
}

func (d *Dispatcher) sendToChannel(ctx context.Context, ch *models.NotificationChannel, build *models.Build, project *models.Project, version *models.Version) {
	entry := &models.NotificationLog{
		ID: uuid.New().String(), ChannelID: ch.ID, BuildID: build.ID,
		Platform: ch.Platform, SentAt: time.Now(),
	}

	var payload string
	var sendErr error

	switch ch.Platform {
	case "slack":       payload, sendErr = d.sendSlack(ctx, ch, build, project, version)
	case "teams":       payload, sendErr = d.sendTeams(ctx, ch, build, project, version)
	case "jira":        payload, sendErr = d.sendJira(ctx, ch, build, project, version)
	case "azuredevops": payload, sendErr = d.sendAzureDevOps(ctx, ch, build, project, version)
	case "discord":     payload, sendErr = d.sendDiscord(ctx, ch, build, project, version)
	case "webhook":     payload, sendErr = d.sendWebhook(ctx, ch, build, project, version)
	default:
		entry.Status = "skipped"
		entry.Error = "unsupported platform: " + ch.Platform
		_ = d.store.CreateNotificationLog(entry)
		return
	}

	entry.Payload = payload
	if sendErr != nil {
		entry.Status = "failed"
		entry.Error = sendErr.Error()
	} else {
		entry.Status = "sent"
	}
	_ = d.store.CreateNotificationLog(entry)

	// Index into AI context engine
	statusEmoji := map[string]string{"success": "✔", "failed": "✖", "cancelled": "■"}[build.Status]
	sentStatus := "sent"
	if sendErr != nil {
		sentStatus = "failed: " + sendErr.Error()
	}
	_ = d.store.AddContextEntry(&models.ContextEntry{
		ID: uuid.New().String(), ProjectID: project.ID, Type: "notification", RefID: build.ID,
		Summary: fmt.Sprintf("%s Notification via %s for build #%d (%s) — %s",
			statusEmoji, ch.Platform, build.Number, build.Status, sentStatus),
		Tags:      strings.Join([]string{ch.Platform, build.Status, "notification"}, ","),
		CreatedAt: time.Now(),
	})
}

// aiText returns an AI-generated message or falls back to defaultText.
func (d *Dispatcher) aiText(ctx context.Context, ch *models.NotificationChannel, build *models.Build, project *models.Project, version *models.Version, platform, defaultText string) string {
	if !ch.AIMessage || d.ai == nil {
		return defaultText
	}
	vTag := ""
	if version != nil {
		vTag = version.Tag
	}
	msg, err := d.ai.GenerateNotificationMsg(ctx,
		build.Number, build.Status, build.Branch,
		project.Name, vTag, "", platform, build.Duration)
	if err != nil || msg == "" {
		return defaultText
	}
	return msg
}

// ─── Slack ────────────────────────────────────────────────────────────────────

func (d *Dispatcher) sendSlack(ctx context.Context, ch *models.NotificationChannel, build *models.Build, project *models.Project, version *models.Version) (string, error) {
	webhookURL := ch.Config["webhook_url"]
	if webhookURL == "" {
		return "", fmt.Errorf("slack: no webhook_url configured")
	}
	color := map[string]string{"success": "#00e5a0", "failed": "#ff4455", "cancelled": "#f5c542"}[build.Status]
	vStr := ""; if version != nil { vStr = " · " + version.Tag }
	fallback := fmt.Sprintf("*%s* Build #%d %s%s", strings.ToUpper(build.Status), build.Number, project.Name, vStr)
	text := d.aiText(ctx, ch, build, project, version, "slack", fallback)
	duration := fmt.Sprintf("%.1fs", float64(build.Duration)/1000)

	body, _ := json.Marshal(map[string]interface{}{
		"attachments": []map[string]interface{}{{
			"color": color,
			"blocks": []map[string]interface{}{
				{"type": "section", "text": map[string]string{"type": "mrkdwn", "text": text}},
				{"type": "context", "elements": []map[string]interface{}{
					{"type": "mrkdwn", "text": fmt.Sprintf("Branch: *%s*  ·  Duration: *%s*  ·  Commit: `%s`",
						build.Branch, duration, safeHead(build.Commit, 8))},
				}},
			},
		}},
	})
	return d.postJSON(ctx, webhookURL, "", body)
}

// ─── Microsoft Teams ──────────────────────────────────────────────────────────

func (d *Dispatcher) sendTeams(ctx context.Context, ch *models.NotificationChannel, build *models.Build, project *models.Project, version *models.Version) (string, error) {
	webhookURL := ch.Config["webhook_url"]
	if webhookURL == "" {
		return "", fmt.Errorf("teams: no webhook_url configured")
	}
	versionText := "N/A"; if version != nil { versionText = version.Tag }
	fallback := fmt.Sprintf("Build #%d %s — %s", build.Number, build.Status, project.Name)
	summary := d.aiText(ctx, ch, build, project, version, "teams", fallback)
	acColor := map[string]string{"success": "Good", "failed": "Attention", "cancelled": "Warning"}[build.Status]

	body, _ := json.Marshal(map[string]interface{}{
		"type": "message",
		"attachments": []map[string]interface{}{{
			"contentType": "application/vnd.microsoft.card.adaptive",
			"content": map[string]interface{}{
				"$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
				"type": "AdaptiveCard", "version": "1.3",
				"body": []map[string]interface{}{
					{"type": "TextBlock", "size": "Medium", "weight": "Bolder",
						"text": fmt.Sprintf("Callahan CI — Build #%d", build.Number)},
					{"type": "FactSet", "facts": []map[string]string{
						{"title": "Project", "value": project.Name},
						{"title": "Status", "value": strings.ToUpper(build.Status)},
						{"title": "Branch", "value": build.Branch},
						{"title": "Version", "value": versionText},
						{"title": "Duration", "value": fmt.Sprintf("%.1fs", float64(build.Duration)/1000)},
					}},
					{"type": "TextBlock", "text": summary, "wrap": true, "color": acColor},
				},
			},
		}},
	})
	return d.postJSON(ctx, webhookURL, "", body)
}

// ─── Jira ─────────────────────────────────────────────────────────────────────

func (d *Dispatcher) sendJira(ctx context.Context, ch *models.NotificationChannel, build *models.Build, project *models.Project, version *models.Version) (string, error) {
	baseURL  := ch.Config["base_url"]
	token    := ch.Config["api_token"]
	email    := ch.Config["email"]
	issueKey := ch.Config["issue_key"]
	if baseURL == "" || token == "" || issueKey == "" {
		return "", fmt.Errorf("jira: requires base_url, api_token, and issue_key")
	}
	vLine := ""; if version != nil { vLine = fmt.Sprintf("\nVersion tagged: *%s*", version.Tag) }
	fallback := fmt.Sprintf("*Callahan CI Build #%d — %s*\n\nProject: %s\nBranch: %s\nCommit: %s\nDuration: %.1fs%s",
		build.Number, strings.ToUpper(build.Status), project.Name, build.Branch, safeHead(build.Commit, 12), float64(build.Duration)/1000, vLine)
	comment := d.aiText(ctx, ch, build, project, version, "jira", fallback)

	body, _ := json.Marshal(map[string]interface{}{
		"body": map[string]interface{}{
			"type": "doc", "version": 1,
			"content": []map[string]interface{}{{
				"type":    "paragraph",
				"content": []map[string]interface{}{{"type": "text", "text": comment}},
			}},
		},
	})
	url := fmt.Sprintf("%s/rest/api/3/issue/%s/comment", baseURL, issueKey)
	return d.postJSON(ctx, url, basicAuth(email, token), body)
}

// ─── Azure DevOps ─────────────────────────────────────────────────────────────

func (d *Dispatcher) sendAzureDevOps(ctx context.Context, ch *models.NotificationChannel, build *models.Build, project *models.Project, version *models.Version) (string, error) {
	org := ch.Config["organization"]; proj := ch.Config["project"]
	token := ch.Config["pat"]; workItem := ch.Config["work_item_id"]
	if org == "" || proj == "" || token == "" || workItem == "" {
		return "", fmt.Errorf("azuredevops: requires organization, project, pat, work_item_id")
	}
	fallback := fmt.Sprintf("Callahan CI Build #%d %s — %s branch %s (%.1fs)",
		build.Number, build.Status, project.Name, build.Branch, float64(build.Duration)/1000)
	if version != nil { fallback += fmt.Sprintf(" — tagged %s", version.Tag) }
	comment := d.aiText(ctx, ch, build, project, version, "azuredevops", fallback)

	body, _ := json.Marshal(map[string]interface{}{"text": comment})
	url := fmt.Sprintf("https://dev.azure.com/%s/%s/_apis/wit/workItems/%s/comments?api-version=7.1-preview.3", org, proj, workItem)
	return d.postJSON(ctx, url, basicAuth("", token), body)
}

// ─── Discord ──────────────────────────────────────────────────────────────────

func (d *Dispatcher) sendDiscord(ctx context.Context, ch *models.NotificationChannel, build *models.Build, project *models.Project, version *models.Version) (string, error) {
	webhookURL := ch.Config["webhook_url"]
	if webhookURL == "" {
		return "", fmt.Errorf("discord: no webhook_url configured")
	}
	color := map[string]int{"success": 0x00e5a0, "failed": 0xff4455, "cancelled": 0xf5c542}[build.Status]
	desc := fmt.Sprintf("Branch: `%s` · Commit: `%s` · %.1fs", build.Branch, safeHead(build.Commit, 8), float64(build.Duration)/1000)
	if version != nil { desc += fmt.Sprintf(" · Version: `%s`", version.Tag) }

	body, _ := json.Marshal(map[string]interface{}{
		"embeds": []map[string]interface{}{{
			"title":       fmt.Sprintf("Build #%d — %s", build.Number, strings.ToUpper(build.Status)),
			"description": desc,
			"color":       color,
			"author":      map[string]string{"name": project.Name},
		}},
	})
	return d.postJSON(ctx, webhookURL, "", body)
}

// ─── Generic Webhook ──────────────────────────────────────────────────────────

func (d *Dispatcher) sendWebhook(ctx context.Context, ch *models.NotificationChannel, build *models.Build, project *models.Project, version *models.Version) (string, error) {
	url := ch.Config["url"]
	if url == "" {
		return "", fmt.Errorf("webhook: no url configured")
	}
	vTag := ""; if version != nil { vTag = version.Tag }
	body, _ := json.Marshal(map[string]interface{}{
		"event": "build." + build.Status, "build_id": build.ID, "build_num": build.Number,
		"project": project.Name, "repo_url": project.RepoURL,
		"status": build.Status, "branch": build.Branch, "commit": build.Commit,
		"duration_ms": build.Duration, "version": vTag,
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
	return d.postJSON(ctx, url, ch.Config["secret"], body)
}

// ─── HTTP ─────────────────────────────────────────────────────────────────────

func (d *Dispatcher) postJSON(ctx context.Context, url, auth string, body []byte) (string, error) {
	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil { return "", err }
	req.Header.Set("Content-Type", "application/json")
	if strings.HasPrefix(auth, "Basic ") {
		req.Header.Set("Authorization", auth)
	} else if auth != "" {
		req.Header.Set("Authorization", "Bearer "+auth)
	}
	resp, err := d.client.Do(req)
	if err != nil { return string(body), fmt.Errorf("http: %w", err) }
	defer resp.Body.Close()
	var buf bytes.Buffer
	_, _ = buf.ReadFrom(resp.Body)
	if resp.StatusCode >= 300 {
		return string(body), fmt.Errorf("http %d: %s", resp.StatusCode, buf.String())
	}
	return string(body), nil
}

// ─── Utility ──────────────────────────────────────────────────────────────────

func basicAuth(username, password string) string {
	return "Basic " + base64Encode(username+":"+password)
}

func safeHead(s string, n int) string {
	if len(s) <= n { return s }
	return s[:n]
}

func base64Encode(s string) string {
	const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
	b := []byte(s)
	var out []byte
	for i := 0; i < len(b); i += 3 {
		var v uint32
		n := 0
		for j := 0; j < 3; j++ {
			v <<= 8
			if i+j < len(b) { v |= uint32(b[i+j]); n++ }
		}
		out = append(out, chars[(v>>18)&63], chars[(v>>12)&63])
		if n > 1 { out = append(out, chars[(v>>6)&63]) } else { out = append(out, '=') }
		if n > 2 { out = append(out, chars[v&63]) } else { out = append(out, '=') }
	}
	return string(out)
}
