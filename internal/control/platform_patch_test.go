package control

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
)

func TestPlatformLiveSeededFieldsSkipUnchangedProofAfterBootstrapChanges(t *testing.T) {
	s, server, client, cookie := liveSnapshotFixture(t)
	witness, _ := json.Marshal(map[string]string{"stdout": strings.Repeat("complete proof remains available\n", 40000)})
	if err := s.platform.mutate(func() error {
		s.platform.state.Tasks["proof"] = &PlatformTask{ID: "proof", GoalLoop: &GoalLoop{Reviews: []GoalReview{{Evidence: witness}}}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	response, raw := snapshotRequest(t, client, server, cookie, "identity")
	fields := response.Header.Get("X-Refbox-Snapshot-Fields")
	var hashes map[string]string
	if json.Unmarshal([]byte(fields), &hashes) != nil || len(hashes) != 7 {
		t.Fatal("complete bootstrap omitted public field fingerprints")
	}
	var state map[string]json.RawMessage
	if json.Unmarshal(raw, &state) != nil {
		t.Fatal("bootstrap unavailable")
	}
	for key, value := range state {
		if hashes[key] != fmt.Sprintf("%x", sha256.Sum256(value)) {
			t.Fatal("field fingerprint does not match complete bootstrap bytes")
		}
	}
	if err := s.platform.mutate(func() error {
		s.platform.state.Workers["worker-a"].Detail = "real change during slow bootstrap"
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/platform/events?updates=patch&since="+response.Header.Get("X-Refbox-Snapshot-Hash")+"&fields="+url.QueryEscape(fields), nil)
	req.AddCookie(cookie)
	res, err := client.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	frame := readLiveSSEFrame(t, bufio.NewReader(res.Body))
	if !strings.HasPrefix(frame, "event: snapshot_patch\ndata: ") || len(frame) > 4000 {
		t.Fatal("slow bootstrap change retransmitted the unchanged complete proof")
	}
	var patch map[string]json.RawMessage
	if json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(frame, "event: snapshot_patch\ndata: "))), &patch) != nil || len(patch) != 1 || patch["workers"] == nil {
		t.Fatal("bootstrap change did not isolate the changed field")
	}
	for key, value := range patch {
		state[key] = value
	}
	full, _ := s.platformSnapshotJSON()
	var expected map[string]json.RawMessage
	_ = json.Unmarshal(full, &expected)
	got, _ := json.Marshal(state)
	want, _ := json.Marshal(expected)
	if !bytes.Equal(got, want) {
		t.Fatal("seeded bootstrap lost the complete proof or current state")
	}
}

func TestPlatformLivePatchesPreserveCompleteProofAndResynchronize(t *testing.T) {
	s, server, client, cookie := liveSnapshotFixture(t)
	witness, _ := json.Marshal(map[string]string{"stdout": strings.Repeat("complete verified source and raw exit evidence\n", 24000)})
	if err := s.platform.mutate(func() error {
		s.platform.state.Tasks["proof"] = &PlatformTask{ID: "proof", GoalLoop: &GoalLoop{Phase: "completed", Reviews: []GoalReview{{Verdict: "pass", Evidence: witness}}}}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	response, raw := snapshotRequest(t, client, server, cookie, "identity")
	hash := response.Header.Get("X-Refbox-Snapshot-Hash")
	if hash != fmt.Sprintf("%x", sha256.Sum256(bytes.TrimSpace(raw))) {
		t.Fatal("snapshot does not identify its complete representation")
	}
	var state map[string]json.RawMessage
	if err := json.Unmarshal(raw, &state); err != nil {
		t.Fatal(err)
	}
	open := func(since string) (*bufio.Reader, func()) {
		ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
		req, _ := http.NewRequestWithContext(ctx, "GET", server.URL+"/api/platform/events?updates=patch&since="+since, nil)
		req.AddCookie(cookie)
		res, err := client.Do(req)
		if err != nil {
			cancel()
			t.Fatal(err)
		}
		if res.StatusCode != 200 {
			cancel()
			res.Body.Close()
			t.Fatal("patch stream unavailable")
		}
		return bufio.NewReader(res.Body), func() { cancel(); res.Body.Close() }
	}
	reader, closeStream := open(hash)
	defer closeStream()
	if first := readLiveSSEFrame(t, reader); first != ": heartbeat\n\n" {
		t.Fatal("matching complete snapshot was needlessly transferred again")
	}
	if err := s.platform.mutate(func() error {
		s.platform.state.Resources["machine"] = &Resource{ID: "machine", Health: "healthy", SampledAt: instant(), Detail: "fresh actual sample"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	patch := readLiveSSEFrame(t, reader)
	if !strings.HasPrefix(patch, "event: snapshot_patch\ndata: ") || len(patch) > 4000 {
		t.Fatal("small resource update resent the complete large proof")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(patch, "event: snapshot_patch\ndata: "))), &fields); err != nil {
		t.Fatal(err)
	}
	if len(fields) != 1 || fields["resources"] == nil {
		t.Fatal("patch did not isolate the changed public field")
	}
	for key, value := range fields {
		state[key] = value
	}
	assertComplete := func() {
		t.Helper()
		full, err := s.platformSnapshotJSON()
		if err != nil {
			t.Fatal(err)
		}
		var expected map[string]json.RawMessage
		if err := json.Unmarshal(full, &expected); err != nil {
			t.Fatal(err)
		}
		got, _ := json.Marshal(state)
		want, _ := json.Marshal(expected)
		if !bytes.Equal(got, want) {
			t.Fatal("patch lost public state or complete independent evidence")
		}
	}
	assertComplete()
	if err := s.platform.mutate(func() error { delete(s.platform.state.Tasks, "proof"); return nil }); err != nil {
		t.Fatal(err)
	}
	removed := readLiveSSEFrame(t, reader)
	if !strings.HasPrefix(removed, "event: snapshot_patch\ndata: ") {
		t.Fatal("task removal not delivered")
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(removed, "event: snapshot_patch\ndata: "))), &fields); err != nil {
		t.Fatal(err)
	}
	for key, value := range fields {
		state[key] = value
	}
	assertComplete()
	closeStream()
	reader, closeResync := open(hash)
	defer closeResync()
	resync := readLiveSSEFrame(t, reader)
	if !strings.HasPrefix(resync, "event: snapshot\ndata: ") {
		t.Fatal("stale client did not receive a full authoritative snapshot")
	}
	if err := json.Unmarshal([]byte(strings.TrimSpace(strings.TrimPrefix(resync, "event: snapshot\ndata: "))), &state); err != nil {
		t.Fatal(err)
	}
	assertComplete()
}
