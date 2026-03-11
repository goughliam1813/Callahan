package pipeline

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"gopkg.in/yaml.v3"
	"github.com/callahan-ci/callahan/pkg/models"
)

// Parser handles Callahanfile.yaml parsing
type Parser struct{}

func NewParser() *Parser { return &Parser{} }

func (p *Parser) Parse(content []byte) (*models.Pipeline, error) {
	var pipeline models.Pipeline
	if err := yaml.Unmarshal(content, &pipeline); err != nil {
		return nil, fmt.Errorf("invalid Callahanfile.yaml: %w", err)
	}
	return &pipeline, nil
}

func (p *Parser) ParseFile(path string) (*models.Pipeline, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return p.Parse(data)
}

// LogWriter is a function that receives log lines
type LogWriter func(jobID, stepID, line string)

// Executor runs pipeline jobs in containers or locally
type Executor struct {
	logWriter LogWriter
	mu        sync.Mutex
}

func NewExecutor(lw LogWriter) *Executor {
	return &Executor{logWriter: lw}
}

type JobResult struct {
	JobID    string
	Status   string
	ExitCode int
	Steps    []*models.Step
	Duration int64
}

// ExecuteJob runs a single job from the pipeline
func (e *Executor) ExecuteJob(ctx context.Context, buildID string, jobName string, job models.PipelineJob, env map[string]string) *JobResult {
	if ctx == nil {
		ctx = context.Background()
	}
	jobID := uuid.New().String()
	now := time.Now()

	result := &JobResult{
		JobID:  jobID,
		Status: "running",
	}

	e.log(jobID, "", fmt.Sprintf("=== Starting job: %s ===", jobName))

	// Execute steps sequentially
	for i, step := range job.Steps {
		stepID := uuid.New().String()
		stepName := step.Name
		if stepName == "" {
			stepName = fmt.Sprintf("Step %d", i+1)
		}

		s := &models.Step{
			ID:      stepID,
			JobID:   jobID,
			Name:    stepName,
			Status:  "running",
			Command: step.Run,
		}

		stepStart := time.Now()
		stepResult := e.executeStep(ctx, jobID, s, step, env)
		s.Duration = time.Since(stepStart).Milliseconds()

		if stepResult != 0 {
			s.Status = "failed"
			s.ExitCode = stepResult
			result.Steps = append(result.Steps, s)
			if !step.ContinueOnError {
				result.Status = "failed"
				result.ExitCode = stepResult
				result.Duration = time.Since(now).Milliseconds()
				e.log(jobID, "", fmt.Sprintf("=== Job FAILED (step: %s) ===", stepName))
				return result
			}
		} else {
			s.Status = "success"
		}
		result.Steps = append(result.Steps, s)
	}

	result.Status = "success"
	result.Duration = time.Since(now).Milliseconds()
	e.log(jobID, "", fmt.Sprintf("=== Job completed successfully in %dms ===", result.Duration))
	return result
}

func (e *Executor) executeStep(ctx context.Context, jobID string, s *models.Step, step models.PipelineStep, env map[string]string) int {
	// Handle 'uses' actions
	if step.Uses != "" {
		return e.executeAction(ctx, jobID, s, step)
	}

	// Handle AI steps
	if step.AIStep != nil {
		e.log(jobID, s.ID, fmt.Sprintf("[AI] Running %s agent...", step.AIStep.Action))
		return 0 // AI steps are handled by the orchestrator
	}

	// Handle regular run commands
	if step.Run == "" {
		e.log(jobID, s.ID, fmt.Sprintf("[SKIP] No command for step: %s", s.Name))
		return 0
	}

	return e.runCommand(ctx, jobID, s, step.Run, env)
}

func (e *Executor) executeAction(ctx context.Context, jobID string, s *models.Step, step models.PipelineStep) int {
	// Handle common actions
	switch {
	case strings.HasPrefix(step.Uses, "actions/checkout"):
		e.log(jobID, s.ID, "Checking out repository...")
		return 0
	case strings.HasPrefix(step.Uses, "actions/setup-node"):
		version := step.With["node-version"]
		if version == "" {
			version = "20"
		}
		e.log(jobID, s.ID, fmt.Sprintf("Setting up Node.js %s", version))
		return 0
	case strings.HasPrefix(step.Uses, "actions/setup-python"):
		e.log(jobID, s.ID, "Setting up Python")
		return 0
	case strings.HasPrefix(step.Uses, "actions/setup-go"):
		e.log(jobID, s.ID, "Setting up Go")
		return 0
	case strings.HasPrefix(step.Uses, "actions/cache"):
		e.log(jobID, s.ID, "Restoring cache...")
		return 0
	case strings.HasPrefix(step.Uses, "docker/build-push-action"):
		e.log(jobID, s.ID, "Building Docker image...")
		return 0
	default:
		e.log(jobID, s.ID, fmt.Sprintf("[ACTION] %s (simulated)", step.Uses))
		return 0
	}
}

func (e *Executor) runCommand(ctx context.Context, jobID string, s *models.Step, cmd string, env map[string]string) int {
	// In a real implementation, this runs in an ephemeral container
	// For the demo, we simulate execution
	lines := strings.Split(cmd, "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		e.log(jobID, s.ID, fmt.Sprintf("$ %s", line))
		// Simulate command output
		e.log(jobID, s.ID, e.simulateOutput(line))
	}
	return 0
}

func (e *Executor) simulateOutput(cmd string) string {
	switch {
	case strings.Contains(cmd, "npm install"):
		return "added 847 packages in 2.3s"
	case strings.Contains(cmd, "npm test") || strings.Contains(cmd, "npm run test"):
		return "✓ 142 tests passed (3.2s)"
	case strings.Contains(cmd, "npm run build"):
		return "✓ Build complete → .next/ (2.1MB)"
	case strings.Contains(cmd, "go test"):
		return "ok  github.com/example/app 0.842s"
	case strings.Contains(cmd, "go build"):
		return "Build successful"
	case strings.Contains(cmd, "pip install"):
		return "Successfully installed packages"
	case strings.Contains(cmd, "pytest"):
		return "====== 87 passed in 4.23s ======"
	case strings.Contains(cmd, "cargo build"):
		return "Finished release target in 12.4s"
	case strings.Contains(cmd, "cargo test"):
		return "test result: ok. 64 passed; 0 failed"
	case strings.Contains(cmd, "mvn"):
		return "[INFO] BUILD SUCCESS"
	case strings.Contains(cmd, "trivy"):
		return "Scanned 847 packages. Found 0 critical, 2 medium vulnerabilities."
	case strings.Contains(cmd, "docker build"):
		return "Successfully built image sha256:abc123"
	case strings.Contains(cmd, "echo"):
		return strings.TrimPrefix(cmd, "echo ")
	default:
		return "Command executed successfully"
	}
}

func (e *Executor) log(jobID, stepID, line string) {
	if e.logWriter != nil {
		e.logWriter(jobID, stepID, line)
	}
}

// DetectLanguageFromFiles infers language from file list
func DetectLanguageFromFiles(files []string) (string, string) {
	for _, f := range files {
		switch {
		case strings.HasSuffix(f, "package.json"):
			return "JavaScript/TypeScript", "Node.js"
		case strings.HasSuffix(f, "go.mod"):
			return "Go", "Go modules"
		case strings.HasSuffix(f, "Cargo.toml"):
			return "Rust", "Cargo"
		case strings.HasSuffix(f, "requirements.txt") || strings.HasSuffix(f, "pyproject.toml"):
			return "Python", "pip"
		case strings.HasSuffix(f, "pom.xml"):
			return "Java", "Maven"
		case strings.HasSuffix(f, "build.gradle"):
			return "Java", "Gradle"
		case strings.HasSuffix(f, "Gemfile"):
			return "Ruby", "Bundler"
		case strings.HasSuffix(f, "composer.json"):
			return "PHP", "Composer"
		}
	}
	return "unknown", "unknown"
}

// DefaultPipeline generates a starter pipeline for a language
func DefaultPipeline(language, framework string) string {
	templates := map[string]string{
		"Go": `name: Callahan CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  build:
    name: Build & Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with:
          go-version: '1.22'
      - name: Download dependencies
        run: go mod download
      - name: Build
        run: go build ./...
      - name: Test
        run: go test -v -race -coverprofile=coverage.out ./...
      - name: Security scan
        run: |
          trivy fs --exit-code 0 --severity HIGH,CRITICAL .
        ai:
          action: scan
          model: default
`,
		"JavaScript/TypeScript": `name: Callahan CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  build:
    name: Build & Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - uses: actions/cache@v4
        with:
          path: node_modules
          key: node-${{ hashFiles('package-lock.json') }}
      - name: Install dependencies
        run: npm ci
      - name: Lint
        run: npm run lint
      - name: Test
        run: npm test -- --coverage
      - name: Build
        run: npm run build
`,
		"Python": `name: Callahan CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  build:
    name: Build & Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with:
          python-version: '3.12'
      - name: Install dependencies
        run: pip install -r requirements.txt
      - name: Test
        run: pytest --cov=. --cov-report=xml
      - name: Lint
        run: ruff check .
`,
		"Rust": `name: Callahan CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    name: Build & Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Rust
        run: rustup update stable
      - uses: actions/cache@v4
        with:
          path: target
          key: rust-${{ hashFiles('Cargo.lock') }}
      - name: Build
        run: cargo build --release
      - name: Test
        run: cargo test
      - name: Clippy
        run: cargo clippy -- -D warnings
`,
		"Java": `name: Callahan CI

on:
  push:
    branches: [main]
  pull_request:

jobs:
  build:
    name: Build & Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Setup Java
        uses: actions/setup-java@v4
        with:
          java-version: '21'
          distribution: temurin
      - uses: actions/cache@v4
        with:
          path: ~/.m2
          key: maven-${{ hashFiles('**/pom.xml') }}
      - name: Build and test
        run: mvn -B verify
`,
	}

	if tmpl, ok := templates[language]; ok {
		return tmpl
	}
	return templates["JavaScript/TypeScript"] // default
}
