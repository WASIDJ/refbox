package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/WASIDJ/refbox/pkg/agent"
	"github.com/WASIDJ/refbox/pkg/box"
	"github.com/WASIDJ/refbox/pkg/collision"
	"github.com/WASIDJ/refbox/pkg/engine"
	"github.com/WASIDJ/refbox/pkg/observer"
)

const banner = `
  ██████╗ ███████╗███████╗██████╗  ██████╗ ██╗  ██╗
  ██╔══██╗██╔════╝██╔════╝██╔══██╗██╔═══██╗╚██╗██╔╝
  ██████╔╝█████╗  █████╗  ██████╔╝██║   ██║ ╚███╔╝ 
  ██╔══██╗██╔══╝  ██╔══╝  ██╔══██╗██║   ██║ ██╔██╗ 
  ██║  ██║███████╗██║     ██████╔╝╚██████╔╝██╔╝ ██╗
  ╚═╝  ╚═╝╚══════╝╚═╝     ╚═════╝  ╚═════╝ ╚═╝  ╚═╝
  Dynamic Box-Framing & Recursive Self-Improvement (RSI) Engine
`

func main() {
	if len(os.Args) < 2 {
		printUsage()
		return
	}

	cmd := os.Args[1]
	switch cmd {
	case "manifesto":
		printManifesto()
	case "demo":
		runDemo()
	case "run":
		runCustom(os.Args[2:])
	default:
		fmt.Printf("Unknown command: %s\n\n", cmd)
		printUsage()
		os.Exit(1)
	}
}

func printUsage() {
	fmt.Print(banner)
	fmt.Println("Usage:")
	fmt.Println("  refbox manifesto        Display the epistemological foundation & thesis")
	fmt.Println("  refbox demo             Run an end-to-end cognitive box fracture & reframing experiment")
	fmt.Println("  refbox run [flags]      Run a custom goal against a real shell verifier")
	fmt.Println()
}

func printManifesto() {
	fmt.Print(banner)
	fmt.Println(`=== The Epistemological Manifesto of RefBox ===

1. Spencer-Brown's Principle: "Draw a distinction."
   Problem solving begins not with searching for answers, but with drawing a boundary.
   A Box isolates an operational closure from the unbounded universe.

2. Maturana & Varela's Autopoiesis:
   A viable system is organizationally closed, but structurally coupled to environmental perturbations.
   The inside of a box solves within its own invariants.

3. C.S. Peirce's Secondness:
   Reality is not a passive mirror; it is brute resistance.
   When a box hypothesis collides with reality, the failure is not a bug—it is the indispensable friction of truth.

4. Von Foerster & Luhmann's Second-Order Observation:
   Do not merely retry when a box fractures. Observe the observer.
   Diagnose whether failure was an internal execution slip or a foundational boundary blind spot.

5. Metasystem Transition (Turchin & Weinberg):
   When a box fractures fundamentally, draw a higher-order box that internalizes the anomaly.
   When a box holds, crystallize it as an immutable, reusable black box.

This is the minimal loop of Generalized Recursive Self-Improvement (RSI).`)
}

func runDemo() {
	fmt.Print(banner)
	fmt.Println(">>> Starting Experiment: Simulating Human Box-Framing & Reframing Loop")
	fmt.Println()

	// Goal: Build a distributed atomic counter
	goal := "Build a distributed counter resilient to network partitions"

	// Step-by-step heuristic agent simulating cognitive evolution
	step := 0
	simulatedAgent := agent.NewHeuristicAgent(
		"CognitiveSimAgent",
		func(b *box.Box) (string, string, error) {
			step++
			if b.Level == 0 {
				return "Hypothesis 0: In-memory mutex on single node is sufficient",
					"type Counter struct { mu sync.Mutex; val int64 }", nil
			}
			if b.Level == 1 {
				return "Hypothesis 1: SQLite file lock across shared filesystem",
					"func Incr() { db.Exec('UPDATE counters SET v = v + 1') }", nil
			}
			return "Hypothesis 2: Distributed Raft consensus with lease-based state machine",
				"type RaftNode struct { leader string; peers []string; log []Entry }", nil
		},
		func(b *box.Box, diag *observer.Diagnosis) (*box.Box, error) {
			newLevel := b.Level + 1
			newID := fmt.Sprintf("box-L%d-distributed-consensus", newLevel)
			newBoundary := box.Boundary{
				Distinction: fmt.Sprintf("Metasystem Level %d: Internalizing partition reality [%s]", newLevel, diag.BlindSpot),
				InScope:     []string{"consensus_quorum", "lease_management", "partition_tolerance"},
				OutScope:    []string{"byzantine_faults"},
				Invariants:  []string{"linearizable_consistency", "zero_split_brain"},
				Assumptions: []string{"network_partitions_will_occur"},
			}
			newBox := box.NewBox(newID, b.Goal, newBoundary, b.ID, newLevel)
			newBox.Log(fmt.Sprintf("Metasystem transition triggered by blind spot: %s", diag.BlindSpot))
			return newBox, nil
		},
	)

	// Simulated Verifier that pushes back with physical reality
	verifier := collision.NewPredicateVerifier("PartitionChaosVerifier", func(b *box.Box) (bool, string) {
		if b.Level < 2 {
			return false, fmt.Sprintf("NETWORK_PARTITION_ERROR: Node isolated during network split. Local assumption violated: %s", strings.Join(b.Boundary.Assumptions, "; "))
		}
		return true, ""
	})

	eng := engine.NewEngine(simulatedAgent, verifier, observer.NewHeuristicObserver(), 5)
	eng.OnEvent = func(e engine.Event) {
		levelPrefix := strings.Repeat("  ", e.Level)
		fmt.Printf("%s[%s] Level %d | %s -> %s\n", levelPrefix, e.Timestamp.Format("15:04:05.000"), e.Level, e.Action, e.Detail)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	resultBox, err := eng.Solve(ctx, goal)
	if err != nil {
		fmt.Printf("\n[!] Experiment failed: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("\n>>> Experiment Succeeded!\n")
	fmt.Printf("Final Crystallized Box ID: %s (Level %d)\n", resultBox.ID, resultBox.Level)
	fmt.Printf("Final Boundary: %s\n", resultBox.Boundary.Distinction)
	fmt.Printf("Final Solution: %s\n", resultBox.Solution)
	fmt.Printf("Evolution History Length: %d entries\n", len(resultBox.History))
}

func runCustom(args []string) {
	fs := flag.NewFlagSet("run", flag.ExitOnError)
	goal := fs.String("goal", "Execute shell task within safe box", "The problem goal to solve")
	cmd := fs.String("verify-cmd", "true", "Shell command used as collision verifier")
	fs.Parse(args)

	fmt.Printf("Initializing RefBox with Goal: %s\n", *goal)
	fmt.Printf("Verifier Command: %s\n\n", *cmd)

	verifier := collision.NewCommandVerifier("ShellVerifier", *cmd, "", 10*time.Second)
	ag := agent.NewHeuristicAgent("DefaultAgent", nil, nil)
	eng := engine.NewEngine(ag, verifier, observer.NewHeuristicObserver(), 5)

	eng.OnEvent = func(e engine.Event) {
		fmt.Printf("[%s] L%d | %s: %s\n", e.Timestamp.Format("15:04:05"), e.Level, e.Action, e.Detail)
	}

	ctx := context.Background()
	res, err := eng.Solve(ctx, *goal)
	if err != nil {
		fmt.Printf("Execution failed: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("\nBox Crystallized: %s (State: %s)\n", res.ID, res.State)
}
