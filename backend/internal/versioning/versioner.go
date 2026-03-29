package versioning

import (
	"context"
	"fmt"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/callahan-ci/callahan/pkg/models"
)

type Store interface {
	LatestVersion(projectID string) (*models.Version, error)
	CreateVersion(v *models.Version) error
	AddContextEntry(e *models.ContextEntry) error
}

type AIAnalyzer interface {
	AnalyzeVersionBump(ctx context.Context, commitMessages []string, changelog string) (bumpType, reason string, err error)
}

type Versioner struct {
	store Store
	ai    AIAnalyzer
}

func New(store Store, ai AIAnalyzer) *Versioner {
	return &Versioner{store: store, ai: ai}
}

// BumpVersion computes the next version for a project based on the build
func (v *Versioner) BumpVersion(ctx context.Context, project *models.Project, build *models.Build, workDir string) (*models.Version, error) {
	// Get current version
	latest, _ := v.store.LatestVersion(project.ID)
	current := "0.0.0"
	if latest != nil { current = latest.SemVer }

	// Gather commit messages since last version
	commits := getRecentCommits(workDir, 20)
	changelog := formatChangelog(commits)

	// Determine bump type
	bumpType, reason := detectBumpType(commits)

	// Use AI analysis if available
	if v.ai != nil && len(commits) > 0 {
		if aiBump, aiReason, err := v.ai.AnalyzeVersionBump(ctx, commits, changelog); err == nil && aiBump != "" {
			bumpType = aiBump
			reason = aiReason
		}
	}

	// Compute next version
	nextVer, err := bumpSemVer(current, bumpType)
	if err != nil { return nil, err }

	ver := &models.Version{
		ID:         uuid.New().String(),
		ProjectID:  project.ID,
		BuildID:    build.ID,
		SemVer:     nextVer,
		Tag:        "v" + nextVer,
		BumpType:   bumpType,
		BumpReason: reason,
		Changelog:  changelog,
		CreatedAt:  time.Now(),
	}

	// Attempt to create git tag
	if workDir != "" {
		if err := createGitTag(workDir, ver.Tag, build.Commit); err == nil {
			ver.GitTagged = true
		}
	}

	if err := v.store.CreateVersion(ver); err != nil { return nil, err }

	// Index in context engine
	v.store.AddContextEntry(&models.ContextEntry{
		ID:        uuid.New().String(),
		ProjectID: project.ID,
		Type:      "version",
		RefID:     ver.ID,
		Summary:   fmt.Sprintf("🏷 Version %s created (%s bump) — %s", ver.Tag, bumpType, reason),
		Detail:    changelog,
		Tags:      strings.Join([]string{"version", ver.Tag, bumpType}, ","),
		CreatedAt: time.Now(),
	})

	return ver, nil
}

// ─── commit analysis ──────────────────────────────────────────────────────────

func getRecentCommits(workDir string, n int) []string {
	if workDir == "" { return nil }
	out, err := exec.Command("git", "-C", workDir, "log", fmt.Sprintf("-%d", n), "--pretty=%s").Output()
	if err != nil { return nil }
	var msgs []string
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		if t := strings.TrimSpace(line); t != "" { msgs = append(msgs, t) }
	}
	return msgs
}

func formatChangelog(commits []string) string {
	if len(commits) == 0 { return "" }
	var sb strings.Builder
	sb.WriteString("## Changes\n")
	for _, c := range commits {
		sb.WriteString("- " + c + "\n")
	}
	return sb.String()
}

// detectBumpType uses conventional commits to determine bump level
func detectBumpType(commits []string) (string, string) {
	majorRe := regexp.MustCompile(`(?i)(BREAKING CHANGE|!:)`)
	minorRe  := regexp.MustCompile(`(?i)^feat(\(.+\))?:`)

	for _, c := range commits {
		if majorRe.MatchString(c) {
			return "major", "Breaking change detected in commit: " + truncate(c, 80)
		}
	}
	for _, c := range commits {
		if minorRe.MatchString(c) {
			return "minor", "New feature detected: " + truncate(c, 80)
		}
	}
	return "patch", "Patch-level changes (bug fixes, chores, docs)"
}

func bumpSemVer(current, bumpType string) (string, error) {
	parts := strings.Split(current, ".")
	if len(parts) != 3 { parts = []string{"0","0","0"} }
	major, _ := strconv.Atoi(parts[0])
	minor, _ := strconv.Atoi(parts[1])
	patch, _ := strconv.Atoi(parts[2])

	switch bumpType {
	case "major": major++; minor=0; patch=0
	case "minor": minor++; patch=0
	default:      patch++
	}
	return fmt.Sprintf("%d.%d.%d", major, minor, patch), nil
}

func createGitTag(workDir, tag, commit string) error {
	args := []string{"-C", workDir, "tag", "-a", tag, "-m", "Release " + tag}
	if commit != "" { args = append(args, commit) }
	return exec.Command("git", args...).Run()
}

func truncate(s string, n int) string {
	if len(s) <= n { return s }
	return s[:n] + "…"
}
