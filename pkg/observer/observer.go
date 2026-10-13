package observer

import (
	"fmt"
	"strings"

	"github.com/WASIDJ/refbox/pkg/box"
	"github.com/WASIDJ/refbox/pkg/collision"
)

// DiagnosisType indicates the nature of failure diagnosed by second-order observation.
type DiagnosisType string

const (
	// DiagnosisTacticalSlip means the boundary was sound, but the internal hypothesis had an execution flaw.
	DiagnosisTacticalSlip DiagnosisType = "TACTICAL_SLIP"

	// DiagnosisBoundaryFracture means the distinction or core assumptions of the box were invalidated by reality.
	DiagnosisBoundaryFracture DiagnosisType = "BOUNDARY_FRACTURE"

	// DiagnosisIrresolvable means the problem cannot be resolved within current resource constraints.
	DiagnosisIrresolvable DiagnosisType = "IRRESOLVABLE"
)

// Diagnosis represents a second-order observation of an observer's failed hypothesis.
// It exposes the blind spot of the first-order problem solver.
type Diagnosis struct {
	Type          DiagnosisType `json:"type"`
	BlindSpot     string        `json:"blind_spot"`
	SuggestedSpec string        `json:"suggested_spec,omitempty"`
	Analysis      string        `json:"analysis"`
}

// SecondOrderObserver inspects a fractured box and its collision resistance to expose its blind spots.
type SecondOrderObserver interface {
	Diagnose(b *box.Box, res *collision.Result) *Diagnosis
}

// HeuristicObserver provides rule-based second-order observation.
type HeuristicObserver struct{}

// NewHeuristicObserver constructs a default heuristic observer.
func NewHeuristicObserver() *HeuristicObserver {
	return &HeuristicObserver{}
}

// Diagnose evaluates whether the collision warrants an in-box retry or a metasystem reframing.
func (o *HeuristicObserver) Diagnose(b *box.Box, res *collision.Result) *Diagnosis {
	if b.Attempts >= b.MaxAttempts {
		return &Diagnosis{
			Type:      DiagnosisBoundaryFracture,
			BlindSpot: fmt.Sprintf("Exceeded max attempts (%d) within boundary: '%s'. Assumption space exhausted.", b.MaxAttempts, b.Boundary.Distinction),
			Analysis:  "Repeated collisions indicate that the box's operational closure is insufficient for the environmental variety.",
		}
	}

	lowerRes := strings.ToLower(res.Resistance)

	// Check if any explicit assumption was directly repudiated by the resistance
	for _, assumption := range b.Boundary.Assumptions {
		if strings.Contains(lowerRes, strings.ToLower(assumption)) ||
			strings.Contains(lowerRes, "unsupported") ||
			strings.Contains(lowerRes, "permission denied") ||
			strings.Contains(lowerRes, "deadlock") ||
			strings.Contains(lowerRes, "partition") {
			return &Diagnosis{
				Type:          DiagnosisBoundaryFracture,
				BlindSpot:     fmt.Sprintf("Assumption '%s' directly collided with reality constraint: %s", assumption, res.Resistance),
				SuggestedSpec: fmt.Sprintf("Broaden scope or re-architect boundary to internalize: %s", res.Resistance),
				Analysis:      "The distinction drawn by this box excluded a critical environmental variable.",
			}
		}
	}

	return &Diagnosis{
		Type:      DiagnosisTacticalSlip,
		BlindSpot: "Implementation detail failed verification, but boundary assumptions appear intact.",
		Analysis:  "Permit in-box revision within the current distinction.",
	}
}
