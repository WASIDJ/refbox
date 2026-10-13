package engine

import (
	"context"
	"fmt"
	"time"

	"github.com/WASIDJ/refbox/pkg/agent"
	"github.com/WASIDJ/refbox/pkg/box"
	"github.com/WASIDJ/refbox/pkg/collision"
	"github.com/WASIDJ/refbox/pkg/observer"
)

// Event represents an observable transition in the recursive cognitive loop.
type Event struct {
	Timestamp time.Time  `json:"timestamp"`
	BoxID     string     `json:"box_id"`
	Level     int        `json:"level"`
	Action    string     `json:"action"`
	Detail    string     `json:"detail"`
}

// Engine coordinates the recursive box-building and collision loop.
type Engine struct {
	Agent             agent.Agent
	Verifier          collision.Verifier
	Observer          observer.SecondOrderObserver
	MaxRecursionDepth int
	OnEvent           func(e Event)
}

// NewEngine creates an operational instance of the Box-Building RSI Engine.
func NewEngine(
	ag agent.Agent,
	ver collision.Verifier,
	obs observer.SecondOrderObserver,
	maxDepth int,
) *Engine {
	if obs == nil {
		obs = observer.NewHeuristicObserver()
	}
	if maxDepth <= 0 {
		maxDepth = 5
	}
	return &Engine{
		Agent:             ag,
		Verifier:          ver,
		Observer:          obs,
		MaxRecursionDepth: maxDepth,
		OnEvent:           func(e Event) {},
	}
}

// emit records and broadcasts an engine milestone.
func (e *Engine) emit(boxID string, level int, action, detail string) {
	evt := Event{
		Timestamp: time.Now(),
		BoxID:     boxID,
		Level:     level,
		Action:    action,
		Detail:    detail,
	}
	if e.OnEvent != nil {
		e.OnEvent(evt)
	}
}

// Solve executes the dynamic box-building loop until crystallization or depth exhaustion.
func (e *Engine) Solve(ctx context.Context, goal string) (*box.Box, error) {
	currentBox, err := e.Agent.FrameInitialBox(goal)
	if err != nil {
		return nil, fmt.Errorf("failed to frame initial box: %w", err)
	}

	e.emit(currentBox.ID, currentBox.Level, "BOX_FRAMED", currentBox.Boundary.Distinction)

	depth := 0
	for depth < e.MaxRecursionDepth {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		default:
		}

		// Phase 1: In-box solving within operational closure
		currentBox.Transition(box.StateSolving, "Formulating hypothesis within current boundary")
		e.emit(currentBox.ID, currentBox.Level, "SOLVING_IN_BOX", fmt.Sprintf("Attempt %d/%d", currentBox.Attempts+1, currentBox.MaxAttempts))

		hyp, sol, err := e.Agent.SolveInBox(currentBox)
		if err != nil {
			return nil, fmt.Errorf("agent failed to solve inside box %s: %w", currentBox.ID, err)
		}
		currentBox.Hypothesis = hyp
		currentBox.Solution = sol

		// Phase 2: Physical reality collision (Peirce's Secondness)
		currentBox.Transition(box.StateColliding, "Subjecting hypothesis to verifier friction")
		e.emit(currentBox.ID, currentBox.Level, "COLLIDING", fmt.Sprintf("Friction against verifier: %s", e.Verifier.Name()))

		result, err := e.Verifier.Verify(ctx, currentBox)
		if err != nil {
			return nil, fmt.Errorf("verifier execution error: %w", err)
		}

		// Phase 3: Evaluate collision
		if result.Passed {
			// Success: The box held! Crystallize into an immutable black box.
			currentBox.Transition(box.StateCrystallized, "Verification passed. Box crystallized as an invariant asset.")
			e.emit(currentBox.ID, currentBox.Level, "CRYSTALLIZED", "Box boundary held against reality; solution verified.")
			return currentBox, nil
		}

		// Failure: The box fractured against reality
		currentBox.Attempts++
		diag := e.Observer.Diagnose(currentBox, result)
		currentBox.Transition(box.StateFractured, fmt.Sprintf("Resistance: %s | Diag: %s", result.Resistance, diag.Type))
		e.emit(currentBox.ID, currentBox.Level, "FRACTURED", fmt.Sprintf("[%s] %s", diag.Type, diag.BlindSpot))

		// Phase 4: Second-order decision - Retry in-box vs Metasystem Reframing
		if diag.Type == observer.DiagnosisTacticalSlip && currentBox.Attempts < currentBox.MaxAttempts {
			// Boundary is sound, revise implementation inside current box
			currentBox.Log(fmt.Sprintf("Tactical revision permitted: %s", diag.BlindSpot))
			continue
		}

		// Boundary fractured: Metasystem Transition (Draw a higher-order box)
		depth++
		if depth >= e.MaxRecursionDepth {
			return nil, fmt.Errorf("max recursion depth (%d) reached without crystallization. Last fracture: %s", e.MaxRecursionDepth, diag.BlindSpot)
		}

		e.emit(currentBox.ID, currentBox.Level, "METASYSTEM_TRANSITION", fmt.Sprintf("Escalating to Level %d: %s", currentBox.Level+1, diag.BlindSpot))
		newBox, err := e.Agent.Reframe(currentBox, diag)
		if err != nil {
			return nil, fmt.Errorf("failed to reframe fractured box: %w", err)
		}

		currentBox = newBox
		e.emit(currentBox.ID, currentBox.Level, "NEW_BOX_SPAWNED", currentBox.Boundary.Distinction)
	}

	return nil, fmt.Errorf("exceeded max recursion depth of %d", e.MaxRecursionDepth)
}
