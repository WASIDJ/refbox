package box

import (
	"fmt"
	"strings"
)

// Boundary embodies George Spencer-Brown's foundational imperative: "Draw a distinction."
// It delineates the inside of the box from the unbounded exterior environment.
type Boundary struct {
	// Distinction is the core separation line (e.g. "Only handle single-node SQLite locks, ignore network partitions").
	Distinction string `json:"distinction"`

	// InScope lists the specific entities, files, or constraints managed inside this box.
	InScope []string `json:"in_scope"`

	// OutScope lists environmental complexities explicitly ignored or mocked in this iteration.
	OutScope []string `json:"out_scope"`

	// Invariants are the non-negotiable rules/contracts that must remain unbroken (e.g. "Data loss rate = 0").
	Invariants []string `json:"invariants"`

	// Assumptions are hypotheses assumed to be true during in-box solving (which might fracture upon collision).
	Assumptions []string `json:"assumptions"`
}

// Summary returns a human-readable outline of the distinction drawn.
func (b Boundary) Summary() string {
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Distinction: %s\n", b.Distinction))
	if len(b.Invariants) > 0 {
		sb.WriteString(fmt.Sprintf("Invariants: [%s]\n", strings.Join(b.Invariants, ", ")))
	}
	if len(b.Assumptions) > 0 {
		sb.WriteString(fmt.Sprintf("Assumptions: [%s]\n", strings.Join(b.Assumptions, ", ")))
	}
	return sb.String()
}
