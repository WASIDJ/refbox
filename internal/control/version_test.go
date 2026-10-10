package control

import (
	"encoding/json"
	"net/http/httptest"
	"runtime/debug"
	"testing"
)

func TestRevisionFromBuildInfoWithVCS(t *testing.T) {
	info := &debug.BuildInfo{
		Settings: []debug.BuildSetting{
			{Key: "vcs.revision", Value: "abc123def456"},
			{Key: "vcs.time", Value: "2026-10-11T00:00:00Z"},
		},
	}
	if got := revisionFromBuildInfo(info); got != "abc123def456" {
		t.Fatalf("expected abc123def456, got %q", got)
	}
}

func TestRevisionFromBuildInfoWithoutVCS(t *testing.T) {
	info := &debug.BuildInfo{
		Settings: []debug.BuildSetting{
			{Key: "GOOS", Value: "darwin"},
			{Key: "GOARCH", Value: "arm64"},
		},
	}
	if got := revisionFromBuildInfo(info); got != "unknown" {
		t.Fatalf("expected unknown, got %q", got)
	}
}

func TestRevisionFromBuildInfoNil(t *testing.T) {
	if got := revisionFromBuildInfo(nil); got != "unknown" {
		t.Fatalf("expected unknown for nil BuildInfo, got %q", got)
	}
}

func TestBuildRevisionWithVCS(t *testing.T) {
	// The test binary itself is built by the Go toolchain, which embeds
	// VCS metadata when the source tree is a Git repository. If the test
	// environment happens to lack VCS info (e.g. copied source without .git),
	// skip rather than fail so the test remains valid everywhere.
	revision := buildRevision()
	if revision == "unknown" {
		t.Skip("test binary lacks VCS build metadata; skipping VCS-specific assertion")
	}
	if len(revision) < 7 {
		t.Fatalf("expected a plausible Git revision, got %q", revision)
	}
}

func TestHealthEndpointReturnsVersion(t *testing.T) {
	s, err := New(configForTest("http://127.0.0.1:18801"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })

	w := httptest.NewRecorder()
	s.ServeHTTP(w, httptest.NewRequest("GET", "/health", nil))
	if w.Code != 200 {
		t.Fatalf("health returned %d: %s", w.Code, w.Body.String())
	}
	var body map[string]any
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["ok"] != true {
		t.Fatal("health missing ok=true")
	}
	if body["service"] != "refbox-control" {
		t.Fatal("health missing service=refbox-control")
	}
	version, ok := body["version"].(string)
	if !ok {
		t.Fatal("health missing version string")
	}
	if version == "" {
		t.Fatal("version must not be empty")
	}
	// version should be either a Git revision or the explicit fallback
	if version != "unknown" && len(version) < 7 {
		t.Fatalf("version %q is neither a plausible Git revision nor \"unknown\"", version)
	}
}
