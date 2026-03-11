package storage

import (
	"database/sql"
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

CREATE INDEX IF NOT EXISTS idx_builds_project ON builds(project_id);
CREATE INDEX IF NOT EXISTS idx_builds_status ON builds(status);
CREATE INDEX IF NOT EXISTS idx_jobs_build ON jobs(build_id);
CREATE INDEX IF NOT EXISTS idx_steps_job ON steps(job_id);
`
	_, err := s.db.Exec(schema)
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
	_, err := s.db.Exec(`DELETE FROM projects WHERE id=?`, id)
	return err
}

// Builds
func (s *Store) CreateBuild(b *models.Build) error {
	_, err := s.db.Exec(`
		INSERT INTO builds (id,project_id,number,status,branch,commit_sha,commit_message,author,duration_ms,started_at,finished_at,created_at,trigger,ai_insight)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		b.ID, b.ProjectID, b.Number, b.Status, b.Branch, b.Commit, b.CommitMsg,
		b.Author, b.Duration, b.StartedAt, b.FinishedAt, b.CreatedAt, b.Trigger, b.AIInsight)
	return err
}

func (s *Store) GetBuild(id string) (*models.Build, error) {
	b := &models.Build{}
	err := s.db.QueryRow(`SELECT id,project_id,number,status,branch,commit_sha,commit_message,author,duration_ms,started_at,finished_at,created_at,trigger,ai_insight FROM builds WHERE id=?`, id).
		Scan(&b.ID, &b.ProjectID, &b.Number, &b.Status, &b.Branch, &b.Commit, &b.CommitMsg, &b.Author, &b.Duration, &b.StartedAt, &b.FinishedAt, &b.CreatedAt, &b.Trigger, &b.AIInsight)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return b, err
}

func (s *Store) ListBuilds(projectID string, limit int) ([]*models.Build, error) {
	rows, err := s.db.Query(`SELECT id,project_id,number,status,branch,commit_sha,commit_message,author,duration_ms,started_at,finished_at,created_at,trigger,ai_insight FROM builds WHERE project_id=? ORDER BY number DESC LIMIT ?`, projectID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var builds []*models.Build
	for rows.Next() {
		b := &models.Build{}
		if err := rows.Scan(&b.ID, &b.ProjectID, &b.Number, &b.Status, &b.Branch, &b.Commit, &b.CommitMsg, &b.Author, &b.Duration, &b.StartedAt, &b.FinishedAt, &b.CreatedAt, &b.Trigger, &b.AIInsight); err != nil {
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
	_, err := s.db.Exec(`INSERT INTO steps (id,job_id,name,status,command) VALUES (?,?,?,?,?)`,
		step.ID, step.JobID, step.Name, step.Status, step.Command)
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

func (s *Store) GetSecret(projectID, name string) (*models.Secret, error) {
	sec := &models.Secret{}
	err := s.db.QueryRow(`SELECT id,project_id,name,value,created_at FROM secrets WHERE project_id=? AND name=?`, projectID, name).
		Scan(&sec.ID, &sec.ProjectID, &sec.Name, &sec.Value, &sec.CreatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	return sec, err
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
