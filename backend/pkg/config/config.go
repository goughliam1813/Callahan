package config

import (
	"os"
	"strconv"
	"sync"
)

// Config holds all runtime configuration.
// Access must go through the getter/setter methods to avoid data races (004).
type Config struct {
	mu sync.RWMutex // protects all fields below

	Port        string
	DBPath      string
	JWTSecret   string
	DataDir     string
	DockerHost  string

	// LLM defaults
	DefaultLLMProvider string
	DefaultLLMModel    string
	OpenAIKey          string
	AnthropicKey       string
	GoogleKey          string
	GroqKey            string
	OllamaURL          string

	// GitHub OAuth
	GitHubClientID     string
	GitHubClientSecret string

	// GitLab OAuth
	GitLabClientID     string
	GitLabClientSecret string

	// Feature flags
	TelemetryEnabled bool
	DevMode          bool

	// API token for simple authentication (001)
	// Set via CALLAHAN_API_TOKEN env var. Empty = auth disabled (dev convenience).
	APIToken string
}

func Load() *Config {
	return &Config{
		Port:               getEnv("PORT", "8080"),
		DBPath:             getEnv("DB_PATH", "./callahan.db"),
		JWTSecret:          getEnv("JWT_SECRET", "change-me-in-production-please"),
		DataDir:            getEnv("DATA_DIR", "./data"),
		DockerHost:         getEnv("DOCKER_HOST", "unix:///var/run/docker.sock"),
		DefaultLLMProvider: getEnv("LLM_PROVIDER", "anthropic"),
		DefaultLLMModel:    getEnv("LLM_MODEL", "claude-3-5-sonnet-20241022"),
		OpenAIKey:          getEnv("OPENAI_API_KEY", ""),
		AnthropicKey:       getEnv("ANTHROPIC_API_KEY", ""),
		GoogleKey:          getEnv("GOOGLE_API_KEY", ""),
		GroqKey:            getEnv("GROQ_API_KEY", ""),
		OllamaURL:          getEnv("OLLAMA_URL", "http://localhost:11434"),
		GitHubClientID:     getEnv("GITHUB_CLIENT_ID", ""),
		GitHubClientSecret: getEnv("GITHUB_CLIENT_SECRET", ""),
		GitLabClientID:     getEnv("GITLAB_CLIENT_ID", ""),
		GitLabClientSecret: getEnv("GITLAB_CLIENT_SECRET", ""),
		TelemetryEnabled:   getBoolEnv("TELEMETRY_ENABLED", false),
		DevMode:            getBoolEnv("DEV_MODE", false),
		APIToken:           getEnv("CALLAHAN_API_TOKEN", ""),
	}
}

// ─── Thread-safe getters/setters for mutable fields (004) ────────────────────

func (c *Config) GetDefaultLLMProvider() string { c.mu.RLock(); defer c.mu.RUnlock(); return c.DefaultLLMProvider }
func (c *Config) GetDefaultLLMModel() string    { c.mu.RLock(); defer c.mu.RUnlock(); return c.DefaultLLMModel }
func (c *Config) GetAnthropicKey() string       { c.mu.RLock(); defer c.mu.RUnlock(); return c.AnthropicKey }
func (c *Config) GetOpenAIKey() string          { c.mu.RLock(); defer c.mu.RUnlock(); return c.OpenAIKey }
func (c *Config) GetGroqKey() string            { c.mu.RLock(); defer c.mu.RUnlock(); return c.GroqKey }
func (c *Config) GetGoogleKey() string          { c.mu.RLock(); defer c.mu.RUnlock(); return c.GoogleKey }
func (c *Config) GetOllamaURL() string          { c.mu.RLock(); defer c.mu.RUnlock(); return c.OllamaURL }
func (c *Config) GetAPIToken() string           { c.mu.RLock(); defer c.mu.RUnlock(); return c.APIToken }

func (c *Config) SetLLMProvider(v string) { c.mu.Lock(); defer c.mu.Unlock(); c.DefaultLLMProvider = v }
func (c *Config) SetLLMModel(v string)    { c.mu.Lock(); defer c.mu.Unlock(); c.DefaultLLMModel = v }
func (c *Config) SetAnthropicKey(v string){ c.mu.Lock(); defer c.mu.Unlock(); c.AnthropicKey = v }
func (c *Config) SetOpenAIKey(v string)   { c.mu.Lock(); defer c.mu.Unlock(); c.OpenAIKey = v }
func (c *Config) SetGroqKey(v string)     { c.mu.Lock(); defer c.mu.Unlock(); c.GroqKey = v }
func (c *Config) SetGoogleKey(v string)   { c.mu.Lock(); defer c.mu.Unlock(); c.GoogleKey = v }
func (c *Config) SetOllamaURL(v string)   { c.mu.Lock(); defer c.mu.Unlock(); c.OllamaURL = v }

func getEnv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func getBoolEnv(key string, fallback bool) bool {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	b, err := strconv.ParseBool(v)
	if err != nil {
		return fallback
	}
	return b
}
