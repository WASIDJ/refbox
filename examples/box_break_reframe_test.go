package examples

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/WASIDJ/refbox/pkg/agent"
	"github.com/WASIDJ/refbox/pkg/box"
	"github.com/WASIDJ/refbox/pkg/collision"
	"github.com/WASIDJ/refbox/pkg/engine"
	"github.com/WASIDJ/refbox/pkg/observer"
)

func TestBoxFractureAndReframingLoop(t *testing.T) {
	// Experiment: The Agent starts with a naive, narrow assumption,
	// faces collision resistance, and must perform a Metasystem Transition
	// to reframe into a viable, crystallized higher-order box.

	goal := "Ensure idempotent file write without concurrency race conditions"

	mockAgent := agent.NewHeuristicAgent(
		"TestCognitiveAgent",
		func(b *box.Box) (string, string, error) {
			if b.Level == 0 {
				return "Naive direct write without lock", "os.WriteFile('test.dat', data, 0644)", nil
			}
			return "Idempotent temporary file atomic rename with lockfile",
				"ioutil.TempFile + os.Rename", nil
		},
		func(b *box.Box, diag *observer.Diagnosis) (*box.Box, error) {
			newBoundary := box.Boundary{
				Distinction: "Atomic temp-file write with filesystem barrier",
				InScope:     []string{"atomic_rename", "fsync"},
				OutScope:    []string{"distributed_filesystem"},
				Invariants:  []string{"no_partial_reads"},
				Assumptions: []string{"filesystem_supports_atomic_rename"},
			}
			return box.NewBox("box-L1-atomic-rename", b.Goal, newBoundary, b.ID, 1), nil
		},
	)

	// Verifier: Rejects Level 0 due to non-atomic race conditions
	verifier := collision.NewPredicateVerifier("ConcurrencyFriction", func(b *box.Box) (bool, string) {
		if b.Level == 0 {
			return false, "RACE_CONDITION: Concurrent reader detected half-written file. Assumption failed: direct_write_is_safe"
		}
		return true, ""
	})

	eng := engine.NewEngine(mockAgent, verifier, observer.NewHeuristicObserver(), 3)

	var events []engine.Event
	eng.OnEvent = func(e engine.Event) {
		events = append(events, e)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	result, err := eng.Solve(ctx, goal)
	if err != nil {
		t.Fatalf("Engine failed to solve: %v", err)
	}

	if result.State != box.StateCrystallized {
		t.Errorf("Expected state to be CRYSTALLIZED, got %s", result.State)
	}

	if result.Level != 1 {
		t.Errorf("Expected solution at Level 1, got Level %d", result.Level)
	}

	if !strings.Contains(result.Solution, "os.Rename") {
		t.Errorf("Expected atomic solution, got: %s", result.Solution)
	}

	// Verify events captured the Metasystem Transition
	hasFracture := false
	hasTransition := false
	for _, ev := range events {
		if ev.Action == "FRACTURED" {
			hasFracture = true
		}
		if ev.Action == "METASYSTEM_TRANSITION" {
			hasTransition = true
		}
	}

	if !hasFracture || !hasTransition {
		t.Errorf("Expected FRACTURED and METASYSTEM_TRANSITION events, got %+v", events)
	}
}
