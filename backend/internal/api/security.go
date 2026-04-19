package api

// security.go — fixes 001 (no auth), 003 (secrets plaintext), 009 (SSRF)

import (
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"net"
	"net/url"
	"strings"

	"github.com/gin-gonic/gin"
)

// ─── 001: API Token Authentication ───────────────────────────────────────────
//
// Set CALLAHAN_API_TOKEN in the environment to enable auth.
// If the env var is empty, auth is skipped (developer convenience for localhost).
//
// Usage:  Authorization: Bearer <token>
//      or X-Callahan-Token: <token>

func AuthMiddleware(token string) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Auth disabled when no token configured
		if token == "" {
			c.Next()
			return
		}
		// Skip auth for health check and WebSocket (WS does its own handling)
		path := c.Request.URL.Path
		if path == "/health" || path == "/ws" {
			c.Next()
			return
		}

		got := ""
		if auth := c.GetHeader("Authorization"); strings.HasPrefix(auth, "Bearer ") {
			got = strings.TrimPrefix(auth, "Bearer ")
		} else if t := c.GetHeader("X-Callahan-Token"); t != "" {
			got = t
		}

		if got == "" || got != token {
			c.AbortWithStatusJSON(401, gin.H{"error": "Unauthorized — set Authorization: Bearer <CALLAHAN_API_TOKEN>"})
			return
		}
		c.Next()
	}
}

// ─── 003: Secret obfuscation ──────────────────────────────────────────────────
//
// This is lightweight XOR obfuscation so secrets are not stored as raw plaintext
// in the SQLite file. It prevents casual `strings callahan.db` leakage.
//
// NOTE: For production multi-user deployments, replace with AES-GCM using a
// key derived from the JWT_SECRET, or integrate with OS keychain / Vault.
// This is explicitly documented as a stepping-stone, not full encryption.

const obfuscationVersion = "v1:"

// ObfuscateSecret XOR-encodes a secret value with a randomly-seeded key.
// The encoded key is prepended so ObfuscateSecret output is self-contained.
func ObfuscateSecret(plaintext string) (string, error) {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return "", fmt.Errorf("generate obfuscation key: %w", err)
	}
	src := []byte(plaintext)
	dst := make([]byte, len(src))
	for i, b := range src {
		dst[i] = b ^ key[i%len(key)]
	}
	// Format: "v1:<base64(key)>:<base64(ciphertext)>"
	return obfuscationVersion +
		base64.StdEncoding.EncodeToString(key) + ":" +
		base64.StdEncoding.EncodeToString(dst), nil
}

// DeobfuscateSecret reverses ObfuscateSecret.
// If the value is not obfuscated (legacy plaintext), it is returned as-is.
func DeobfuscateSecret(stored string) (string, error) {
	if !strings.HasPrefix(stored, obfuscationVersion) {
		// Legacy plaintext — return unchanged so old data keeps working
		return stored, nil
	}
	rest := strings.TrimPrefix(stored, obfuscationVersion)
	parts := strings.SplitN(rest, ":", 2)
	if len(parts) != 2 {
		return "", fmt.Errorf("malformed obfuscated secret")
	}
	key, err := base64.StdEncoding.DecodeString(parts[0])
	if err != nil {
		return "", fmt.Errorf("decode obfuscation key: %w", err)
	}
	ciphertext, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil {
		return "", fmt.Errorf("decode ciphertext: %w", err)
	}
	plaintext := make([]byte, len(ciphertext))
	for i, b := range ciphertext {
		plaintext[i] = b ^ key[i%len(key)]
	}
	return string(plaintext), nil
}

// ─── 009: SSRF protection ─────────────────────────────────────────────────────
//
// ValidateRepoURL rejects URLs that point at internal/private network addresses
// to prevent server-side request forgery via the repo_url field.

var privateRanges = []string{
	"10.", "172.16.", "172.17.", "172.18.", "172.19.", "172.20.", "172.21.",
	"172.22.", "172.23.", "172.24.", "172.25.", "172.26.", "172.27.", "172.28.",
	"172.29.", "172.30.", "172.31.",
	"192.168.", "127.", "169.254.", "::1", "fc", "fd",
}

var allowedRepoSchemes = map[string]bool{
	"https": true,
	"http":  true, // kept for internal/corporate git servers
	"ssh":   true,
}

// ValidateRepoURL returns an error if the URL is unsafe for git clone.
func ValidateRepoURL(rawURL string) error {
	if rawURL == "" {
		return fmt.Errorf("repo URL is required")
	}

	// Normalise ssh://git@github.com/… and git@github.com:… forms
	normalized := rawURL
	if strings.HasPrefix(rawURL, "git@") {
		// Convert git@github.com:owner/repo → https://github.com/owner/repo for parsing
		normalized = "https://" + strings.Replace(strings.TrimPrefix(rawURL, "git@"), ":", "/", 1)
	}

	u, err := url.Parse(normalized)
	if err != nil {
		return fmt.Errorf("invalid URL: %w", err)
	}

	scheme := strings.ToLower(u.Scheme)
	if !allowedRepoSchemes[scheme] {
		return fmt.Errorf("disallowed URL scheme %q — use https, http, or ssh", u.Scheme)
	}

	host := u.Hostname()
	if host == "" {
		return fmt.Errorf("URL has no host")
	}

	// Block IP literals outright (resolve-then-block for hostnames happens below)
	ip := net.ParseIP(host)
	if ip != nil && isPrivateIP(ip) {
		return fmt.Errorf("URL points to a private/internal IP address")
	}

	// Resolve hostname and check resolved IPs
	addrs, err := net.LookupHost(host)
	if err != nil {
		// Can't resolve — allow (offline/air-gapped environments still need to work)
		return nil
	}
	for _, addr := range addrs {
		if resolved := net.ParseIP(addr); resolved != nil && isPrivateIP(resolved) {
			return fmt.Errorf("repo URL %q resolves to a private/internal address — blocked to prevent SSRF", host)
		}
	}
	return nil
}

// ValidateWebhookURL is the same check applied to notification webhook URLs.
func ValidateWebhookURL(rawURL string) error {
	if rawURL == "" {
		return nil // webhooks are optional
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return fmt.Errorf("invalid webhook URL: %w", err)
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "https" && scheme != "http" {
		return fmt.Errorf("webhook URL must use https or http")
	}
	host := u.Hostname()
	if ip := net.ParseIP(host); ip != nil && isPrivateIP(ip) {
		return fmt.Errorf("webhook URL points to a private/internal address")
	}
	addrs, err := net.LookupHost(host)
	if err != nil {
		return nil // unresolvable — allow
	}
	for _, addr := range addrs {
		if resolved := net.ParseIP(addr); resolved != nil && isPrivateIP(resolved) {
			return fmt.Errorf("webhook URL %q resolves to a private address — blocked", host)
		}
	}
	return nil
}

func isPrivateIP(ip net.IP) bool {
	// Loopback
	if ip.IsLoopback() {
		return true
	}
	// Link-local
	if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() {
		return true
	}
	ipStr := ip.String()
	for _, prefix := range privateRanges {
		if strings.HasPrefix(ipStr, prefix) {
			return true
		}
	}
	return false
}

// ─── 002: Command injection — validate pipeline step commands ─────────────────
//
// Steps are run via sh -c, so we can't prevent arbitrary shell entirely
// (that's the design — pipelines *are* shell commands). What we do here is:
//  1. Reject obviously dangerous patterns injected via the API at pipeline-save time.
//  2. The real guard is that only authenticated users can create pipelines (001).

var blockedCommandPatterns = []string{
	// Prevent obvious exfiltration of secrets via env-dump to external hosts
	"printenv | curl", "env | curl", "printenv | wget", "env | wget",
	// Prevent reading the DB directly
	"callahan.db",
	// Network requests to metadata services
	"169.254.169.254",
	"metadata.google.internal",
}

// ValidateStepCommand returns an error if the command contains obviously
// dangerous patterns. This is a defence-in-depth measure — authentication (001)
// is the primary guard.
func ValidateStepCommand(cmd string) error {
	lower := strings.ToLower(cmd)
	for _, pattern := range blockedCommandPatterns {
		if strings.Contains(lower, strings.ToLower(pattern)) {
			return fmt.Errorf("step command contains blocked pattern %q", pattern)
		}
	}
	return nil
}
