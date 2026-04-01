package pipeline

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"gopkg.in/yaml.v3"

	"github.com/callahan-ci/callahan/pkg/models"
)

type Parser struct{}
func NewParser() *Parser { return &Parser{} }

func (p *Parser) Parse(content []byte) (*models.Pipeline, error) {
	var pl models.Pipeline
	if err := yaml.Unmarshal(content, &pl); err != nil {
		return nil, fmt.Errorf("invalid Callahanfile.yaml: %w", err)
	}
	return &pl, nil
}

func (p *Parser) ParseFile(path string) (*models.Pipeline, error) {
	data, err := os.ReadFile(path)
	if err != nil { return nil, err }
	return p.Parse(data)
}

// LogWriter receives structured log lines
type LogWriter func(jobID, stepID, stream, line string)

type Executor struct {
	logWriter LogWriter
	mu        sync.Mutex
	stepLogs  map[string]*strings.Builder // collects logs per stepID
}

func NewExecutor(lw LogWriter) *Executor {
	return &Executor{logWriter: lw, stepLogs: make(map[string]*strings.Builder)}
}

type JobResult struct {
	JobID    string
	Status   string
	ExitCode int
	Steps    []*models.Step
	Duration int64
}

func (e *Executor) ExecuteJob(ctx context.Context, buildID, jobName string, job models.PipelineJob, workDir string, env map[string]string) *JobResult {
	if ctx == nil { ctx = context.Background() }
	jobID := uuid.New().String()
	start := time.Now()
	result := &JobResult{JobID: jobID, Status: "running"}

	e.log(jobID, "", "stdout", fmt.Sprintf("┌─ Job: %s", jobName))

	for i, step := range job.Steps {
		select {
		case <-ctx.Done():
			e.log(jobID, "", "stdout", "✖ Pipeline cancelled by user")
			result.Status = "cancelled"
			result.Duration = time.Since(start).Milliseconds()
			return result
		default:
		}

		stepID := uuid.New().String()
		name := step.Name
		if name == "" { name = fmt.Sprintf("Step %d", i+1) }

		s := &models.Step{ID: stepID, JobID: jobID, Name: name, Status: "running", Command: step.Run}

		// Start collecting logs for this step
		e.mu.Lock()
		e.stepLogs[stepID] = &strings.Builder{}
		e.mu.Unlock()

		e.log(jobID, stepID, "stdout", fmt.Sprintf("│ ▶  %s", name))

		stepStart := time.Now()
		exitCode := e.executeStep(ctx, jobID, stepID, step, workDir, env)
		s.Duration = time.Since(stepStart).Milliseconds()

		// Collect the accumulated log
		e.mu.Lock()
		if sb, ok := e.stepLogs[stepID]; ok {
			s.Log = sb.String()
			delete(e.stepLogs, stepID)
		}
		e.mu.Unlock()

		if exitCode != 0 {
			s.Status = "failed"
			s.ExitCode = exitCode
			e.log(jobID, stepID, "stderr", fmt.Sprintf("│ ✖  %s failed (exit %d, %.1fs)", name, exitCode, float64(s.Duration)/1000))
			result.Steps = append(result.Steps, s)
			if !step.ContinueOnError {
				result.Status = "failed"
				result.ExitCode = exitCode
				result.Duration = time.Since(start).Milliseconds()
				e.log(jobID, "", "stdout", fmt.Sprintf("└─ Job FAILED — %.1fs", float64(result.Duration)/1000))
				return result
			}
		} else {
			s.Status = "success"
			e.log(jobID, stepID, "stdout", fmt.Sprintf("│ ✔  %s (%.1fs)", name, float64(s.Duration)/1000))
		}
		result.Steps = append(result.Steps, s)
	}

	result.Status = "success"
	result.Duration = time.Since(start).Milliseconds()
	e.log(jobID, "", "stdout", fmt.Sprintf("└─ Job completed — %.1fs", float64(result.Duration)/1000))
	return result
}

func (e *Executor) executeStep(ctx context.Context, jobID, stepID string, step models.PipelineStep, workDir string, env map[string]string) int {
	if step.Uses != "" {
		return e.executeAction(ctx, jobID, stepID, step, workDir)
	}
	if step.AIStep != nil {
		e.log(jobID, stepID, "stdout", fmt.Sprintf("  [AI] Running %s agent…", step.AIStep.Action))
		return 0
	}
	if step.Run == "" { return 0 }
	return e.runCommand(ctx, jobID, stepID, step.Run, workDir, env)
}

func (e *Executor) executeAction(ctx context.Context, jobID, stepID string, step models.PipelineStep, workDir string) int {
	switch {
	case strings.HasPrefix(step.Uses, "actions/checkout"):
		e.log(jobID, stepID, "stdout", "  ✔ Repository already checked out")
		return 0
	case strings.HasPrefix(step.Uses, "actions/setup-node"):
		ver := step.With["node-version"]
		if ver == "" { ver = "20" }
		e.log(jobID, stepID, "stdout", fmt.Sprintf("  Setting up Node.js %s (using system)", ver))
		return e.runCommand(ctx, jobID, stepID, "node --version && npm --version", workDir, nil)
	case strings.HasPrefix(step.Uses, "actions/setup-python"):
		e.log(jobID, stepID, "stdout", "  Setting up Python (using system)")
		return e.runCommand(ctx, jobID, stepID, "python3 --version", workDir, nil)
	case strings.HasPrefix(step.Uses, "actions/setup-go"):
		e.log(jobID, stepID, "stdout", "  Setting up Go (using system)")
		return e.runCommand(ctx, jobID, stepID, "go version", workDir, nil)
	case strings.HasPrefix(step.Uses, "actions/cache"):
		e.log(jobID, stepID, "stdout", "  Cache restore skipped (local mode)")
		return 0
	default:
		e.log(jobID, stepID, "stdout", fmt.Sprintf("  Action %s running in local mode", step.Uses))
		return 0
	}
}

// runCommand executes a real shell command, streaming stdout/stderr live via logWriter
func (e *Executor) runCommand(ctx context.Context, jobID, stepID, script, workDir string, extraEnv map[string]string) int {
	cmd := exec.CommandContext(ctx, "sh", "-c", script)
	if workDir != "" { cmd.Dir = workDir }
	cmd.Env = os.Environ()
	for k, v := range extraEnv {
		cmd.Env = append(cmd.Env, k+"="+v)
	}

	stdout, _ := cmd.StdoutPipe()
	stderr, _ := cmd.StderrPipe()

	if err := cmd.Start(); err != nil {
		e.log(jobID, stepID, "stderr", "  error: "+err.Error())
		return 1
	}

	var wg sync.WaitGroup
	pipe := func(stream string, r *bufio.Reader) {
		defer wg.Done()
		for {
			line, err := r.ReadString('\n')
			line = strings.TrimRight(line, "\r\n")
			if line != "" { e.log(jobID, stepID, stream, "  "+line) }
			if err != nil { break }
		}
	}
	wg.Add(2)
	go pipe("stdout", bufio.NewReader(stdout))
	go pipe("stderr", bufio.NewReader(stderr))
	wg.Wait()

	if err := cmd.Wait(); err != nil {
		if exit, ok := err.(*exec.ExitError); ok { return exit.ExitCode() }
		return 130 // cancelled
	}
	return 0
}

func (e *Executor) log(jobID, stepID, stream, line string) {
	if e.logWriter != nil { e.logWriter(jobID, stepID, stream, line) }
	// Also capture into per-step log if we're collecting for this step
	if stepID != "" {
		e.mu.Lock()
		if sb, ok := e.stepLogs[stepID]; ok {
			sb.WriteString(line)
			sb.WriteString("\n")
		}
		e.mu.Unlock()
	}
}

// CloneRepo clones a git repo into workDir using optional PAT auth
func CloneRepo(ctx context.Context, repoURL, branch, token, workDir string, logFn func(string)) error {
	cloneURL := repoURL
	if token != "" { cloneURL = InjectToken(repoURL, token) }

	logFn(fmt.Sprintf("Cloning %s @ %s", repoURL, branch))
	cmd := exec.CommandContext(ctx, "git", "clone",
		"--depth", "1",
		"--branch", branch,
		"--single-branch",
		cloneURL, workDir,
	)
	out, err := cmd.CombinedOutput()
	for _, l := range strings.Split(string(out), "\n") {
		if t := strings.TrimSpace(l); t != "" { logFn("  " + t) }
	}
	if err != nil { return fmt.Errorf("git clone failed: %w", err) }
	logFn("✔ Cloned successfully")
	return nil
}

func GetLatestCommit(workDir string) (sha, msg string) {
	s, _ := exec.Command("git", "-C", workDir, "rev-parse", "--short", "HEAD").Output()
	m, _ := exec.Command("git", "-C", workDir, "log", "-1", "--pretty=%s").Output()
	return strings.TrimSpace(string(s)), strings.TrimSpace(string(m))
}

func FindCallahanfile(workDir string) (string, []byte) {
	for _, name := range []string{"Callahanfile.yaml", "Callahanfile.yml", ".callahan/pipeline.yaml", ".callahan.yaml"} {
		path := filepath.Join(workDir, name)
		if data, err := os.ReadFile(path); err == nil { return path, data }
	}
	return "", nil
}

func InjectToken(rawURL, token string) string {
	rawURL = strings.TrimPrefix(rawURL, "https://")
	rawURL = strings.TrimPrefix(rawURL, "http://")
	rawURL = strings.TrimPrefix(rawURL, "git@github.com:")
	rawURL = strings.TrimSuffix(rawURL, ".git")
	return fmt.Sprintf("https://x-access-token:%s@%s.git", token, rawURL)
}

func DefaultPipeline(language, framework string) string {
	t := map[string]string{
		"Go": `name: Callahan CI
on: [push, pull_request]
jobs:
  build:
    runs-on: local
    steps:
      - uses: actions/setup-go@v5
      - name: Download dependencies
        run: go mod download
      - name: Test
        run: go test -v ./...
`,
		"JavaScript/TypeScript": `name: Callahan CI
on: [push, pull_request]
jobs:
  build:
    runs-on: local
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Install
        run: npm ci
      - name: Test
        run: npm test
`,
		"Python": `name: Callahan CI
on: [push, pull_request]
jobs:
  build:
    runs-on: local
    steps:
      - uses: actions/setup-python@v5
      - name: Install
        run: pip install -r requirements.txt -r requirements-dev.txt
      - name: Test
        run: pytest -v
`,
	}
	if v, ok := t[language]; ok { return v }
	return t["JavaScript/TypeScript"]
}

func DetectLanguageFromFiles(files []string) (string, string) {
	for _, f := range files {
		switch {
		case strings.HasSuffix(f, "package.json"): return "JavaScript/TypeScript", "Node.js"
		case strings.HasSuffix(f, "go.mod"): return "Go", "Go modules"
		case strings.HasSuffix(f, "Cargo.toml"): return "Rust", "Cargo"
		case strings.HasSuffix(f, "requirements.txt"), strings.HasSuffix(f, "pyproject.toml"): return "Python", "pip"
		case strings.HasSuffix(f, "pom.xml"): return "Java", "Maven"
		case strings.HasSuffix(f, "Gemfile"): return "Ruby", "Bundler"
		}
	}
	return "unknown", "unknown"
}

// ──────────────────────────────────────────────────────────────────────────────
// AI Pipeline Helpers — used by handlers.go for post-build AI review & security scan
// ──────────────────────────────────────────────────────────────────────────────

// GetGitDiff returns the diff of the latest commit in workDir.
// Falls back to listing changed files if diff is empty (shallow clone).
func GetGitDiff(workDir string) string {
	// Try diff of HEAD against HEAD~1
	out, err := exec.Command("git", "-C", workDir, "diff", "HEAD~1", "HEAD").Output()
	if err == nil && len(out) > 0 {
		return string(out)
	}
	// Shallow clone fallback: show the full diff of HEAD commit
	out, _ = exec.Command("git", "-C", workDir, "diff-tree", "--no-commit-id", "-r", "-p", "HEAD").Output()
	if len(out) > 0 {
		return string(out)
	}
	// Last resort: list changed files
	out, _ = exec.Command("git", "-C", workDir, "diff-tree", "--no-commit-id", "-r", "--name-only", "HEAD").Output()
	return string(out)
}

// CollectSourceFiles reads key source files from workDir for AI review.
// It returns a combined string of filename + content, capped at maxBytes total.
func CollectSourceFiles(workDir string, maxBytes int) string {
	if maxBytes <= 0 { maxBytes = 15000 }

	// Source file extensions worth reviewing
	exts := map[string]bool{
		".go": true, ".py": true, ".js": true, ".ts": true, ".tsx": true, ".jsx": true,
		".java": true, ".rs": true, ".rb": true, ".c": true, ".cpp": true, ".cs": true,
		".php": true, ".swift": true, ".kt": true, ".scala": true,
		".yaml": true, ".yml": true, ".toml": true, ".json": true,
		".sh": true, ".bash": true, ".dockerfile": true,
	}
	// Directories to skip
	skipDirs := map[string]bool{
		".git": true, "node_modules": true, "vendor": true, ".next": true,
		"__pycache__": true, "dist": true, "build": true, "target": true,
		".callahan": true, "coverage": true,
	}

	var sb strings.Builder
	totalBytes := 0

	filepath.Walk(workDir, func(path string, info os.FileInfo, err error) error {
		if err != nil { return nil }
		if info.IsDir() {
			if skipDirs[info.Name()] { return filepath.SkipDir }
			return nil
		}
		if totalBytes >= maxBytes { return filepath.SkipAll }

		ext := strings.ToLower(filepath.Ext(info.Name()))
		// Also match Dockerfile, Makefile etc
		baseName := strings.ToLower(info.Name())
		if !exts[ext] && baseName != "dockerfile" && baseName != "makefile" {
			return nil
		}
		// Skip huge files
		if info.Size() > 50000 { return nil }

		relPath, _ := filepath.Rel(workDir, path)
		data, readErr := os.ReadFile(path)
		if readErr != nil { return nil }

		entry := fmt.Sprintf("\n--- %s ---\n%s\n", relPath, string(data))
		if totalBytes+len(entry) > maxBytes {
			// Truncate this file to fit
			remaining := maxBytes - totalBytes
			if remaining > 200 {
				entry = entry[:remaining] + "\n[truncated]\n"
			} else {
				return filepath.SkipAll
			}
		}
		sb.WriteString(entry)
		totalBytes += len(entry)
		return nil
	})

	return sb.String()
}

// RunSecurityScanner attempts to run trivy or semgrep in workDir.
// Returns (scannerName, jsonOutput, error).
// If neither tool is installed, returns ("", "", nil) — caller should fall back to AI-only.
func RunSecurityScanner(ctx context.Context, workDir string) (scanner, output string, err error) {
	// Try trivy first
	if _, lookErr := exec.LookPath("trivy"); lookErr == nil {
		cmd := exec.CommandContext(ctx, "trivy", "fs", "--format", "json", "--severity", "CRITICAL,HIGH,MEDIUM", "--scanners", "vuln,secret,misconfig", workDir)
		out, runErr := cmd.CombinedOutput()
		if runErr == nil || len(out) > 0 {
			return "trivy", string(out), nil
		}
	}

	// Try semgrep
	if _, lookErr := exec.LookPath("semgrep"); lookErr == nil {
		cmd := exec.CommandContext(ctx, "semgrep", "--json", "--config", "auto", workDir)
		out, runErr := cmd.CombinedOutput()
		if runErr == nil || len(out) > 0 {
			return "semgrep", string(out), nil
		}
	}

	// Neither installed
	return "", "", nil
}
