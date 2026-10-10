package broker

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

type Target struct {
	Domain string `json:"domain"`
	Label  string `json:"label"`
}

type Request struct {
	ServiceID string `json:"serviceId"`
	ActionID  string `json:"actionId"`
}

type Receipt struct {
	ActionID  string `json:"actionId"`
	ServiceID string `json:"serviceId"`
	Target    Target `json:"target"`
	Status    string `json:"status"`
	StartedAt string `json:"startedAt"`
	EndedAt   string `json:"endedAt,omitempty"`
	Output    string `json:"output,omitempty"`
}

type RestartFunc func(context.Context, Target) (string, error)

type Config struct {
	Token    string
	Services map[string]Target
	Restart  RestartFunc
}

type Store struct{ db *sql.DB }
type Server struct {
	store    *Store
	token    string
	services map[string]Target
	restart  RestartFunc
}

var (
	idPattern     = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)
	actionPattern = regexp.MustCompile(`^[a-zA-Z0-9:_-]{1,128}$`)
	domainPattern = regexp.MustCompile(`^(system|user/[0-9]+|gui/[0-9]+)$`)
	labelPattern  = regexp.MustCompile(`^ai\.refbox\.[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$`)
)

// The control service is excluded: replacing/restarting the live platform is a human decision.
func DefaultServices() map[string]Target {
	return map[string]Target{
		"engine":   {Domain: "system", Label: "ai.refbox.engine"},
		"tunnel":   {Domain: "system", Label: "ai.refbox.tunnel"},
		"monitor":  {Domain: "system", Label: "ai.refbox.monitor"},
		"verifier": {Domain: "system", Label: "ai.refbox.verifier"},
	}
}

// Explicit administrator configuration replaces the default map; callers cannot amend it.
func ServicesFromJSON(value string) (map[string]Target, error) {
	if value == "" {
		return DefaultServices(), nil
	}
	var services map[string]Target
	decoder := json.NewDecoder(strings.NewReader(value))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&services); err != nil || services == nil {
		return nil, errors.New("invalid REFBOX_BROKER_SERVICES JSON")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return nil, errors.New("one broker service map is required")
	}
	return services, validateServices(services)
}

func validateServices(services map[string]Target) error {
	for id, target := range services {
		if !idPattern.MatchString(id) || !domainPattern.MatchString(target.Domain) || !labelPattern.MatchString(target.Label) {
			return errors.New("broker targets require fixed launchctl domains and ai.refbox labels")
		}
	}
	return nil
}

func OpenStore(filename string) (*Store, error) {
	if filename == "" || filename == ":memory:" || strings.HasPrefix(filename, "file:") {
		return nil, errors.New("broker requires a persistent SQLite filename")
	}
	if filename != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(filename), 0700); err != nil {
			return nil, err
		}
	}
	db, err := sql.Open("sqlite", filename)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	_, err = db.Exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS restart_receipts (
 action_id TEXT PRIMARY KEY, service_id TEXT NOT NULL, domain TEXT NOT NULL, label TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','succeeded','failed')),
 started_at TEXT NOT NULL, ended_at TEXT NOT NULL DEFAULT '', output TEXT NOT NULL DEFAULT ''
);`)
	if err != nil {
		db.Close()
		return nil, err
	}
	if filename != ":memory:" {
		if err = os.Chmod(filename, 0600); err != nil {
			db.Close()
			return nil, err
		}
	}
	return &Store{db}, nil
}

func (s *Store) Close() error { return s.db.Close() }

func scanReceipt(row interface{ Scan(...any) error }) (Receipt, error) {
	var r Receipt
	err := row.Scan(&r.ActionID, &r.ServiceID, &r.Target.Domain, &r.Target.Label, &r.Status, &r.StartedAt, &r.EndedAt, &r.Output)
	return r, err
}

func (s *Store) lookup(ctx context.Context, id string) (Receipt, error) {
	return scanReceipt(s.db.QueryRowContext(ctx, `SELECT action_id,service_id,domain,label,status,started_at,ended_at,output FROM restart_receipts WHERE action_id=?`, id))
}

// Commit the intent before invoking launchctl. Another process/request can only observe this intent.
func (s *Store) reserve(ctx context.Context, request Request, target Target) (Receipt, bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Receipt{}, false, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO restart_receipts(action_id,service_id,domain,label,status,started_at) VALUES(?,?,?,?,'pending',?)`, request.ActionID, request.ServiceID, target.Domain, target.Label, time.Now().UTC().Format(time.RFC3339Nano))
	if err != nil {
		return Receipt{}, false, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return Receipt{}, false, err
	}
	r, err := scanReceipt(tx.QueryRowContext(ctx, `SELECT action_id,service_id,domain,label,status,started_at,ended_at,output FROM restart_receipts WHERE action_id=?`, request.ActionID))
	if err != nil {
		return Receipt{}, false, err
	}
	if r.ServiceID != request.ServiceID {
		return Receipt{}, false, errActionConflict
	}
	if err = tx.Commit(); err != nil {
		return Receipt{}, false, err
	}
	return r, rows == 1, nil
}

var errActionConflict = errors.New("actionId already belongs to another service")

func (s *Store) complete(ctx context.Context, r Receipt) error {
	result, err := s.db.ExecContext(ctx, `UPDATE restart_receipts SET status=?,ended_at=?,output=? WHERE action_id=? AND status='pending'`, r.Status, r.EndedAt, r.Output, r.ActionID)
	if err != nil {
		return err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return err
	}
	if rows != 1 {
		return errors.New("action receipt did not settle")
	}
	return nil
}

func New(store *Store, config Config) (*Server, error) {
	if store == nil || len(config.Token) < 32 {
		return nil, errors.New("broker store and independent token are required")
	}
	if config.Services == nil {
		config.Services = DefaultServices()
	}
	if err := validateServices(config.Services); err != nil {
		return nil, err
	}
	services := make(map[string]Target, len(config.Services))
	for id, target := range config.Services {
		services[id] = target
	}
	if config.Restart == nil {
		config.Restart = launchctlRestart
	}
	return &Server{store, config.Token, services, config.Restart}, nil
}

func launchctlRestart(ctx context.Context, target Target) (string, error) {
	// No shell and no caller-supplied executable, flag, domain or label.
	command := exec.CommandContext(ctx, "/bin/launchctl", "kickstart", "-k", target.Domain+"/"+target.Label)
	command.WaitDelay = time.Second
	output := &limitedBuffer{limit: 64000}
	command.Stdout, command.Stderr = output, output
	err := command.Run()
	return output.String(), err
}

func jsonResponse(w http.ResponseWriter, code int, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(value)
}

func writeReceipt(w http.ResponseWriter, r Receipt) {
	code := http.StatusConflict
	if r.Status == "succeeded" {
		code = http.StatusOK
	} else if r.Status == "failed" {
		code = http.StatusBadGateway
	} else {
		r.Status = "inconclusive"
		r.Output = "动作已受理但结果未确认，禁止重复执行；请独立检查服务状态。"
	}
	jsonResponse(w, code, r)
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	expected := "Bearer " + s.token
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte(expected)) != 1 {
		jsonResponse(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	if r.URL.Path != "/restart" || r.Method != http.MethodPost {
		jsonResponse(w, http.StatusNotFound, map[string]string{"error": "unknown broker operation"})
		return
	}
	var request Request
	r.Body = http.MaxBytesReader(w, r.Body, 4096)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	err := decoder.Decode(&request)
	var extra any
	if err != nil || decoder.Decode(&extra) != io.EOF || !idPattern.MatchString(request.ServiceID) || !actionPattern.MatchString(request.ActionID) {
		jsonResponse(w, http.StatusBadRequest, map[string]string{"error": "only valid serviceId and actionId are accepted"})
		return
	}
	if receipt, err := s.store.lookup(r.Context(), request.ActionID); err == nil {
		if receipt.ServiceID != request.ServiceID {
			jsonResponse(w, http.StatusConflict, map[string]string{"error": errActionConflict.Error()})
		} else {
			writeReceipt(w, receipt)
		}
		return
	} else if err != sql.ErrNoRows {
		jsonResponse(w, http.StatusServiceUnavailable, map[string]string{"error": "broker receipt store unavailable; no action executed"})
		return
	}
	target, allowed := s.services[request.ServiceID]
	if !allowed {
		jsonResponse(w, http.StatusForbidden, map[string]string{"error": "service has no administrator-approved restart"})
		return
	}
	receipt, acquired, err := s.store.reserve(r.Context(), request, target)
	if err != nil {
		code := http.StatusServiceUnavailable
		if errors.Is(err, errActionConflict) {
			code = http.StatusConflict
		}
		jsonResponse(w, code, map[string]string{"error": "could not commit action receipt; no action executed"})
		return
	}
	if !acquired {
		writeReceipt(w, receipt)
		return
	}
	// Caller disconnection must not cancel an already-committed action and invite a duplicate.
	operation, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 15*time.Second)
	output, restartErr := s.restart(operation, target)
	cancel()
	if len(output) > 64000 {
		output = output[:64000]
	}
	receipt.Status = "succeeded"
	if restartErr != nil {
		receipt.Status = "failed"
		output += "\n" + restartErr.Error()
	}
	if len(output) > 64000 {
		output = output[:64000]
	}
	receipt.Output, receipt.EndedAt = output, time.Now().UTC().Format(time.RFC3339Nano)
	commit, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	err = s.store.complete(commit, receipt)
	cancel()
	if err != nil {
		receipt.Status = "pending"
	}
	writeReceipt(w, receipt)
}

type limitedBuffer struct {
	data  []byte
	limit int
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	n := len(p)
	if remaining := b.limit - len(b.data); remaining > 0 {
		if len(p) > remaining {
			p = p[:remaining]
		}
		b.data = append(b.data, p...)
	}
	return n, nil
}

func (b *limitedBuffer) String() string { return string(b.data) }

// ListenAddress confines the broker to a local interface independently of configuration.
func ListenAddress(value string) error {
	return validateListenAddress(value)
}
