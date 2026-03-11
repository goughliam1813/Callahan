package config

import (
	"os"
	"strconv"
)

type Config struct {
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
	}
}

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
