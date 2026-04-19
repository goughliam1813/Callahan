package models

import (
	"time"

	"gopkg.in/yaml.v3"
)

// Project represents a connected Git repository
type Project struct {
	ID          string    `json:"id" db:"id"`
	Name        string    `json:"name" db:"name"`
	Description string    `json:"description" db:"description"`
	RepoURL     string    `json:"repo_url" db:"repo_url"`
	Provider    string    `json:"provider" db:"provider"` // github, gitlab, bitbucket, gitea
	Branch      string    `json:"branch" db:"branch"`
	Language    string    `json:"language" db:"language"`
	Framework   string    `json:"framework" db:"framework"`
	Status      string    `json:"status" db:"status"` // active, paused, error
	HealthScore int       `json:"health_score" db:"health_score"`
	CreatedAt   time.Time `json:"created_at" db:"created_at"`
	UpdatedAt   time.Time `json:"updated_at" db:"updated_at"`
}

// Build represents a pipeline execution
type Build struct {
	ID          string     `json:"id" db:"id"`
	ProjectID   string     `json:"project_id" db:"project_id"`
	Number      int        `json:"number" db:"number"`
	Status      string     `json:"status" db:"status"` // pending, running, success, failed, cancelled
	Branch      string     `json:"branch" db:"branch"`
	Commit      string     `json:"commit" db:"commit"`
	CommitMsg   string     `json:"commit_message" db:"commit_message"`
	Author      string     `json:"author" db:"author"`
	Duration    int64      `json:"duration_ms" db:"duration_ms"`
	StartedAt   *time.Time `json:"started_at" db:"started_at"`
	FinishedAt  *time.Time `json:"finished_at" db:"finished_at"`
	CreatedAt   time.Time  `json:"created_at" db:"created_at"`
	Trigger     string     `json:"trigger" db:"trigger"` // push, pr, manual, schedule
	AIInsight   string     `json:"ai_insight,omitempty" db:"ai_insight"`
}

// Job represents a job within a pipeline build
type Job struct {
	ID        string     `json:"id" db:"id"`
	BuildID   string     `json:"build_id" db:"build_id"`
	Name      string     `json:"name" db:"name"`
	Status    string     `json:"status" db:"status"`
	StartedAt *time.Time `json:"started_at" db:"started_at"`
	FinishedAt *time.Time `json:"finished_at" db:"finished_at"`
	Duration  int64      `json:"duration_ms" db:"duration_ms"`
	ExitCode  int        `json:"exit_code" db:"exit_code"`
}

// Step represents a single step within a job
type Step struct {
	ID        string     `json:"id" db:"id"`
	JobID     string     `json:"job_id" db:"job_id"`
	Name      string     `json:"name" db:"name"`
	Status    string     `json:"status" db:"status"`
	Command   string     `json:"command" db:"command"`
	Log       string     `json:"log,omitempty" db:"log"`
	StartedAt *time.Time `json:"started_at" db:"started_at"`
	FinishedAt *time.Time `json:"finished_at" db:"finished_at"`
	Duration  int64      `json:"duration_ms" db:"duration_ms"`
	ExitCode  int        `json:"exit_code" db:"exit_code"`
}

// Pipeline is the parsed Callahanfile.yaml
type Pipeline struct {
	Name     string                 `yaml:"name" json:"name"`
	On       PipelineTrigger        `yaml:"on" json:"on"`
	Env      map[string]string      `yaml:"env" json:"env"`
	Jobs     map[string]PipelineJob `yaml:"jobs" json:"jobs"`
	AI       *PipelineAIConfig      `yaml:"ai" json:"ai,omitempty"`
	Deploy   []DeployStage          `yaml:"deploy" json:"deploy,omitempty"`
}

// PipelineAIConfig holds the top-level ai: block from Callahanfile.yaml
type PipelineAIConfig struct {
	Review          bool `yaml:"review" json:"review"`
	SecurityScan    bool `yaml:"security-scan" json:"security_scan"`
	ExplainFailures bool `yaml:"explain-failures" json:"explain_failures"`
}

// DeployStage represents one environment in the CD daisy chain
type DeployStage struct {
	Name             string   `yaml:"name" json:"name"`                                         // environment name: dev, test, staging, prod
	Auto             bool     `yaml:"auto" json:"auto"`                                         // true = auto-deploy on previous stage success
	Gate             string   `yaml:"gate" json:"gate,omitempty"`                                // "manual" or "auto" (default auto if Auto=true)
	RequiresApproval bool     `yaml:"requires_approval" json:"requires_approval,omitempty"`      // needs explicit approval click
	Steps            []PipelineStep `yaml:"steps" json:"steps,omitempty"`                        // optional deploy steps to run
	Notify           []string `yaml:"notify" json:"notify,omitempty"`                            // e.g. ["slack:#deployments", "email:ops@co.com"]
	BranchFilter     string   `yaml:"branch_filter" json:"branch_filter,omitempty"`              // only deploy from this branch
}

type PipelineTrigger struct {
	Push             *PushTrigger `yaml:"push" json:"push,omitempty"`
	PullRequest      *PRTrigger   `yaml:"pull_request" json:"pull_request,omitempty"`
	Schedule         []Schedule   `yaml:"schedule" json:"schedule,omitempty"`
	WorkflowDispatch *struct{}    `yaml:"workflow_dispatch" json:"workflow_dispatch,omitempty"`
}

// UnmarshalYAML handles both shorthand (on: [push, pull_request]) and map forms.
func (pt *PipelineTrigger) UnmarshalYAML(value *yaml.Node) error {
	switch value.Kind {
	case yaml.SequenceNode:
		for _, item := range value.Content {
			switch item.Value {
			case "push":
				pt.Push = &PushTrigger{}
			case "pull_request":
				pt.PullRequest = &PRTrigger{}
			}
		}
		return nil
	case yaml.ScalarNode:
		switch value.Value {
		case "push":
			pt.Push = &PushTrigger{}
		case "pull_request":
			pt.PullRequest = &PRTrigger{}
		}
		return nil
	default:
		type plain PipelineTrigger
		return value.Decode((*plain)(pt))
	}
}

// StringOrSlice unmarshals either a scalar string or a sequence into []string.
type StringOrSlice []string

func (s *StringOrSlice) UnmarshalYAML(value *yaml.Node) error {
	if value.Kind == yaml.ScalarNode {
		*s = []string{value.Value}
		return nil
	}
	var slice []string
	if err := value.Decode(&slice); err != nil {
		return err
	}
	*s = slice
	return nil
}

type PushTrigger struct {
	Branches []string `yaml:"branches" json:"branches"`
	Tags     []string `yaml:"tags" json:"tags"`
}

type PRTrigger struct {
	Branches []string `yaml:"branches" json:"branches"`
}

type Schedule struct {
	Cron string `yaml:"cron" json:"cron"`
}

type PipelineJob struct {
	Name      string             `yaml:"name" json:"name"`
	RunsOn    string             `yaml:"runs-on" json:"runs_on"`
	Needs     StringOrSlice      `yaml:"needs" json:"needs"`
	Env       map[string]string  `yaml:"env" json:"env"`
	If        string             `yaml:"if" json:"if"`
	Matrix    *Matrix            `yaml:"matrix" json:"matrix,omitempty"`
	Services  map[string]Service `yaml:"services" json:"services,omitempty"`
	Steps     []PipelineStep     `yaml:"steps" json:"steps"`
	AI        *PipelineAIConfig  `yaml:"ai" json:"ai,omitempty"`
}

type Matrix struct {
	Include []map[string]string `yaml:"include" json:"include"`
	Exclude []map[string]string `yaml:"exclude" json:"exclude"`
	Values  map[string][]string `yaml:",inline" json:"values"`
}

type Service struct {
	Image string            `yaml:"image" json:"image"`
	Ports []string          `yaml:"ports" json:"ports"`
	Env   map[string]string `yaml:"env" json:"env"`
}

type PipelineStep struct {
	Name        string            `yaml:"name" json:"name"`
	Uses        string            `yaml:"uses" json:"uses"`
	Run         string            `yaml:"run" json:"run"`
	With        map[string]string `yaml:"with" json:"with"`
	Env         map[string]string `yaml:"env" json:"env"`
	If          string            `yaml:"if" json:"if"`
	ContinueOnError bool          `yaml:"continue-on-error" json:"continue_on_error"`
	AIStep      *AIStepConfig     `yaml:"ai" json:"ai,omitempty"`
}

type AIStepConfig struct {
	Action  string `yaml:"action" json:"action"` // review, test, scan, explain
	Model   string `yaml:"model" json:"model"`
	Prompt  string `yaml:"prompt" json:"prompt"`
}

// Webhook event from Git providers
type WebhookEvent struct {
	Provider  string    `json:"provider"`
	Event     string    `json:"event"` // push, pull_request
	Repo      string    `json:"repo"`
	Branch    string    `json:"branch"`
	Commit    string    `json:"commit"`
	CommitMsg string    `json:"commit_message"`
	Author    string    `json:"author"`
	PRNumber  int       `json:"pr_number,omitempty"`
	Timestamp time.Time `json:"timestamp"`
}

// LLMConfig for AI integration
type LLMConfig struct {
	Provider    string  `json:"provider"` // openai, anthropic, google, ollama, groq
	Model       string  `json:"model"`
	APIKey      string  `json:"api_key,omitempty"`
	BaseURL     string  `json:"base_url,omitempty"`
	Temperature float32 `json:"temperature"`
	MaxTokens   int     `json:"max_tokens"`
}

// Secret stored encrypted
type Secret struct {
	ID        string    `json:"id" db:"id"`
	ProjectID string    `json:"project_id" db:"project_id"`
	Name      string    `json:"name" db:"name"`
	Value     string    `json:"-" db:"value"` // encrypted
	CreatedAt time.Time `json:"created_at" db:"created_at"`
}

// AIReview result
type AIReview struct {
	BuildID    string   `json:"build_id"`
	Severity   string   `json:"severity"` // info, warning, error
	Summary    string   `json:"summary"`
	Findings   []string `json:"findings"`
	Suggestion string   `json:"suggestion"`
	AutoFix    bool     `json:"auto_fix_available"`
}

// SecurityScanResult holds AI-triaged security findings
type SecurityScanResult struct {
	BuildID      string              `json:"build_id"`
	Scanner      string              `json:"scanner"` // trivy, semgrep, ai-only
	Severity     string              `json:"severity"` // info, warning, error
	Summary      string              `json:"summary"`
	TotalFindings int                `json:"total_findings"`
	Critical     int                 `json:"critical"`
	High         int                 `json:"high"`
	Medium       int                 `json:"medium"`
	Low          int                 `json:"low"`
	Findings     []SecurityFinding   `json:"findings"`
	AIExplanation string             `json:"ai_explanation"`
}

// SecurityFinding is a single vulnerability or issue found by a scanner
type SecurityFinding struct {
	ID          string `json:"id"`
	Severity    string `json:"severity"` // CRITICAL, HIGH, MEDIUM, LOW
	Title       string `json:"title"`
	Description string `json:"description"`
	File        string `json:"file,omitempty"`
	Line        int    `json:"line,omitempty"`
	Fix         string `json:"fix,omitempty"`
}

// LogLine is a structured log entry streamed via WebSocket
type LogLine struct {
	BuildID   string    `json:"build_id"`
	JobID     string    `json:"job_id"`
	StepID    string    `json:"step_id"`
	Line      string    `json:"line"`
	Stream    string    `json:"stream"` // stdout, stderr
	Timestamp time.Time `json:"timestamp"`
}

// WSMessage is a WebSocket envelope
type WSMessage struct {
	Type    string      `json:"type"` // log, status, ai_insight
	Payload interface{} `json:"payload"`
}

// ─────────────────────────────────────────────────────────────────────────────
// V3: Environments
// ─────────────────────────────────────────────────────────────────────────────

type Environment struct {
	ID          string            `json:"id" db:"id"`
	ProjectID   string            `json:"project_id" db:"project_id"`
	Name        string            `json:"name" db:"name"`   // dev, test, staging, prod
	Description string            `json:"description" db:"description"`
	Color       string            `json:"color" db:"color"` // UI color hint
	AutoDeploy  bool              `json:"auto_deploy" db:"auto_deploy"`
	RequiresApproval bool         `json:"requires_approval" db:"requires_approval"`
	ApprovedBy  string            `json:"approved_by,omitempty" db:"approved_by"`
	BranchFilter string           `json:"branch_filter" db:"branch_filter"` // e.g. "main", "feature/*"
	EnvVars     map[string]string `json:"env_vars,omitempty"`
	CreatedAt   time.Time         `json:"created_at" db:"created_at"`
	UpdatedAt   time.Time         `json:"updated_at" db:"updated_at"`
}

type Deployment struct {
	ID            string     `json:"id" db:"id"`
	ProjectID     string     `json:"project_id" db:"project_id"`
	EnvironmentID string     `json:"environment_id" db:"environment_id"`
	BuildID       string     `json:"build_id" db:"build_id"`
	VersionID     string     `json:"version_id" db:"version_id"`
	Status        string     `json:"status" db:"status"` // pending, running, success, failed, rolled_back
	Strategy      string     `json:"strategy" db:"strategy"` // direct, blue_green, canary
	TriggeredBy   string     `json:"triggered_by" db:"triggered_by"`
	ApprovedBy    string     `json:"approved_by,omitempty" db:"approved_by"`
	StartedAt     *time.Time `json:"started_at,omitempty" db:"started_at"`
	FinishedAt    *time.Time `json:"finished_at,omitempty" db:"finished_at"`
	Duration      int64      `json:"duration_ms" db:"duration_ms"`
	Notes         string     `json:"notes,omitempty" db:"notes"`
	Log           string     `json:"log,omitempty" db:"log"`
	CreatedAt     time.Time  `json:"created_at" db:"created_at"`
}

// ─────────────────────────────────────────────────────────────────────────────
// V3: Versioning & Artifacts
// ─────────────────────────────────────────────────────────────────────────────

type Version struct {
	ID          string            `json:"id" db:"id"`
	ProjectID   string            `json:"project_id" db:"project_id"`
	BuildID     string            `json:"build_id" db:"build_id"`
	SemVer      string            `json:"semver" db:"semver"`       // e.g. "1.4.2"
	Tag         string            `json:"tag" db:"tag"`             // e.g. "v1.4.2"
	BumpType    string            `json:"bump_type" db:"bump_type"` // patch, minor, major
	BumpReason  string            `json:"bump_reason" db:"bump_reason"`
	GitTagged   bool              `json:"git_tagged" db:"git_tagged"`
	Changelog   string            `json:"changelog,omitempty" db:"changelog"`
	AIAnalysis  string            `json:"ai_analysis,omitempty" db:"ai_analysis"`
	Metadata    map[string]string `json:"metadata,omitempty"`
	CreatedAt   time.Time         `json:"created_at" db:"created_at"`
}

type Artifact struct {
	ID          string     `json:"id" db:"id"`
	ProjectID   string     `json:"project_id" db:"project_id"`
	BuildID     string     `json:"build_id" db:"build_id"`
	VersionID   string     `json:"version_id,omitempty" db:"version_id"`
	Name        string     `json:"name" db:"name"`
	Type        string     `json:"type" db:"type"`   // docker, npm, binary, archive, report
	Path        string     `json:"path" db:"path"`   // local path
	URL         string     `json:"url,omitempty" db:"url"`     // S3/remote URL if mirrored
	Size        int64      `json:"size_bytes" db:"size_bytes"`
	Checksum    string     `json:"checksum" db:"checksum"`
	Environment string     `json:"environment,omitempty" db:"environment"` // which env it was promoted to
	CreatedAt   time.Time  `json:"created_at" db:"created_at"`
}

// ─────────────────────────────────────────────────────────────────────────────
// V3: Notifications
// ─────────────────────────────────────────────────────────────────────────────

type NotificationChannel struct {
	ID        string            `json:"id" db:"id"`
	ProjectID string            `json:"project_id" db:"project_id"` // empty = global
	Platform  string            `json:"platform" db:"platform"` // slack, teams, jira, azuredevops, email, discord, webhook
	Name      string            `json:"name" db:"name"`
	Enabled   bool              `json:"enabled" db:"enabled"`
	Config    map[string]string `json:"config"` // webhook_url, token, channel, project_key, etc.
	OnSuccess bool              `json:"on_success" db:"on_success"`
	OnFailure bool              `json:"on_failure" db:"on_failure"`
	OnCancel  bool              `json:"on_cancel" db:"on_cancel"`
	AIMessage bool              `json:"ai_message" db:"ai_message"` // use AI to generate message
	CreatedAt time.Time         `json:"created_at" db:"created_at"`
	UpdatedAt time.Time         `json:"updated_at" db:"updated_at"`
}

type NotificationLog struct {
	ID          string    `json:"id" db:"id"`
	ChannelID   string    `json:"channel_id" db:"channel_id"`
	BuildID     string    `json:"build_id" db:"build_id"`
	Platform    string    `json:"platform" db:"platform"`
	Status      string    `json:"status" db:"status"` // sent, failed, skipped
	Payload     string    `json:"payload,omitempty" db:"payload"` // JSON of what was sent
	Response    string    `json:"response,omitempty" db:"response"`
	Error       string    `json:"error,omitempty" db:"error"`
	SentAt      time.Time `json:"sent_at" db:"sent_at"`
}

// ─────────────────────────────────────────────────────────────────────────────
// V3: AI Context Engine entries
// ─────────────────────────────────────────────────────────────────────────────

type ContextEntry struct {
	ID        string    `json:"id" db:"id"`
	ProjectID string    `json:"project_id" db:"project_id"`
	Type      string    `json:"type" db:"type"` // build, notification, version, deployment, error
	RefID     string    `json:"ref_id" db:"ref_id"` // build_id / version_id / deployment_id
	Summary   string    `json:"summary" db:"summary"` // human-readable one-liner
	Detail    string    `json:"detail,omitempty" db:"detail"` // full JSON blob
	Tags      string    `json:"tags,omitempty" db:"tags"` // comma-separated
	CreatedAt time.Time `json:"created_at" db:"created_at"`
}
