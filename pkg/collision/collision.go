package collision

import (
	"context"
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/WASIDJ/refbox/pkg/box"
)

// Result captures the collision outcome between a box's hypothesis and reality.
// It reflects C.S. Peirce's "Secondness" - the brute resistance of the world against our expectations.
type Result struct {
	Passed             bool                   `json:"passed"`
	Resistance         string                 `json:"resistance,omitempty"` // The exact error, failure, or friction encountered
	ViolatedConstraint string                 `json:"violated_constraint,omitempty"`
	Duration           time.Duration          `json:"duration"`
	Metrics            map[string]interface{} `json:"metrics,omitempty"`
}

// Verifier represents a reality collision surface (test runner, compiler, sandbox, or invariant checker).
type Verifier interface {
	Name() string
	Verify(ctx context.Context, b *box.Box) (*Result, error)
}

// CommandVerifier executes a shell command to physically collide the box with runtime reality.
type CommandVerifier struct {
	name       string
	command    string
	workingDir string
	timeout    time.Duration
}

// NewCommandVerifier creates a verifier that runs a shell command as external friction.
func NewCommandVerifier(name, command, workingDir string, timeout time.Duration) *CommandVerifier {
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	return &CommandVerifier{
		name:       name,
		command:    command,
		workingDir: workingDir,
		timeout:    timeout,
	}
}

func (c *CommandVerifier) Name() string {
	return c.name
}

func (c *CommandVerifier) Verify(ctx context.Context, b *box.Box) (*Result, error) {
	start := time.Now()
	ctx, cancel := context.WithTimeout(ctx, c.timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "sh", "-c", c.command)
	if c.workingDir != "" {
		cmd.Dir = c.workingDir
	}

	output, err := cmd.CombinedOutput()
	duration := time.Since(start)

	outStr := strings.TrimSpace(string(output))
	if err != nil {
		return &Result{
			Passed:     false,
			Resistance: fmt.Sprintf("Command failed (%v): %s", err, outStr),
			Duration:   duration,
		}, nil
	}

	return &Result{
		Passed:   true,
		Duration: duration,
	}, nil
}

// PredicateVerifier tests an in-memory boolean invariant function against the box.
type PredicateVerifier struct {
	name      string
	predicate func(b *box.Box) (bool, string)
}

// NewPredicateVerifier constructs an in-memory invariant checker.
func NewPredicateVerifier(name string, predicate func(b *box.Box) (bool, string)) *PredicateVerifier {
	return &PredicateVerifier{name: name, predicate: predicate}
}

func (p *PredicateVerifier) Name() string {
	return p.name
}

func (p *PredicateVerifier) Verify(ctx context.Context, b *box.Box) (*Result, error) {
	start := time.Now()
	passed, resistance := p.predicate(b)
	return &Result{
		Passed:     passed,
		Resistance: resistance,
		Duration:   time.Since(start),
	}, nil
}
