package storage

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	_ "github.com/mattn/go-sqlite3"
	"github.com/callahan-ci/callahan/pkg/models"
)

type Store struct {
	db *sql.DB
}

func New(dbPath string) (*Store, error) {
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL&_synchronous=NORMAL&_foreign_keys=on")
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	db.SetMaxOpenConns(1) // SQLite limitation
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		return nil, fmt.Errorf("migrate: %w", err)
	}
	return s, nil
}

func (s *Store) migrate() error {
	schema := `
CREATE TABLE IF NOT EXISTS projects (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT DEFAULT '',
	repo_url TEXT NOT NULL,
	provider TEXT NOT NULL DEFAULT 'github',
	branch TEXT NOT NULL DEFAULT 'main',
	language TEXT DEFAULT '',
	framework TEXT DEFAULT '',
	status TEXT NOT NULL DEFAULT 'active',
	health_score INTEGER DEFAULT 100,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS builds (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	number INTEGER NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	branch TEXT NOT NULL DEFAULT 'main',
	commit_sha TEXT DEFAULT '',
	commit_message TEXT DEFAULT '',
	author TEXT DEFAULT '',
	duration_ms INTEGER DEFAULT 0,
	started_at DATETIME,
	finished_at DATETIME,
	created_at DATETIME NOT NULL,
	trigger TEXT DEFAULT 'manual',
	ai_insight TEXT DEFAULT '',
	UNIQUE(project_id, number)
);

CREATE TABLE IF NOT EXISTS jobs (
	id TEXT PRIMARY KEY,
	build_id TEXT NOT NULL REFERENCES builds(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	started_at DATETIME,
	finished_at DATETIME,
	duration_ms INTEGER DEFAULT 0,
	exit_code INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS steps (
	id TEXT PRIMARY KEY,
	job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	command TEXT DEFAULT '',
	log TEXT DEFAULT '',
	started_at DATETIME,
	finished_at DATETIME,
	duration_ms INTEGER DEFAULT 0,
	exit_code INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS secrets (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	value TEXT NOT NULL,
	created_at DATETIME NOT NULL,
	UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS llm_configs (
	id TEXT PRIMARY KEY,
	project_id TEXT,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	api_key_encrypted TEXT DEFAULT '',
	base_url TEXT DEFAULT '',
	temperature REAL DEFAULT 0.3,
	max_tokens INTEGER DEFAULT 4096,
	is_default INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS system_settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL DEFAULT '',
	updated_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_builds_project ON builds(project_id);
CREATE INDEX IF NOT EXISTS idx_builds_status ON builds(status);
CREATE INDEX IF NOT EXISTS idx_jobs_build ON jobs(build_id);
CREATE INDEX IF NOT EXISTS idx_steps_job ON steps(job_id);
`
	_, err := s.db.Exec(schema)
	if err != nil {
		return err
	}
	// Add pipeline_content column if it doesn't exist (safe on existing DBs)
	_, _ = s.db.Exec(`ALTER TABLE projects ADD COLUMN pipeline_content TEXT DEFAULT ''`)
	// Add PR tracking columns to builds (idempotent — error swallowed if already added)
	_, _ = s.db.Exec(`ALTER TABLE builds ADD COLUMN pr_number INTEGER DEFAULT 0`)
	_, _ = s.db.Exec(`ALTER TABLE builds ADD COLUMN repo_slug TEXT DEFAULT ''`)
	return nil
}

func (s *Store) GetPipeline(projectID string) (string, error) {
	var content string
	err := s.db.QueryRow(`SELECT COALESCE(pipeline_content,'') FROM projects WHERE id=?`, projectID).Scan(&content)
	if err == sql.ErrNoRows { return "", nil }
	return content, err
}

func (s *Store) SavePipeline(projectID, content string) error {
	_, err := s.db.Exec(`UPDATE projects SET pipeline_content=? WHERE id=?`, content, projectID)
	return err
}

// Projects
func (s *Store) CreateProject(p *models.Project) error {
	_, err := s.db.Exec(`
		INSERT INTO projects (id,name,description,repo_url,provider,branch,language,framework,status,health_score,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		p.ID, p.Name, p.Description, p.RepoURL, p.Provider, p.Branch,
		p.Language, p.Framework, p.Status, p.HealthScore, p.CreatedAt, p.UpdatedAt)
	return err
}

func (s *Store) GetProject(id string) (*models.Project, error) {
	p := &models.Project{}
	err := s.db.QueryRow(`SELECT id,name,description,repo_url,provider,branch,language,framework,status,health_score,created_at,updated_at FROM projects WHERE id=?`, id).
		Scan(&p.ID, &p.Name, &p.Description, &p.RepoURL, &p.Provider, &p.Branch, &p.Language, &p.Framework, &p.Status, &p.HealthScore, &p.CreatedAt, &p.UpdatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return p, err
}

func (s *Store) ListProjects() ([]*models.Project, error) {
	rows, err := s.db.Query(`SELECT id,name,description,repo_url,provider,branch,language,framework,status,health_score,created_at,updated_at FROM projects ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var projects []*models.Project
	for rows.Next() {
		p := &models.Project{}
		if err := rows.Scan(&p.ID, &p.Name, &p.Description, &p.RepoURL, &p.Provider, &p.Branch, &p.Language, &p.Framework, &p.Status, &p.HealthScore, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		projects = append(projects, p)
	}
	return projects, nil
}

func (s *Store) UpdateProject(p *models.Project) error {
	p.UpdatedAt = time.Now()
	_, err := s.db.Exec(`UPDATE projects SET name=?,description=?,branch=?,language=?,framework=?,status=?,health_score=?,updated_at=? WHERE id=?`,
		p.Name, p.Description, p.Branch, p.Language, p.Framework, p.Status, p.HealthScore, p.UpdatedAt, p.ID)
	return err
}

func (s *Store) DeleteProject(id string) error {
	// V3 tables use FK with CASCADE, but context_entries doesn't have a formal FK.
	// Explicitly clean all related data to be safe.
	tx, err := s.db.Begin()
	if err != nil { return err }
	defer tx.Rollback()

	// Delete in dependency order (children first)
	tx.Exec(`DELETE FROM context_entries WHERE project_id=?`, id)
	tx.Exec(`DELETE FROM notification_logs WHERE build_id IN (SELECT id FROM builds WHERE project_id=?)`, id)
	tx.Exec(`DELETE FROM notification_channels WHERE project_id=?`, id)
	tx.Exec(`DELETE FROM artifacts WHERE project_id=?`, id)
	tx.Exec(`DELETE FROM versions WHERE project_id=?`, id)
	tx.Exec(`DELETE FROM deployments WHERE project_id=?`, id)
	tx.Exec(`DELETE FROM environments WHERE project_id=?`, id)
	// steps → jobs → builds cascade via FK, but be explicit
	tx.Exec(`DELETE FROM steps WHERE job_id IN (SELECT id FROM jobs WHERE build_id IN (SELECT id FROM builds WHERE project_id=?))`, id)
	tx.Exec(`DELETE FROM jobs WHERE build_id IN (SELECT id FROM builds WHERE project_id=?)`, id)
	tx.Exec(`DELETE FROM builds WHERE project_id=?`, id)
	tx.Exec(`DELETE FROM secrets WHERE project_id=?`, id)
	tx.Exec(`DELETE FROM projects WHERE id=?`, id)

	return tx.Commit()
}

// Builds
func (s *Store) CreateBuild(b *models.Build) error {
	_, err := s.db.Exec(`
		INSERT INTO builds (id,project_id,number,status,branch,commit_sha,commit_message,author,duration_ms,started_at,finished_at,created_at,trigger,ai_insight,pr_number,repo_slug)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		b.ID, b.ProjectID, b.Number, b.Status, b.Branch, b.Commit, b.CommitMsg,
		b.Author, b.Duration, b.StartedAt, b.FinishedAt, b.CreatedAt, b.Trigger, b.AIInsight,
		b.PRNumber, b.RepoSlug)
	return err
}

func (s *Store) GetBuild(id string) (*models.Build, error) {
	b := &models.Build{}
	err := s.db.QueryRow(`SELECT id,project_id,number,status,branch,commit_sha,commit_message,author,duration_ms,started_at,finished_at,created_at,trigger,ai_insight,COALESCE(pr_number,0),COALESCE(repo_slug,'') FROM builds WHERE id=?`, id).
		Scan(&b.ID, &b.ProjectID, &b.Number, &b.Status, &b.Branch, &b.Commit, &b.CommitMsg, &b.Author, &b.Duration, &b.StartedAt, &b.FinishedAt, &b.CreatedAt, &b.Trigger, &b.AIInsight, &b.PRNumber, &b.RepoSlug)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return b, err
}

func (s *Store) ListBuilds(projectID string, limit int) ([]*models.Build, error) {
	rows, err := s.db.Query(`SELECT id,project_id,number,status,branch,commit_sha,commit_message,author,duration_ms,started_at,finished_at,created_at,trigger,ai_insight,COALESCE(pr_number,0),COALESCE(repo_slug,'') FROM builds WHERE project_id=? ORDER BY number DESC LIMIT ?`, projectID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var builds []*models.Build
	for rows.Next() {
		b := &models.Build{}
		if err := rows.Scan(&b.ID, &b.ProjectID, &b.Number, &b.Status, &b.Branch, &b.Commit, &b.CommitMsg, &b.Author, &b.Duration, &b.StartedAt, &b.FinishedAt, &b.CreatedAt, &b.Trigger, &b.AIInsight, &b.PRNumber, &b.RepoSlug); err != nil {
			return nil, err
		}
		builds = append(builds, b)
	}
	return builds, nil
}

func (s *Store) UpdateBuildStatus(id, status string, finishedAt *time.Time, duration int64, aiInsight string) error {
	_, err := s.db.Exec(`UPDATE builds SET status=?,finished_at=?,duration_ms=?,ai_insight=? WHERE id=?`,
		status, finishedAt, duration, aiInsight, id)
	return err
}

func (s *Store) GetNextBuildNumber(projectID string) (int, error) {
	var max sql.NullInt64
	err := s.db.QueryRow(`SELECT MAX(number) FROM builds WHERE project_id=?`, projectID).Scan(&max)
	if err != nil {
		return 1, err
	}
	return int(max.Int64) + 1, nil
}

// Jobs
func (s *Store) CreateJob(j *models.Job) error {
	_, err := s.db.Exec(`INSERT INTO jobs (id,build_id,name,status) VALUES (?,?,?,?)`,
		j.ID, j.BuildID, j.Name, j.Status)
	return err
}

func (s *Store) UpdateJob(j *models.Job) error {
	_, err := s.db.Exec(`UPDATE jobs SET status=?,started_at=?,finished_at=?,duration_ms=?,exit_code=? WHERE id=?`,
		j.Status, j.StartedAt, j.FinishedAt, j.Duration, j.ExitCode, j.ID)
	return err
}

func (s *Store) ListJobs(buildID string) ([]*models.Job, error) {
	rows, err := s.db.Query(`SELECT id,build_id,name,status,started_at,finished_at,duration_ms,exit_code FROM jobs WHERE build_id=? ORDER BY rowid`, buildID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var jobs []*models.Job
	for rows.Next() {
		j := &models.Job{}
		if err := rows.Scan(&j.ID, &j.BuildID, &j.Name, &j.Status, &j.StartedAt, &j.FinishedAt, &j.Duration, &j.ExitCode); err != nil {
			return nil, err
		}
		jobs = append(jobs, j)
	}
	return jobs, nil
}

// Steps
func (s *Store) CreateStep(step *models.Step) error {
	_, err := s.db.Exec(`INSERT OR REPLACE INTO steps (id,job_id,name,status,command,log,duration_ms,exit_code) VALUES (?,?,?,?,?,?,?,?)`,
		step.ID, step.JobID, step.Name, step.Status, step.Command, step.Log, step.Duration, step.ExitCode)
	return err
}

func (s *Store) UpdateStep(step *models.Step) error {
	_, err := s.db.Exec(`UPDATE steps SET status=?,log=?,started_at=?,finished_at=?,duration_ms=?,exit_code=? WHERE id=?`,
		step.Status, step.Log, step.StartedAt, step.FinishedAt, step.Duration, step.ExitCode, step.ID)
	return err
}

func (s *Store) AppendStepLog(stepID, line string) error {
	_, err := s.db.Exec(`UPDATE steps SET log=log||? WHERE id=?`, line+"\n", stepID)
	return err
}

func (s *Store) ListSteps(jobID string) ([]*models.Step, error) {
	rows, err := s.db.Query(`SELECT id,job_id,name,status,command,log,started_at,finished_at,duration_ms,exit_code FROM steps WHERE job_id=? ORDER BY rowid`, jobID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var steps []*models.Step
	for rows.Next() {
		step := &models.Step{}
		if err := rows.Scan(&step.ID, &step.JobID, &step.Name, &step.Status, &step.Command, &step.Log, &step.StartedAt, &step.FinishedAt, &step.Duration, &step.ExitCode); err != nil {
			return nil, err
		}
		steps = append(steps, step)
	}
	return steps, nil
}

// Secrets
func (s *Store) SetSecret(secret *models.Secret) error {
	_, err := s.db.Exec(`INSERT OR REPLACE INTO secrets (id,project_id,name,value,created_at) VALUES (?,?,?,?,?)`,
		secret.ID, secret.ProjectID, secret.Name, secret.Value, secret.CreatedAt)
	return err
}

func (s *Store) GetSecret(projectID, name string) (string, error) {
	var val string
	err := s.db.QueryRow(`SELECT value FROM secrets WHERE project_id=? AND name=?`, projectID, name).Scan(&val)
	if err == sql.ErrNoRows { return "", nil }
	return val, err
}

func (s *Store) ListSecretNames(projectID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT name FROM secrets WHERE project_id=? ORDER BY name`, projectID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var n string
		rows.Scan(&n)
		names = append(names, n)
	}
	return names, nil
}

// Stats for dashboard
type DashboardStats struct {
	TotalProjects int     `json:"total_projects"`
	TotalBuilds   int     `json:"total_builds"`
	SuccessRate   float64 `json:"success_rate"`
	AvgDuration   int64   `json:"avg_duration_ms"`
	RunningBuilds int     `json:"running_builds"`
}

func (s *Store) GetDashboardStats() (*DashboardStats, error) {
	stats := &DashboardStats{}
	s.db.QueryRow(`SELECT COUNT(*) FROM projects`).Scan(&stats.TotalProjects)
	s.db.QueryRow(`SELECT COUNT(*) FROM builds`).Scan(&stats.TotalBuilds)
	s.db.QueryRow(`SELECT COUNT(*) FROM builds WHERE status='running'`).Scan(&stats.RunningBuilds)
	var success, total int
	s.db.QueryRow(`SELECT COUNT(*) FROM builds WHERE status IN ('success','failed')`).Scan(&total)
	s.db.QueryRow(`SELECT COUNT(*) FROM builds WHERE status='success'`).Scan(&success)
	if total > 0 {
		stats.SuccessRate = float64(success) / float64(total) * 100
	}
	s.db.QueryRow(`SELECT COALESCE(AVG(duration_ms),0) FROM builds WHERE status='success'`).Scan(&stats.AvgDuration)
	return stats, nil
}

// DeleteSecret removes a secret by project + name
func (s *Store) DeleteSecret(projectID, name string) error {
	_, err := s.db.Exec(`DELETE FROM secrets WHERE project_id=? AND name=?`, projectID, name)
	return err
}

// GetAllSecrets returns all secrets for a project as a key→value map (for env injection)
func (s *Store) GetAllSecrets(projectID string) (map[string]string, error) {
	rows, err := s.db.Query(`SELECT name,value FROM secrets WHERE project_id=?`, projectID)
	if err != nil { return nil, err }
	defer rows.Close()
	m := map[string]string{}
	for rows.Next() {
		var k, v string
		rows.Scan(&k, &v)
		m[k] = v
	}
	return m, nil
}

// UpdateBuildCommit stores the real commit SHA and message after cloning
func (s *Store) UpdateBuildCommit(buildID, sha, msg string) error {
	_, err := s.db.Exec(`UPDATE builds SET commit_sha=?, commit_message=? WHERE id=?`, sha, msg, buildID)
	return err
}

// System settings (key-value store for LLM config etc)
func (s *Store) GetSystemSetting(key string) (string, error) {
	var val string
	err := s.db.QueryRow(`SELECT value FROM system_settings WHERE key=?`, key).Scan(&val)
	if err == sql.ErrNoRows { return "", nil }
	return val, err
}

func (s *Store) SetSystemSetting(key, value string) error {
	_, err := s.db.Exec(`INSERT OR REPLACE INTO system_settings (key,value,updated_at) VALUES (?,?,?)`,
		key, value, time.Now())
	return err
}

// ─────────────────────────────────────────────────────────────────────────────
// V3 migration — run once at startup (idempotent)
// ─────────────────────────────────────────────────────────────────────────────

func (s *Store) MigrateV3() error {
	schema := `
CREATE TABLE IF NOT EXISTS environments (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	name TEXT NOT NULL,
	description TEXT DEFAULT '',
	color TEXT DEFAULT '#545f72',
	auto_deploy INTEGER DEFAULT 0,
	requires_approval INTEGER DEFAULT 0,
	approved_by TEXT DEFAULT '',
	branch_filter TEXT DEFAULT '',
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL,
	UNIQUE(project_id, name)
);

CREATE TABLE IF NOT EXISTS deployments (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
	build_id TEXT NOT NULL,
	version_id TEXT DEFAULT '',
	status TEXT NOT NULL DEFAULT 'pending',
	strategy TEXT DEFAULT 'direct',
	triggered_by TEXT DEFAULT '',
	approved_by TEXT DEFAULT '',
	started_at DATETIME,
	finished_at DATETIME,
	duration_ms INTEGER DEFAULT 0,
	notes TEXT DEFAULT '',
	created_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS versions (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	build_id TEXT NOT NULL,
	semver TEXT NOT NULL,
	tag TEXT NOT NULL,
	bump_type TEXT NOT NULL DEFAULT 'patch',
	bump_reason TEXT DEFAULT '',
	git_tagged INTEGER DEFAULT 0,
	changelog TEXT DEFAULT '',
	ai_analysis TEXT DEFAULT '',
	created_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	build_id TEXT NOT NULL,
	version_id TEXT DEFAULT '',
	name TEXT NOT NULL,
	type TEXT NOT NULL DEFAULT 'binary',
	path TEXT NOT NULL,
	url TEXT DEFAULT '',
	size_bytes INTEGER DEFAULT 0,
	checksum TEXT DEFAULT '',
	environment TEXT DEFAULT '',
	created_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_channels (
	id TEXT PRIMARY KEY,
	project_id TEXT DEFAULT '',
	platform TEXT NOT NULL,
	name TEXT NOT NULL,
	enabled INTEGER DEFAULT 1,
	config TEXT NOT NULL DEFAULT '{}',
	on_success INTEGER DEFAULT 1,
	on_failure INTEGER DEFAULT 1,
	on_cancel INTEGER DEFAULT 0,
	ai_message INTEGER DEFAULT 0,
	created_at DATETIME NOT NULL,
	updated_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_logs (
	id TEXT PRIMARY KEY,
	channel_id TEXT NOT NULL,
	build_id TEXT NOT NULL,
	platform TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'pending',
	payload TEXT DEFAULT '',
	response TEXT DEFAULT '',
	error TEXT DEFAULT '',
	sent_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS context_entries (
	id TEXT PRIMARY KEY,
	project_id TEXT NOT NULL,
	type TEXT NOT NULL,
	ref_id TEXT NOT NULL,
	summary TEXT NOT NULL,
	detail TEXT DEFAULT '',
	tags TEXT DEFAULT '',
	created_at DATETIME NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_deployments_project ON deployments(project_id);
CREATE INDEX IF NOT EXISTS idx_deployments_env ON deployments(environment_id);
CREATE INDEX IF NOT EXISTS idx_versions_project ON versions(project_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_build ON artifacts(build_id);
CREATE INDEX IF NOT EXISTS idx_notif_logs_build ON notification_logs(build_id);
CREATE INDEX IF NOT EXISTS idx_context_project ON context_entries(project_id);
CREATE INDEX IF NOT EXISTS idx_context_type ON context_entries(type);
`
	_, err := s.db.Exec(schema)
	if err != nil { return err }
	// Safe to run on existing DBs — ignored if column already exists
	_, _ = s.db.Exec(`ALTER TABLE deployments ADD COLUMN log TEXT DEFAULT ''`)
	return nil
}

// ─── Environments ─────────────────────────────────────────────────────────────

func (s *Store) CreateEnvironment(e *models.Environment) error {
	_, err := s.db.Exec(`INSERT OR IGNORE INTO environments
		(id,project_id,name,description,color,auto_deploy,requires_approval,branch_filter,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)`,
		e.ID, e.ProjectID, e.Name, e.Description, e.Color,
		boolInt(e.AutoDeploy), boolInt(e.RequiresApproval),
		e.BranchFilter, e.CreatedAt, e.UpdatedAt)
	return err
}

func (s *Store) ListEnvironments(projectID string) ([]*models.Environment, error) {
	rows, err := s.db.Query(`SELECT id,project_id,name,description,color,auto_deploy,requires_approval,branch_filter,created_at,updated_at
		FROM environments WHERE project_id=? ORDER BY created_at`, projectID)
	if err != nil { return nil, err }
	defer rows.Close()
	var envs []*models.Environment
	for rows.Next() {
		e := &models.Environment{}
		var ad, ra int
		rows.Scan(&e.ID,&e.ProjectID,&e.Name,&e.Description,&e.Color,&ad,&ra,&e.BranchFilter,&e.CreatedAt,&e.UpdatedAt)
		e.AutoDeploy = ad==1; e.RequiresApproval = ra==1
		envs = append(envs, e)
	}
	return envs, nil
}

func (s *Store) GetEnvironment(id string) (*models.Environment, error) {
	e := &models.Environment{}
	var ad, ra int
	err := s.db.QueryRow(`SELECT id,project_id,name,description,color,auto_deploy,requires_approval,branch_filter,created_at,updated_at
		FROM environments WHERE id=?`, id).Scan(
		&e.ID,&e.ProjectID,&e.Name,&e.Description,&e.Color,&ad,&ra,&e.BranchFilter,&e.CreatedAt,&e.UpdatedAt)
	if err == sql.ErrNoRows { return nil, nil }
	e.AutoDeploy = ad==1; e.RequiresApproval = ra==1
	return e, err
}

func (s *Store) UpdateEnvironment(e *models.Environment) error {
	_, err := s.db.Exec(`UPDATE environments SET name=?,description=?,color=?,auto_deploy=?,requires_approval=?,branch_filter=?,updated_at=? WHERE id=?`,
		e.Name,e.Description,e.Color,boolInt(e.AutoDeploy),boolInt(e.RequiresApproval),e.BranchFilter,time.Now(),e.ID)
	return err
}

func (s *Store) DeleteEnvironment(id string) error {
	_, err := s.db.Exec(`DELETE FROM environments WHERE id=?`, id)
	return err
}

func (s *Store) CreateDeployment(d *models.Deployment) error {
	_, err := s.db.Exec(`INSERT INTO deployments
		(id,project_id,environment_id,build_id,version_id,status,strategy,triggered_by,notes,created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?)`,
		d.ID,d.ProjectID,d.EnvironmentID,d.BuildID,d.VersionID,d.Status,d.Strategy,d.TriggeredBy,d.Notes,d.CreatedAt)
	return err
}

func (s *Store) UpdateDeploymentStatus(id, status string, finishedAt *time.Time, duration int64) error {
	_, err := s.db.Exec(`UPDATE deployments SET status=?,finished_at=?,duration_ms=? WHERE id=?`,
		status, finishedAt, duration, id)
	return err
}

func (s *Store) UpdateDeploymentLog(id, log string) error {
	_, err := s.db.Exec(`UPDATE deployments SET log=? WHERE id=?`, log, id)
	return err
}

func (s *Store) ListDeployments(projectID string, limit int) ([]*models.Deployment, error) {
	rows, err := s.db.Query(`SELECT id,project_id,environment_id,build_id,version_id,status,strategy,triggered_by,approved_by,started_at,finished_at,duration_ms,notes,created_at
		FROM deployments WHERE project_id=? ORDER BY created_at DESC LIMIT ?`, projectID, limit)
	if err != nil { return nil, err }
	defer rows.Close()
	var ds []*models.Deployment
	for rows.Next() {
		d := &models.Deployment{}
		rows.Scan(&d.ID,&d.ProjectID,&d.EnvironmentID,&d.BuildID,&d.VersionID,&d.Status,&d.Strategy,&d.TriggeredBy,&d.ApprovedBy,&d.StartedAt,&d.FinishedAt,&d.Duration,&d.Notes,&d.CreatedAt)
		ds = append(ds, d)
	}
	return ds, nil
}

func (s *Store) GetDeployment(id string) (*models.Deployment, error) {
	d := &models.Deployment{}
	err := s.db.QueryRow(`SELECT id,project_id,environment_id,build_id,version_id,status,strategy,triggered_by,created_at,COALESCE(log,'')
		FROM deployments WHERE id=?`, id).
		Scan(&d.ID,&d.ProjectID,&d.EnvironmentID,&d.BuildID,&d.VersionID,&d.Status,&d.Strategy,&d.TriggeredBy,&d.CreatedAt,&d.Log)
	if err == sql.ErrNoRows { return nil, nil }
	return d, err
}

func (s *Store) LatestDeploymentForEnv(envID string) (*models.Deployment, error) {
	d := &models.Deployment{}
	err := s.db.QueryRow(`SELECT id,project_id,environment_id,build_id,version_id,status,strategy,triggered_by,created_at
		FROM deployments WHERE environment_id=? ORDER BY created_at DESC LIMIT 1`, envID).
		Scan(&d.ID,&d.ProjectID,&d.EnvironmentID,&d.BuildID,&d.VersionID,&d.Status,&d.Strategy,&d.TriggeredBy,&d.CreatedAt)
	if err == sql.ErrNoRows { return nil, nil }
	return d, err
}

// ─── Versions ─────────────────────────────────────────────────────────────────

func (s *Store) CreateVersion(v *models.Version) error {
	_, err := s.db.Exec(`INSERT INTO versions
		(id,project_id,build_id,semver,tag,bump_type,bump_reason,git_tagged,changelog,ai_analysis,created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		v.ID,v.ProjectID,v.BuildID,v.SemVer,v.Tag,v.BumpType,v.BumpReason,
		boolInt(v.GitTagged),v.Changelog,v.AIAnalysis,v.CreatedAt)
	return err
}

func (s *Store) ListVersions(projectID string, limit int) ([]*models.Version, error) {
	rows, err := s.db.Query(`SELECT id,project_id,build_id,semver,tag,bump_type,bump_reason,git_tagged,changelog,ai_analysis,created_at
		FROM versions WHERE project_id=? ORDER BY created_at DESC LIMIT ?`, projectID, limit)
	if err != nil { return nil, err }
	defer rows.Close()
	var vs []*models.Version
	for rows.Next() {
		v := &models.Version{}
		var gt int
		rows.Scan(&v.ID,&v.ProjectID,&v.BuildID,&v.SemVer,&v.Tag,&v.BumpType,&v.BumpReason,&gt,&v.Changelog,&v.AIAnalysis,&v.CreatedAt)
		v.GitTagged = gt==1
		vs = append(vs, v)
	}
	return vs, nil
}

func (s *Store) LatestVersion(projectID string) (*models.Version, error) {
	v := &models.Version{}
	var gt int
	err := s.db.QueryRow(`SELECT id,project_id,build_id,semver,tag,bump_type,bump_reason,git_tagged,changelog,ai_analysis,created_at
		FROM versions WHERE project_id=? ORDER BY created_at DESC LIMIT 1`, projectID).
		Scan(&v.ID,&v.ProjectID,&v.BuildID,&v.SemVer,&v.Tag,&v.BumpType,&v.BumpReason,&gt,&v.Changelog,&v.AIAnalysis,&v.CreatedAt)
	if err == sql.ErrNoRows { return nil, nil }
	v.GitTagged = gt==1
	return v, err
}

// ─── Artifacts ────────────────────────────────────────────────────────────────

func (s *Store) CreateArtifact(a *models.Artifact) error {
	_, err := s.db.Exec(`INSERT INTO artifacts
		(id,project_id,build_id,version_id,name,type,path,url,size_bytes,checksum,environment,created_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		a.ID,a.ProjectID,a.BuildID,a.VersionID,a.Name,a.Type,a.Path,a.URL,a.Size,a.Checksum,a.Environment,a.CreatedAt)
	return err
}

func (s *Store) ListArtifacts(buildID string) ([]*models.Artifact, error) {
	rows, err := s.db.Query(`SELECT id,project_id,build_id,version_id,name,type,path,url,size_bytes,checksum,environment,created_at
		FROM artifacts WHERE build_id=? ORDER BY created_at`, buildID)
	if err != nil { return nil, err }
	defer rows.Close()
	var arts []*models.Artifact
	for rows.Next() {
		a := &models.Artifact{}
		rows.Scan(&a.ID,&a.ProjectID,&a.BuildID,&a.VersionID,&a.Name,&a.Type,&a.Path,&a.URL,&a.Size,&a.Checksum,&a.Environment,&a.CreatedAt)
		arts = append(arts, a)
	}
	return arts, nil
}

func (s *Store) PromoteArtifact(artifactID, environment string) error {
	_, err := s.db.Exec(`UPDATE artifacts SET environment=? WHERE id=?`, environment, artifactID)
	return err
}

// ─── Notification Channels ────────────────────────────────────────────────────

func (s *Store) UpsertNotificationChannel(ch *models.NotificationChannel) error {
	cfg, _ := json.Marshal(ch.Config)
	_, err := s.db.Exec(`INSERT OR REPLACE INTO notification_channels
		(id,project_id,platform,name,enabled,config,on_success,on_failure,on_cancel,ai_message,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		ch.ID,ch.ProjectID,ch.Platform,ch.Name,boolInt(ch.Enabled),string(cfg),
		boolInt(ch.OnSuccess),boolInt(ch.OnFailure),boolInt(ch.OnCancel),boolInt(ch.AIMessage),
		ch.CreatedAt,ch.UpdatedAt)
	return err
}

func (s *Store) ListNotificationChannels(projectID string) ([]*models.NotificationChannel, error) {
	// Returns project-specific + global channels
	rows, err := s.db.Query(`SELECT id,project_id,platform,name,enabled,config,on_success,on_failure,on_cancel,ai_message,created_at,updated_at
		FROM notification_channels WHERE project_id=? OR project_id='' ORDER BY created_at`, projectID)
	if err != nil { return nil, err }
	defer rows.Close()
	var chs []*models.NotificationChannel
	for rows.Next() {
		ch := &models.NotificationChannel{}
		var en,os,of,oc,aim int
		var cfgStr string
		rows.Scan(&ch.ID,&ch.ProjectID,&ch.Platform,&ch.Name,&en,&cfgStr,&os,&of,&oc,&aim,&ch.CreatedAt,&ch.UpdatedAt)
		ch.Enabled=en==1; ch.OnSuccess=os==1; ch.OnFailure=of==1; ch.OnCancel=oc==1; ch.AIMessage=aim==1
		json.Unmarshal([]byte(cfgStr), &ch.Config)
		chs = append(chs, ch)
	}
	return chs, nil
}

func (s *Store) DeleteNotificationChannel(id string) error {
	_, err := s.db.Exec(`DELETE FROM notification_channels WHERE id=?`, id)
	return err
}

func (s *Store) CreateNotificationLog(l *models.NotificationLog) error {
	_, err := s.db.Exec(`INSERT INTO notification_logs (id,channel_id,build_id,platform,status,payload,response,error,sent_at)
		VALUES (?,?,?,?,?,?,?,?,?)`,
		l.ID,l.ChannelID,l.BuildID,l.Platform,l.Status,l.Payload,l.Response,l.Error,l.SentAt)
	return err
}

func (s *Store) ListNotificationLogs(buildID string) ([]*models.NotificationLog, error) {
	rows, err := s.db.Query(`SELECT id,channel_id,build_id,platform,status,payload,response,error,sent_at
		FROM notification_logs WHERE build_id=? ORDER BY sent_at DESC`, buildID)
	if err != nil { return nil, err }
	defer rows.Close()
	var logs []*models.NotificationLog
	for rows.Next() {
		l := &models.NotificationLog{}
		rows.Scan(&l.ID,&l.ChannelID,&l.BuildID,&l.Platform,&l.Status,&l.Payload,&l.Response,&l.Error,&l.SentAt)
		logs = append(logs, l)
	}
	return logs, nil
}

// ─── AI Context Engine ────────────────────────────────────────────────────────

func (s *Store) AddContextEntry(e *models.ContextEntry) error {
	_, err := s.db.Exec(`INSERT INTO context_entries (id,project_id,type,ref_id,summary,detail,tags,created_at)
		VALUES (?,?,?,?,?,?,?,?)`,
		e.ID,e.ProjectID,e.Type,e.RefID,e.Summary,e.Detail,e.Tags,e.CreatedAt)
	return err
}

func (s *Store) GetProjectContext(projectID string, limit int) ([]*models.ContextEntry, error) {
	rows, err := s.db.Query(`SELECT id,project_id,type,ref_id,summary,detail,tags,created_at
		FROM context_entries WHERE project_id=? ORDER BY created_at DESC LIMIT ?`, projectID, limit)
	if err != nil { return nil, err }
	defer rows.Close()
	var entries []*models.ContextEntry
	for rows.Next() {
		e := &models.ContextEntry{}
		rows.Scan(&e.ID,&e.ProjectID,&e.Type,&e.RefID,&e.Summary,&e.Detail,&e.Tags,&e.CreatedAt)
		entries = append(entries, e)
	}
	return entries, nil
}

func (s *Store) SearchContext(projectID, query string, limit int) ([]*models.ContextEntry, error) {
	rows, err := s.db.Query(`SELECT id,project_id,type,ref_id,summary,detail,tags,created_at
		FROM context_entries WHERE project_id=? AND (summary LIKE ? OR tags LIKE ? OR detail LIKE ?)
		ORDER BY created_at DESC LIMIT ?`,
		projectID, "%"+query+"%", "%"+query+"%", "%"+query+"%", limit)
	if err != nil { return nil, err }
	defer rows.Close()
	var entries []*models.ContextEntry
	for rows.Next() {
		e := &models.ContextEntry{}
		rows.Scan(&e.ID,&e.ProjectID,&e.Type,&e.RefID,&e.Summary,&e.Detail,&e.Tags,&e.CreatedAt)
		entries = append(entries, e)
	}
	return entries, nil
}

// helper
func boolInt(b bool) int { if b { return 1 }; return 0 }

// ─── Retention / Cleanup ─────────────────────────────────────────────────────

// PruneBuilds removes old builds beyond the retention limit for a project.
// Keeps the most recent `keep` builds; deletes the rest along with their jobs, steps, logs.
func (s *Store) PruneBuilds(projectID string, keep int) (int64, error) {
	if keep <= 0 { return 0, nil }

	// Find the build number threshold
	var cutoff sql.NullInt64
	err := s.db.QueryRow(`SELECT number FROM builds WHERE project_id=? ORDER BY number DESC LIMIT 1 OFFSET ?`,
		projectID, keep).Scan(&cutoff)
	if err != nil {
		// Fewer builds than the limit — nothing to prune
		return 0, nil
	}

	tx, err := s.db.Begin()
	if err != nil { return 0, err }
	defer tx.Rollback()

	// Get build IDs to delete
	rows, _ := tx.Query(`SELECT id FROM builds WHERE project_id=? AND number<=?`, projectID, cutoff.Int64)
	var ids []string
	if rows != nil {
		for rows.Next() {
			var id string
			rows.Scan(&id)
			ids = append(ids, id)
		}
		rows.Close()
	}

	if len(ids) == 0 { return 0, nil }

	// Build a placeholder list
	for _, bid := range ids {
		tx.Exec(`DELETE FROM notification_logs WHERE build_id=?`, bid)
		tx.Exec(`DELETE FROM context_entries WHERE ref_id=? AND type='build'`, bid)
		tx.Exec(`DELETE FROM artifacts WHERE build_id=?`, bid)
		tx.Exec(`DELETE FROM steps WHERE job_id IN (SELECT id FROM jobs WHERE build_id=?)`, bid)
		tx.Exec(`DELETE FROM jobs WHERE build_id=?`, bid)
	}

	res, err := tx.Exec(`DELETE FROM builds WHERE project_id=? AND number<=?`, projectID, cutoff.Int64)
	if err != nil { return 0, err }

	if err := tx.Commit(); err != nil { return 0, err }
	deleted, _ := res.RowsAffected()
	return deleted, nil
}

// PruneVersions removes old versions beyond the retention limit for a project.
// Keeps the most recent `keep` versions; deletes the rest.
func (s *Store) PruneVersions(projectID string, keep int) (int64, error) {
	if keep <= 0 { return 0, nil }

	var cutoffTime time.Time
	err := s.db.QueryRow(`SELECT created_at FROM versions WHERE project_id=? ORDER BY created_at DESC LIMIT 1 OFFSET ?`,
		projectID, keep).Scan(&cutoffTime)
	if err != nil {
		return 0, nil // fewer versions than limit
	}

	tx, err := s.db.Begin()
	if err != nil { return 0, err }
	defer tx.Rollback()

	// Clean related context entries
	tx.Exec(`DELETE FROM context_entries WHERE project_id=? AND type='version' AND ref_id IN (SELECT id FROM versions WHERE project_id=? AND created_at<=?)`,
		projectID, projectID, cutoffTime)

	res, err := tx.Exec(`DELETE FROM versions WHERE project_id=? AND created_at<=?`, projectID, cutoffTime)
	if err != nil { return 0, err }

	if err := tx.Commit(); err != nil { return 0, err }
	deleted, _ := res.RowsAffected()
	return deleted, nil
}
