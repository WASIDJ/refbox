package control

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Large independent proof and native history must remain complete over HTTP;
// reducing their transfer size must not change the evidence a person can inspect.
func TestPlatformTaskRealHTTPGzipPreservesFullProofAndNativeHistory(t *testing.T) {
	witness := strings.Repeat("verified source line, actual exit code 1, expected 2, observed 3\n", 18000)
	evidence, err := json.Marshal(map[string]any{"exitCode": 1, "stdout": witness, "artifactSha256": strings.Repeat("a", 64)})
	if err != nil {
		t.Fatal(err)
	}
	history, _ := json.Marshal(map[string]any{"messages": []any{map[string]any{"role": "tool", "content": witness}}, "reviewConversationId": "independent-178"})
	native, _ := json.Marshal(map[string]any{"id": "289", "verified": false, "artifact": map[string]any{"content": witness}})
	engine := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("t", 40) || r.Header.Get("Cookie") != "" {
			t.Error("native history request lost service isolation")
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/tasks/289/view":
			_, _ = w.Write(history)
		case "/api/tasks/289":
			_, _ = w.Write(native)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(engine.Close)
	s, err := New(configForTest(engine.URL))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.platform.mutate(func() error {
		s.platform.state.Tasks["task-proof"] = &PlatformTask{ID: "task-proof", ConversationID: "289", BusinessStatus: "done", VerificationStatus: "pass", GoalLoop: &GoalLoop{Phase: "completed", Contract: &GoalContract{Hash: strings.Repeat("b", 64)}, Reviews: []GoalReview{{Verdict: "fail", ReviewConversationID: "independent-178", Evidence: evidence, Checks: []json.RawMessage{evidence}}}}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(s)
	t.Cleanup(func() { server.Close(); s.Close() })
	client := &http.Client{Transport: &http.Transport{DisableCompression: true}, Timeout: 10 * time.Second}
	t.Cleanup(client.CloseIdleConnections)
	login, _ := http.NewRequest("POST", server.URL+"/api/login", strings.NewReader(`{"password":"test-password"}`))
	login.Header.Set("X-Refbox-Request", "1")
	response, err := client.Do(login)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 200 || len(response.Cookies()) != 1 {
		t.Fatal("real HTTP login failed")
	}
	cookie := response.Cookies()[0]
	request := func(t *testing.T, path, encoding string, authenticated bool) (*http.Response, []byte) {
		t.Helper()
		req, _ := http.NewRequest("GET", server.URL+path, nil)
		if authenticated {
			req.AddCookie(cookie)
		}
		if encoding != "" {
			req.Header.Set("Accept-Encoding", encoding)
		}
		res, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, err := io.ReadAll(res.Body)
		if err != nil {
			t.Fatal(err)
		}
		return res, raw
	}
	for _, endpoint := range []string{"/api/platform/tasks/task-proof", "/api/platform/tasks/task-proof/view"} {
		t.Run(endpoint, func(t *testing.T) {
			plainResponse, plain := request(t, endpoint, "", true)
			compressedResponse, compressed := request(t, endpoint, "br, gzip;q=0.8", true)
			if plainResponse.StatusCode != 200 || compressedResponse.StatusCode != 200 {
				t.Fatal("task representation unavailable")
			}
			if len(plain) < 1<<20 {
				t.Fatal("fixture did not exercise a substantial proof/history response")
			}
			if compressedResponse.Header.Get("Content-Encoding") != "gzip" || !strings.Contains(compressedResponse.Header.Get("Vary"), "Accept-Encoding") || compressedResponse.Header.Get("Cache-Control") != "no-store" {
				t.Fatal("missing negotiated gzip or private response headers")
			}
			reader, err := gzip.NewReader(bytes.NewReader(compressed))
			if err != nil {
				t.Fatal(err)
			}
			decoded, err := io.ReadAll(reader)
			reader.Close()
			if err != nil || !bytes.Equal(decoded, plain) {
				t.Fatal("compressed representation changed the full evidence JSON")
			}
			if len(compressed)*5 >= len(plain) {
				t.Fatalf("large proof transfer was not materially reduced: %d -> %d bytes", len(plain), len(compressed))
			}
			if strings.HasSuffix(endpoint, "/view") {
				var value struct {
					View json.RawMessage `json:"view"`
					Task json.RawMessage `json:"task"`
				}
				if json.Unmarshal(decoded, &value) != nil || !bytes.Equal(value.View, history) || !bytes.Equal(value.Task, native) {
					t.Fatal("native artifact or history was truncated or rewritten")
				}
			} else {
				var value PlatformTask
				if json.Unmarshal(decoded, &value) != nil || value.GoalLoop == nil || len(value.GoalLoop.Reviews) != 1 || !bytes.Equal(value.GoalLoop.Reviews[0].Evidence, evidence) || len(value.GoalLoop.Reviews[0].Checks) != 1 || !bytes.Equal(value.GoalLoop.Reviews[0].Checks[0], evidence) || value.GoalLoop.Reviews[0].Verdict != "fail" || value.GoalLoop.Contract == nil || value.GoalLoop.Contract.Hash != strings.Repeat("b", 64) {
					t.Fatal("proof verdict, contract hash, checks, or raw witness changed")
				}
			}
			for _, encoding := range []string{"gzip;q=0, br", "identity", "gzip;q=invalid"} {
				res, body := request(t, endpoint, encoding, true)
				if res.Header.Get("Content-Encoding") != "" || !bytes.Equal(body, plain) {
					t.Fatal("client declined gzip but received a compressed or changed representation")
				}
			}
			res, _ := request(t, endpoint, "gzip", false)
			if res.StatusCode != 401 {
				t.Fatal("large evidence became readable without authentication")
			}
		})
	}
}
