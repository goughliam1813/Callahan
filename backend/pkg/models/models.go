package models

import (
	"time"
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
	Name     string            `yaml:"name" json:"name"`
	On       PipelineTrigger   `yaml:"on" json:"on"`
	Env      map[string]string `yaml:"env" json:"env"`
	Jobs     map[string]PipelineJob `yaml:"jobs" json:"jobs"`
}

type PipelineTrigger struct {
	Push         *PushTrigger `yaml:"push" json:"push,omitempty"`
	PullRequest  *PRTrigger   `yaml:"pull_request" json:"pull_request,omitempty"`
	Schedule     []Schedule   `yaml:"schedule" json:"schedule,omitempty"`
	WorkflowDispatch *struct{} `yaml:"workflow_dispatch" json:"workflow_dispatch,omitempty"`
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
	Name      string            `yaml:"name" json:"name"`
	RunsOn    string            `yaml:"runs-on" json:"runs_on"`
	Needs     []string          `yaml:"needs" json:"needs"`
	Env       map[string]string `yaml:"env" json:"env"`
	If        string            `yaml:"if" json:"if"`
	Matrix    *Matrix           `yaml:"matrix" json:"matrix,omitempty"`
	Services  map[string]Service `yaml:"services" json:"services,omitempty"`
	Steps     []PipelineStep    `yaml:"steps" json:"steps"`
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

// LogLine is a structured log entry streamed via WebSocket
type LogLine struct {
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
