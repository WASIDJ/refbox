package broker

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testToken = "broker-test-token-independent-00000000000000"

func fixture(t *testing.T, restart RestartFunc) (*Store, *Server, string) {
	t.Helper()
	database := filepath.Join(t.TempDir(), "broker.sqlite")
	store, err := OpenStore(database)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	server, err := New(store, Config{Token: testToken, Restart: restart})
	if err != nil {
		t.Fatal(err)
	}
	return store, server, database
}

func invoke(server *Server, raw, token string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/restart", strings.NewReader(raw))
	request.Header.Set("Authorization", "Bearer "+token)
	result := httptest.NewRecorder()
	server.ServeHTTP(result, request)
	return result
}

func receipt(t *testing.T, response *httptest.ResponseRecorder) Receipt {
	t.Helper()
	var r Receipt
	if err := json.Unmarshal(response.Body.Bytes(), &r); err != nil {
		t.Fatal(err)
	}
	return r
}

func TestDefaultAuthorizationAndStrictInputs(t *testing.T) {
	var calls atomic.Int32
	_, server, _ := fixture(t, func(context.Context, Target) (string, error) { calls.Add(1); return "", nil })
	for _, test := range []struct {
		raw, token string
		code       int
	}{
		{`{"serviceId":"engine","actionId":"a1"}`, "wrong", 401},
		{`{"serviceId":"control","actionId":"a1"}`, testToken, 403},
		{`{"serviceId":"unknown","actionId":"a1"}`, testToken, 403},
		{`{"serviceId":"engine","actionId":"a1","command":"rm -rf /"}`, testToken, 400},
		{`{"serviceId":"engine","actionId":"a1","label":"other"}`, testToken, 400},
		{`{"serviceId":"engine","actionId":"../bad"}`, testToken, 400},
		{`{"serviceId":"engine","actionId":"a1"} {}`, testToken, 400},
	} {
		if result := invoke(server, test.raw, test.token); result.Code != test.code {
			t.Fatalf("%s: got %d, want %d", test.raw, result.Code, test.code)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("unauthorized inputs executed an action")
	}
}

func TestFixedTargetAndPersistentIdempotency(t *testing.T) {
	var calls atomic.Int32
	store, server, filename := fixture(t, func(_ context.Context, target Target) (string, error) {
		calls.Add(1)
		if target != (Target{Domain: "system", Label: "ai.refbox.engine"}) {
			t.Errorf("wrong target: %+v", target)
		}
		return "launchctl confirmed", nil
	})
	raw := `{"serviceId":"engine","actionId":"action-1"}`
	first := invoke(server, raw, testToken)
	if first.Code != 200 || receipt(t, first).Status != "succeeded" {
		t.Fatalf("restart failed: %s", first.Body.String())
	}
	if second := invoke(server, raw, testToken); second.Code != 200 {
		t.Fatal("duplicate lost original result")
	}
	if conflict := invoke(server, `{"serviceId":"tunnel","actionId":"action-1"}`, testToken); conflict.Code != 409 {
		t.Fatal("action ID reused for another target")
	}
	if calls.Load() != 1 {
		t.Fatal("duplicate launchctl action")
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := OpenStore(filename)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	second, err := New(reopened, Config{Token: testToken, Restart: func(context.Context, Target) (string, error) { calls.Add(1); return "", nil }})
	if err != nil {
		t.Fatal(err)
	}
	if result := invoke(second, raw, testToken); result.Code != 200 {
		t.Fatal("persisted success missing")
	}
	if calls.Load() != 1 {
		t.Fatal("reopen repeated completed action")
	}
}

func TestConcurrentDuplicateIsInconclusiveWhileFirstActionRuns(t *testing.T) {
	started, release, finished := make(chan struct{}), make(chan struct{}), make(chan *httptest.ResponseRecorder, 1)
	var calls atomic.Int32
	_, server, _ := fixture(t, func(context.Context, Target) (string, error) {
		calls.Add(1)
		close(started)
		<-release
		return "finished", nil
	})
	raw := `{"serviceId":"engine","actionId":"action-running"}`
	go func() { finished <- invoke(server, raw, testToken) }()
	<-started
	duplicate := invoke(server, raw, testToken)
	if duplicate.Code != 409 || receipt(t, duplicate).Status != "inconclusive" {
		t.Fatal("pending action must remain inconclusive")
	}
	close(release)
	if result := <-finished; result.Code != 200 {
		t.Fatal("first action did not settle")
	}
	if calls.Load() != 1 {
		t.Fatal("concurrent action repeated")
	}
}

func TestFailedAndUnpersistedResultsNeverBecomeSuccess(t *testing.T) {
	var calls atomic.Int32
	_, failed, _ := fixture(t, func(context.Context, Target) (string, error) {
		calls.Add(1)
		return "not found", errors.New("launchctl failed")
	})
	raw := `{"serviceId":"engine","actionId":"failed-1"}`
	for n := 0; n < 2; n++ {
		if result := invoke(failed, raw, testToken); result.Code != 502 || receipt(t, result).Status != "failed" {
			t.Fatal("failed result claimed success")
		}
	}
	if calls.Load() != 1 {
		t.Fatal("failed action was retried")
	}
	var store *Store
	store, uncertain, filename := fixture(t, func(context.Context, Target) (string, error) { _ = store.Close(); return "process succeeded", nil })
	result := invoke(uncertain, `{"serviceId":"engine","actionId":"uncertain-1"}`, testToken)
	if result.Code != 409 || receipt(t, result).Status != "inconclusive" {
		t.Fatal("missing durable settlement claimed success")
	}
	reopened, err := OpenStore(filename)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	prior, err := reopened.lookup(context.Background(), "uncertain-1")
	if err != nil || prior.Status != "pending" {
		t.Fatal("pending intent was not durable")
	}
}

func TestAdministratorAllowlistAndLoopbackValidation(t *testing.T) {
	services, err := ServicesFromJSON(`{"custom":{"domain":"gui/501","label":"ai.refbox.custom"}}`)
	if err != nil || services["custom"].Label != "ai.refbox.custom" || len(services) != 1 {
		t.Fatal("explicit allowlist not respected")
	}
	for _, raw := range []string{
		`{"bad":{"domain":"system;sh","label":"ai.refbox.engine"}}`,
		`{"bad":{"domain":"system","label":"com.apple.other"}}`,
		`{"bad":{"domain":"system","label":"ai.refbox.engine","command":"other"}}`,
		`{"bad":{"domain":"system","label":"ai.refbox../other"}}`,
		`null`,
	} {
		if _, err := ServicesFromJSON(raw); err == nil {
			t.Fatalf("invalid admin configuration accepted: %s", raw)
		}
	}
	for _, address := range []string{"0.0.0.0:18814", "192.168.1.2:18814", "127.0.0.1:0", "localhost:18814"} {
		if ListenAddress(address) == nil {
			t.Errorf("non-loopback or invalid address accepted: %s", address)
		}
	}
	for _, address := range []string{"127.0.0.1:18814", "[::1]:18814"} {
		if err := ListenAddress(address); err != nil {
			t.Error(err)
		}
	}
}

// The child uses an injected operation; this never invokes launchctl.
func TestBrokerCrashHelper(t *testing.T) {
	dir := os.Getenv("REFBOX_BROKER_TEST_CRASH_DIR")
	if dir == "" {
		return
	}
	store, err := OpenStore(filepath.Join(dir, "broker.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	server, err := New(store, Config{Token: testToken, Restart: func(context.Context, Target) (string, error) {
		file, err := os.OpenFile(filepath.Join(dir, "attempts"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
		if err != nil {
			panic(err)
		}
		_, _ = file.WriteString("restart\n")
		_ = file.Close()
		_ = os.WriteFile(filepath.Join(dir, "started"), []byte("ready"), 0600)
		select {}
	}})
	if err != nil {
		t.Fatal(err)
	}
	invoke(server, `{"serviceId":"engine","actionId":"crash-action"}`, testToken)
}

func TestSIGKILLDoesNotRepeatAmbiguousAction(t *testing.T) {
	dir := t.TempDir()
	child := exec.Command(os.Args[0], "-test.run=^TestBrokerCrashHelper$")
	child.Env = append(os.Environ(), "REFBOX_BROKER_TEST_CRASH_DIR="+dir)
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer child.Process.Kill()
	deadline := time.Now().Add(5 * time.Second)
	for {
		if _, err := os.Stat(filepath.Join(dir, "started")); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("child never started injected action")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = child.Wait()
	store, err := OpenStore(filepath.Join(dir, "broker.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	var calls atomic.Int32
	server, err := New(store, Config{Token: testToken, Restart: func(context.Context, Target) (string, error) { calls.Add(1); return "", nil }})
	if err != nil {
		t.Fatal(err)
	}
	result := invoke(server, `{"serviceId":"engine","actionId":"crash-action"}`, testToken)
	if result.Code != 409 || receipt(t, result).Status != "inconclusive" || calls.Load() != 0 {
		t.Fatal("ambiguous action repeated or claimed success")
	}
	attempts, err := os.ReadFile(filepath.Join(dir, "attempts"))
	if err != nil || string(attempts) != "restart\n" {
		t.Fatal("unexpected operation count")
	}
}
