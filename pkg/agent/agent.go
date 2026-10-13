package agent

import (
	"fmt"
	"time"

	"github.com/WASIDJ/refbox/pkg/box"
	"github.com/WASIDJ/refbox/pkg/observer"
)

// Agent represents the problem solver that draws boundaries, formulates solutions, and reframes broken boxes.
type Agent interface {
	Name() string
	FrameInitialBox(goal string) (*box.Box, error)
	SolveInBox(b *box.Box) (hypothesis string, solution string, err error)
	Reframe(b *box.Box, diag *observer.Diagnosis) (*box.Box, error)
}

// HeuristicAgent provides a deterministic cognitive agent for experiments and benchmarks.
type HeuristicAgent struct {
	name             string
	solverFunc       func(b *box.Box) (string, string, error)
	reframerFunc     func(b *box.Box, diag *observer.Diagnosis) (*box.Box, error)
}

// NewHeuristicAgent constructs a customizable heuristic agent.
func NewHeuristicAgent(
	name string,
	solver func(b *box.Box) (string, string, error),
	reframer func(b *box.Box, diag *observer.Diagnosis) (*box.Box, error),
) *HeuristicAgent {
	return &HeuristicAgent{
		name:         name,
		solverFunc:   solver,
		reframerFunc: reframer,
	}
}

func (h *HeuristicAgent) Name() string {
	return h.name
}

func (h *HeuristicAgent) FrameInitialBox(goal string) (*box.Box, error) {
	id := fmt.Sprintf("box-%d", time.Now().UnixNano()%100000)
	boundary := box.Boundary{
		Distinction: fmt.Sprintf("Initial bounded hypothesis for: %s", goal),
		InScope:     []string{"core_logic"},
		OutScope:    []string{"edge_cases", "system_reconfiguration"},
		Invariants:  []string{"no_data_loss"},
		Assumptions: []string{"environment_is_static"},
	}
	return box.NewBox(id, goal, boundary, "", 0), nil
}

func (h *HeuristicAgent) SolveInBox(b *box.Box) (string, string, error) {
	if h.solverFunc != nil {
		return h.solverFunc(b)
	}
	return "Hypothesis: Direct linear execution within current boundary", "print('Executed in boundary')", nil
}

func (h *HeuristicAgent) Reframe(b *box.Box, diag *observer.Diagnosis) (*box.Box, error) {
	if h.reframerFunc != nil {
		return h.reframerFunc(b, diag)
	}

	// Default Metasystem Transition: Elevate box level and enlarge boundary to internalize the blind spot
	newID := fmt.Sprintf("%s-meta-L%d", b.ID, b.Level+1)
	newBoundary := box.Boundary{
		Distinction: fmt.Sprintf("Higher-order reframing incorporating blind spot: %s", diag.BlindSpot),
		InScope:     append(b.Boundary.InScope, "metasystem_remediation"),
		OutScope:    b.Boundary.OutScope,
		Invariants:  b.Boundary.Invariants,
		Assumptions: []string{fmt.Sprintf("Adapted around: %s", diag.BlindSpot)},
	}

	newBox := box.NewBox(newID, b.Goal, newBoundary, b.ID, b.Level+1)
	newBox.Log(fmt.Sprintf("Spawned from fractured parent [%s] due to: %s", b.ID, diag.BlindSpot))
	return newBox, nil
}
