package control

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func liveSnapshotFixture(t *testing.T) (*Server, *httptest.Server, *http.Client, *http.Cookie) {
	t.Helper()
	s, err := New(configForTest("http://127.0.0.1:18801"))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.platform.mutate(func() error {
		for i := range 1000 {
			s.platform.state.Events = append(s.platform.state.Events, &Event{ID: fmt.Sprintf("event-%04d", i), At: "2026-10-10T00:00:00Z", Kind: "observation.recorded", ResourceID: "test-resource", Message: strings.Repeat("actual observation payload ", 6)})
		}
		for _, id := range []string{"worker-c", "worker-a", "worker-b"} {
			s.platform.state.Workers[id] = &Worker{ID: id, Role: "verifier", Status: "online", LastSeen: instant(), Detail: "stable worker"}
		}
		for _, id := range []string{"task-c", "task-a", "task-b"} {
			s.platform.state.Tasks[id] = &PlatformTask{ID: id, CreatedAt: "2026-10-10T00:00:00Z"}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(s)
	t.Cleanup(func() { server.Close(); s.Close() })
	client := &http.Client{Transport: &http.Transport{DisableCompression: true}, Timeout: 9 * time.Second}
	t.Cleanup(func() { client.CloseIdleConnections() })
	request, _ := http.NewRequest("POST", server.URL+"/api/login", strings.NewReader(`{"password":"test-password"}`))
	request.Header.Set("X-Refbox-Request", "1")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || len(response.Cookies()) != 1 {
		t.Fatal("real HTTP login failed")
	}
	return s, server, client, response.Cookies()[0]
}

func snapshotRequest(t *testing.T, client *http.Client, server *httptest.Server, cookie *http.Cookie, encoding string) (*http.Response, []byte) {
	t.Helper()
	request, _ := http.NewRequest("GET", server.URL+"/api/platform/snapshot", nil)
	request.AddCookie(cookie)
	if encoding != "" {
		request.Header.Set("Accept-Encoding", encoding)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	return response, raw
}

func TestPlatformSnapshotRealHTTPGzipPreservesJSONAndNegotiation(t *testing.T) {
	_, server, client, cookie := liveSnapshotFixture(t)
	plainResponse, plain := snapshotRequest(t, client, server, cookie, "")
	compressedResponse, compressed := snapshotRequest(t, client, server, cookie, "br, gzip;q=0.8")
	if plainResponse.StatusCode != 200 || compressedResponse.StatusCode != 200 {
		t.Fatal("snapshot failed")
	}
	if compressedResponse.Header.Get("Content-Encoding") != "gzip" || !strings.Contains(compressedResponse.Header.Get("Vary"), "Accept-Encoding") {
		t.Fatal("missing gzip negotiation headers")
	}
	if compressedResponse.Header.Get("Set-Cookie") != "" || compressedResponse.Header.Get("Cache-Control") != "no-store" {
		t.Fatal("snapshot exposed a cookie or became cacheable")
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := io.ReadAll(reader)
	reader.Close()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(plain, decoded) {
		t.Fatal("compression changed snapshot JSON")
	}
	var value Snapshot
	if err := json.Unmarshal(decoded, &value); err != nil || len(value.Events) != 1000 || len(value.Tasks) != 3 || len(value.Workers) != 3 {
		t.Fatal("decoded snapshot lost public data")
	}
	if len(compressed)*5 >= len(plain) {
		t.Fatalf("snapshot was not materially smaller: %d -> %d bytes", len(plain), len(compressed))
	}
	for _, encoding := range []string{"gzip;q=0, br", "identity", "gzip;q=invalid"} {
		response, body := snapshotRequest(t, client, server, cookie, encoding)
		if response.Header.Get("Content-Encoding") != "" || !bytes.Equal(body, plain) {
			t.Fatal("compressed a client that did not accept gzip")
		}
	}
}

func readLiveSSEFrame(t *testing.T, reader *bufio.Reader) string {
	t.Helper()
	var frame strings.Builder
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal("live SSE frame was not flushed within the request deadline: " + err.Error())
		}
		frame.WriteString(line)
		if line == "\n" {
			return frame.String()
		}
	}
}

func liveSSE(t *testing.T, server *httptest.Server, client *http.Client, cookie *http.Cookie) (*bufio.Reader, func()) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	request, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/platform/events", nil)
	request.AddCookie(cookie)
	request.Header.Set("Accept-Encoding", "gzip")
	response, err := client.Do(request)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	if response.StatusCode != 200 || response.Header.Get("Content-Type") != "text/event-stream" || response.Header.Get("Content-Encoding") != "gzip" || !strings.Contains(response.Header.Get("Vary"), "Accept-Encoding") {
		response.Body.Close()
		cancel()
		t.Fatal("incorrect live SSE headers")
	}
	reader, err := gzip.NewReader(response.Body)
	if err != nil {
		response.Body.Close()
		cancel()
		t.Fatal(err)
	}
	return bufio.NewReader(reader), func() { cancel(); response.Body.Close(); reader.Close() }
}

func TestPlatformLiveGzipSSEFlushesSnapshotHeartbeatAndChangedState(t *testing.T) {
	s, server, client, cookie := liveSnapshotFixture(t)
	reader, closeStream := liveSSE(t, server, client, cookie)
	defer closeStream()
	first := readLiveSSEFrame(t, reader)
	if !strings.HasPrefix(first, "event: snapshot\ndata: ") || !strings.Contains(first, "event-0999") {
		t.Fatal("initial snapshot frame lost events")
	}
	if heartbeat := readLiveSSEFrame(t, reader); heartbeat != ": heartbeat\n\n" {
		t.Fatal("unchanged state resent a full snapshot instead of a heartbeat")
	}
	if err := s.platform.mutate(func() error {
		s.platform.event("real.changed", "test-resource", "", "changed after first heartbeat")
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	changed := readLiveSSEFrame(t, reader)
	if !strings.HasPrefix(changed, "event: snapshot\ndata: ") || !strings.Contains(changed, "changed after first heartbeat") {
		t.Fatal("changed state did not reach the existing compressed stream")
	}
}

func TestPlatformLiveGzipSSEDetectsStaleResourceAndOfflineWorkerWithoutWrites(t *testing.T) {
	s, server, client, cookie := liveSnapshotFixture(t)
	if err := s.platform.mutate(func() error {
		at := time.Now().Add(-44 * time.Second).UTC().Format(time.RFC3339Nano)
		s.platform.state.Resources["expiring"] = &Resource{ID: "expiring", Health: "healthy", SampledAt: at}
		s.platform.state.Workers["expiring"] = &Worker{ID: "expiring", Status: "online", LastSeen: at}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	reader, closeStream := liveSSE(t, server, client, cookie)
	defer closeStream()
	first := readLiveSSEFrame(t, reader)
	if !strings.Contains(first, `"health":"healthy"`) {
		t.Fatal("resource expired before initial frame")
	}
	next := readLiveSSEFrame(t, reader)
	if !strings.HasPrefix(next, "event: snapshot\ndata: ") || !strings.Contains(next, `"health":"stale"`) || !strings.Contains(next, `"status":"offline"`) {
		t.Fatal("derived stale/offline transition was hidden by snapshot deduplication")
	}
}
