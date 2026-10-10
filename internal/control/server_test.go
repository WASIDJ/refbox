package control

import (
	"crypto/pbkdf2"
	"crypto/sha256"
	"encoding/base64"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func configForTest(engine string) Config {
	salt := []byte("a-16-byte-salt!!x")
	key, _ := pbkdf2.Key(sha256.New, "test-password", salt, 100000, 32)
	return Config{EngineURL: engine, EngineToken: strings.Repeat("t", 40), PasswordHash: fmt.Sprintf("pbkdf2-sha256$100000$%s$%s", base64.RawURLEncoding.EncodeToString(salt), base64.RawURLEncoding.EncodeToString(key))}
}
func TestAuthAndProxy(t *testing.T) {
	backend := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+strings.Repeat("t", 40) {
			t.Error("missing internal auth")
		}
		if r.Header.Get("Cookie") != "" {
			t.Error("browser cookies reached execution service")
		}
		w.Write([]byte(`{"ok":true}`))
	})
	s, err := New(configForTest("http://127.0.0.1:18801"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	s.proxy.Transport = handlerTransport{backend}
	unauth := httptest.NewRecorder()
	s.ServeHTTP(unauth, httptest.NewRequest("GET", "/api/tasks", nil))
	if unauth.Code != 401 {
		t.Fatalf("got %d", unauth.Code)
	}
	cross := httptest.NewRequest("POST", "http://refbox.local/api/login", strings.NewReader(`{"password":"test-password"}`))
	cross.Header.Set("X-Refbox-Request", "1")
	cross.Header.Set("Origin", "https://other.local")
	out := httptest.NewRecorder()
	s.ServeHTTP(out, cross)
	if out.Code != 403 {
		t.Fatal("cross-origin login accepted")
	}
	login := httptest.NewRequest("POST", "/api/login", strings.NewReader(`{"password":"test-password"}`))
	login.Header.Set("X-Refbox-Request", "1")
	result := httptest.NewRecorder()
	s.ServeHTTP(result, login)
	if result.Code != 200 {
		t.Fatal(result.Body.String())
	}
	cookie := result.Result().Cookies()[0]
	if !cookie.HttpOnly || cookie.SameSite != http.SameSiteStrictMode {
		t.Fatal("unsafe session cookie")
	}
	request := httptest.NewRequest("GET", "/api/tasks", nil)
	request.AddCookie(cookie)
	allowed := httptest.NewRecorder()
	s.ServeHTTP(allowed, request)
	if allowed.Code != 200 {
		t.Fatal("authenticated proxy failed")
	}
	write := httptest.NewRequest("POST", "/api/tasks", strings.NewReader(`{}`))
	write.AddCookie(cookie)
	rejected := httptest.NewRecorder()
	s.ServeHTTP(rejected, write)
	if rejected.Code != 403 {
		t.Fatal("write without request header accepted")
	}
}
func TestDailyCatchUpDates(t *testing.T) {
	loc, _ := time.LoadLocation("Asia/Shanghai")
	created := time.Date(2026, 10, 9, 10, 0, 0, 0, loc)
	at := time.Date(2026, 10, 12, 8, 0, 0, 0, loc)
	dates := dueDates(created, at, map[string]bool{"2026-10-10": true})
	if len(dates) != 1 || dates[0] != "2026-10-11" {
		t.Fatalf("wrong catch-up: %v", dates)
	}
	if len(dueDates(at, at, map[string]bool{})) != 0 {
		t.Fatal("report before first due time")
	}
}
