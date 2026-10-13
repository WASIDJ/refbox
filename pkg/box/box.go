package box

import (
	"fmt"
	"time"
)

// State represents the lifecycle of a Box within the cognitive loop.
type State string

const (
	// StateForming represents drawing the boundary and formulating specs.
	StateForming State = "FORMING"

	// StateSolving represents exploring a viable hypothesis inside operational closure.
	StateSolving State = "SOLVING"

	// StateColliding represents testing the hypothesis against external resistance (Peirce's Secondness).
	StateColliding State = "COLLIDING"

	// StateFractured indicates that reality broke the box's assumptions, prompting reflection or reframing.
	StateFractured State = "FRACTURED"

	// StateCrystallized means the box held against resistance and is now frozen as an immutable, reusable black box.
	StateCrystallized State = "CRYSTALLIZED"
)

// Box represents a cognitive unit of bounded rationality, encapsulating an isolated problem-solving space.
type Box struct {
	ID          string                 `json:"id"`
	ParentID    string                 `json:"parent_id,omitempty"`
	Level       int                    `json:"level"` // 0 = base box, 1 = meta-box, etc.
	Goal        string                 `json:"goal"`
	Boundary    Boundary               `json:"boundary"`
	Hypothesis  string                 `json:"hypothesis,omitempty"`
	Solution    string                 `json:"solution,omitempty"`
	State       State                  `json:"state"`
	Attempts    int                    `json:"attempts"`
	MaxAttempts int                    `json:"max_attempts"`
	History     []string               `json:"history,omitempty"`
	Metadata    map[string]interface{} `json:"metadata,omitempty"`
	CreatedAt   time.Time              `json:"created_at"`
	UpdatedAt   time.Time              `json:"updated_at"`
}

// NewBox creates a newly formed Box with the specified boundary and goal.
func NewBox(id string, goal string, boundary Boundary, parentID string, level int) *Box {
	now := time.Now()
	return &Box{
		ID:          id,
		ParentID:    parentID,
		Level:       level,
		Goal:        goal,
		Boundary:    boundary,
		State:       StateForming,
		Attempts:    0,
		MaxAttempts: 3,
		History:     []string{fmt.Sprintf("[%s] Box formed: %s", now.Format(time.RFC3339), boundary.Distinction)},
		Metadata:    make(map[string]interface{}),
		CreatedAt:   now,
		UpdatedAt:   now,
	}
}

// Log records a state change or observation in the Box history.
func (b *Box) Log(message string) {
	entry := fmt.Sprintf("[%s] %s", time.Now().Format("15:04:05"), message)
	b.History = append(b.History, entry)
	b.UpdatedAt = time.Now()
}

// Transition changes the Box state and records it in history.
func (b *Box) Transition(newState State, reason string) {
	prev := b.State
	b.State = newState
	b.Log(fmt.Sprintf("State transition: %s -> %s (Reason: %s)", prev, newState, reason))
}
