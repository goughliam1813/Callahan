// Package scm posts comments back to source control providers (GitHub, GitLab).
//
// Uses only stdlib HTTP — no provider SDKs. Authentication is via the
// per-project GIT_TOKEN secret (same token used for git clone).
package scm

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// PostComment posts `body` (markdown) to the specified PR/MR.
//
// provider: "github" or "gitlab"
// repoSlug: "owner/repo" (GitHub) or full project path "group/subgroup/repo" (GitLab)
// prNumber: PR/MR number
// token:    PAT with PR-write scope (repo for GitHub, api for GitLab)
//
// Returns nil on 200/201 from provider, error otherwise.
func PostComment(ctx context.Context, provider, repoSlug string, prNumber int, token, body string) error {
	if token == "" {
		return fmt.Errorf("no GIT_TOKEN configured for project — cannot post PR comment")
	}
	if prNumber <= 0 {
		return fmt.Errorf("invalid PR number: %d", prNumber)
	}
	if repoSlug == "" {
		return fmt.Errorf("missing repo slug")
	}

	switch strings.ToLower(provider) {
	case "github":
		return postGitHub(ctx, repoSlug, prNumber, token, body)
	case "gitlab":
		return postGitLab(ctx, repoSlug, prNumber, token, body)
	default:
		return fmt.Errorf("unsupported provider %q (expected github or gitlab)", provider)
	}
}

func postGitHub(ctx context.Context, repoSlug string, prNumber int, token, body string) error {
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/issues/%d/comments", repoSlug, prNumber)
	payload, _ := json.Marshal(map[string]string{"body": body})

	req, err := http.NewRequestWithContext(ctx, "POST", apiURL, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("build github request: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("Authorization", "token "+token)
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("Content-Type", "application/json")

	return doRequest(req, "github")
}

func postGitLab(ctx context.Context, repoSlug string, prNumber int, token, body string) error {
	// GitLab needs the project path URL-encoded (slashes become %2F).
	apiURL := fmt.Sprintf("https://gitlab.com/api/v4/projects/%s/merge_requests/%d/notes",
		url.PathEscape(repoSlug), prNumber)
	payload, _ := json.Marshal(map[string]string{"body": body})

	req, err := http.NewRequestWithContext(ctx, "POST", apiURL, bytes.NewReader(payload))
	if err != nil {
		return fmt.Errorf("build gitlab request: %w", err)
	}
	req.Header.Set("PRIVATE-TOKEN", token)
	req.Header.Set("Content-Type", "application/json")

	return doRequest(req, "gitlab")
}

// maxAttempts is the total attempt count (1 initial + retries on transient failure).
const maxAttempts = 3

// doRequest sends the request with retry-with-exponential-backoff on transient
// errors (network failures, 5xx, 429). 4xx responses are returned immediately
// since retrying won't help (auth, validation, missing PR, etc.).
//
// To allow retries, the request body must be replayable — callers pass an
// *bytes.Reader so we can Seek back to the start.
func doRequest(req *http.Request, provider string) error {
	client := &http.Client{Timeout: 15 * time.Second}

	// Retain the original body so we can replay it on retry.
	var bodyBytes []byte
	if req.Body != nil {
		b, err := io.ReadAll(req.Body)
		if err != nil {
			return fmt.Errorf("read request body: %w", err)
		}
		bodyBytes = b
	}

	var lastErr error
	backoff := time.Second
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		// Reset body for each attempt (http.Client consumes it).
		if bodyBytes != nil {
			req.Body = io.NopCloser(bytes.NewReader(bodyBytes))
			req.ContentLength = int64(len(bodyBytes))
		}

		resp, err := client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("%s API call failed (attempt %d/%d): %w", provider, attempt, maxAttempts, err)
			if attempt < maxAttempts {
				time.Sleep(backoff)
				backoff *= 2
				continue
			}
			return lastErr
		}

		if resp.StatusCode == 200 || resp.StatusCode == 201 {
			resp.Body.Close()
			return nil
		}

		respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		resp.Body.Close()

		// 4xx (except 429 rate limit) — don't retry, the request is wrong.
		if resp.StatusCode >= 400 && resp.StatusCode < 500 && resp.StatusCode != 429 {
			return fmt.Errorf("%s API returned %d: %s", provider, resp.StatusCode, string(respBody))
		}

		lastErr = fmt.Errorf("%s API returned %d (attempt %d/%d): %s",
			provider, resp.StatusCode, attempt, maxAttempts, string(respBody))
		if attempt < maxAttempts {
			time.Sleep(backoff)
			backoff *= 2
		}
	}
	return lastErr
}

// RepoSlugFromURL extracts "owner/repo" from common git URL forms.
//   https://github.com/owner/repo(.git)
//   https://gitlab.com/group/subgroup/repo(.git)
//   git@github.com:owner/repo.git
//   ssh://git@gitlab.com/owner/repo.git
// Returns empty string if it can't parse a slug.
func RepoSlugFromURL(repoURL string) string {
	s := strings.TrimSpace(repoURL)
	if s == "" {
		return ""
	}
	// Convert SSH form git@host:owner/repo to host/owner/repo style
	if strings.HasPrefix(s, "git@") {
		s = strings.Replace(strings.TrimPrefix(s, "git@"), ":", "/", 1)
		s = "ssh://" + s
	}
	u, err := url.Parse(s)
	if err != nil {
		return ""
	}
	path := strings.TrimPrefix(u.Path, "/")
	path = strings.TrimSuffix(path, ".git")
	if path == "" {
		// scheme-less URL — fall back to splitting by host
		parts := strings.SplitN(s, "/", 2)
		if len(parts) == 2 {
			return strings.TrimSuffix(parts[1], ".git")
		}
		return ""
	}
	return path
}
