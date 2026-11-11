package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
)

type memorySessions struct {
	mu   sync.Mutex
	rows map[string]sessionRecord
	fail bool
}

func (s *memorySessions) Put(_ context.Context, r sessionRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return errors.New("database offline")
	}
	s.rows[r.ID] = r
	return nil
}
func (s *memorySessions) Get(_ context.Context, id string) (sessionRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.fail {
		return sessionRecord{}, errors.New("database offline")
	}
	r, ok := s.rows[id]
	if !ok {
		return r, pgx.ErrNoRows
	}
	return r, nil
}
func (s *memorySessions) Delete(_ context.Context, id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.rows, id)
	return nil
}

type sessionUpstream struct {
	mu                                        sync.Mutex
	valid                                     map[string]bool
	initialized, notified, executed, requests int
	rejectStatus                              int
	failInit, alwaysReject, sse               bool
}

func sessionFixture(t *testing.T) (*gateway, *sessionUpstream, *memorySessions) {
	t.Helper()
	u := &sessionUpstream{valid: map[string]bool{}, rejectStatus: 404}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u.mu.Lock()
		defer u.mu.Unlock()
		u.requests++
		var msg rpc
		_ = json.NewDecoder(r.Body).Decode(&msg)
		send := func(status int, value any) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(value)
		}
		result := func(value any) { send(200, map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": value}) }
		if msg.Method == "initialize" {
			if r.Header.Get("Mcp-Session-Id") != "" {
				t.Error("initialize leaked old session")
			}
			u.initialized++
			if u.failInit {
				send(503, map[string]any{"error": "offline"})
				return
			}
			sid := fmt.Sprintf("up-%d", u.initialized)
			u.valid[sid] = true
			w.Header().Set("Mcp-Session-Id", sid)
			value := map[string]any{"protocolVersion": "2025-03-26", "serverInfo": map[string]any{"name": "fixture", "version": "1"}, "capabilities": map[string]any{"tools": map[string]any{}}}
			if u.sse {
				data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": value})
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprintf(w, "data: %s\n\n", data)
				w.(http.Flusher).Flush()
				// Release the fixture mutex while the stream stays open. The gateway
				// must cancel it after reading the initialize response, not await EOF.
				u.mu.Unlock()
				<-r.Context().Done()
				u.mu.Lock()
				return
			}
			result(value)
			return
		}
		sid := r.Header.Get("Mcp-Session-Id")
		if !u.valid[sid] || u.alwaysReject {
			send(u.rejectStatus, map[string]any{"jsonrpc": "2.0", "id": "server-error", "error": map[string]any{"code": -32600, "message": "Session not found"}})
			return
		}
		if msg.Method == "notifications/initialized" {
			u.notified++
			w.WriteHeader(202)
			return
		}
		if r.Method == "DELETE" {
			delete(u.valid, sid)
			w.WriteHeader(204)
			return
		}
		if r.Method == "GET" {
			w.WriteHeader(405)
			return
		}
		if msg.Method == "tools/list" {
			result(map[string]any{"tools": []any{map[string]any{"name": "read", "inputSchema": map[string]any{"type": "object"}}, map[string]any{"name": "write", "inputSchema": map[string]any{"type": "object"}}}})
			return
		}
		if msg.Method == "tools/call" {
			u.executed++
			result(map[string]any{"content": []any{map[string]any{"type": "text", "text": "ok"}}})
			return
		}
		result(map[string]any{})
	}))
	t.Cleanup(up.Close)
	store := &memorySessions{rows: map[string]sessionRecord{}}
	g := newGateway()
	g.sessionStore = store
	g.state.Store(&snapshot{At: time.Now(), Tokens: map[string]string{digest("a"): "space-a", digest("b"): "space-b"}, Policies: map[string]policy{
		key("space-a", "crm"): {Space: "space-a", Server: "crm", URL: up.URL, Concurrency: 64, RPM: 1000},
		key("space-b", "crm"): {Space: "space-b", Server: "crm", URL: up.URL, Concurrency: 64, RPM: 1000},
	}})
	return g, u, store
}
func startSession(t *testing.T, g *gateway) string {
	t.Helper()
	w := request(g, "a", `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}`, "")
	sid := w.Header().Get("Mcp-Session-Id")
	if w.Code != 200 || !strings.HasPrefix(sid, "gy1_") {
		t.Fatal(w.Code, w.Body.String(), sid)
	}
	return sid
}
func expire(u *sessionUpstream) { u.mu.Lock(); u.valid = map[string]bool{}; u.mu.Unlock() }

const listRPC = `{"jsonrpc":"2.0","id":2,"method":"tools/list"}`
const callRPC = `{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"read"}}`

func TestGatewaySessionRecoveryAndStableIdentity(t *testing.T) {
	for _, status := range []int{200, 400, 404} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			g, u, _ := sessionFixture(t)
			sid := startSession(t, g)
			u.rejectStatus = status
			expire(u)
			w := request(g, "a", listRPC, sid)
			if w.Code != 200 || !strings.Contains(w.Body.String(), "read") || w.Header().Get("Mcp-Session-Id") != sid {
				t.Fatal(w.Code, w.Body.String())
			}
			if u.initialized != 2 || u.notified != 1 {
				t.Fatal("handshake not renewed", u.initialized, u.notified)
			}
		})
	}
}
func TestGatewayDoesNotReplayBusinessCalls(t *testing.T) {
	g, u, _ := sessionFixture(t)
	sid := startSession(t, g)
	expire(u)
	w := request(g, "a", callRPC, sid)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "未自动重放") || u.executed != 0 {
		t.Fatal(w.Code, w.Body.String(), u.executed)
	}
	<-g.audit // initialize
	if event := <-g.audit; event.Status != 409 {
		t.Fatal("replay-required tool audited as success", event.Status)
	}
	w = request(g, "a", callRPC, sid)
	if w.Code != 200 || u.executed != 1 {
		t.Fatal(w.Code, w.Body.String(), u.executed)
	}
}
func TestGatewayRestartRestoresSessionBeforeExecuting(t *testing.T) {
	g, u, store := sessionFixture(t)
	sid := startSession(t, g)
	restarted := newGateway()
	restarted.sessionStore = store
	restarted.state.Store(g.state.Load())
	w := request(restarted, "a", callRPC, sid)
	if w.Code != 200 || !strings.Contains(w.Body.String(), "ok") || u.initialized != 2 || u.executed != 1 {
		t.Fatal(w.Code, w.Body.String(), u.initialized, u.executed)
	}
}
func TestConcurrentRecoveryHandshakesOnce(t *testing.T) {
	g, u, _ := sessionFixture(t)
	sid := startSession(t, g)
	expire(u)
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := request(g, "a", listRPC, sid)
			if w.Code != 200 || !strings.Contains(w.Body.String(), "read") {
				t.Error(w.Code, w.Body.String())
			}
		}()
	}
	wg.Wait()
	if u.initialized != 2 {
		t.Fatal("duplicate handshakes", u.initialized)
	}
}
func TestSessionIsolationRevocationAndDelete(t *testing.T) {
	g, u, store := sessionFixture(t)
	a := startSession(t, g)
	b := startSession(t, g)
	if a == b {
		t.Fatal("client sessions shared")
	}
	before := u.requests
	if w := request(g, "b", listRPC, a); w.Code != 404 || u.requests != before {
		t.Fatal("cross space session reached upstream", w.Code)
	}
	r := httptest.NewRequest("DELETE", "/mcp/crm", nil)
	r.Header.Set("Authorization", "Bearer a")
	r.Header.Set("Mcp-Session-Id", a)
	w := httptest.NewRecorder()
	g.ServeHTTP(w, r)
	if w.Code != 204 {
		t.Fatal(w.Code, w.Body.String())
	}
	restarted := newGateway()
	restarted.sessionStore = store
	restarted.state.Store(g.state.Load())
	if w := request(restarted, "a", listRPC, a); w.Code != 404 {
		t.Fatal("deleted session resurrected", w.Code)
	}
	delete(g.state.Load().Policies, key("space-a", "crm"))
	before = u.requests
	if w := request(g, "a", callRPC, b); w.Code != 403 || u.requests != before {
		t.Fatal("revoked session reached upstream")
	}
}
func TestLegacySessionAdoptionNeverReusesForeignUpstream(t *testing.T) {
	g, u, _ := sessionFixture(t)
	// Even if an attacker guesses another space's old upstream ID, adoption
	// creates a new handshake and never forwards that guessed ID upstream.
	w := request(g, "a", listRPC, "up-foreign")
	if w.Code != 200 || !strings.Contains(w.Body.String(), "read") || u.initialized != 1 {
		t.Fatal(w.Code, w.Body.String())
	}
	w = request(g, "b", listRPC, "up-foreign")
	if w.Code != 200 || u.initialized != 2 {
		t.Fatal("legacy aliases not isolated", w.Code, w.Body.String())
	}
}
func TestSessionRecoveryDoesNotWaitForSSEClose(t *testing.T) {
	g, u, _ := sessionFixture(t)
	u.sse = true
	sid := startSession(t, g)
	expire(u)
	if w := request(g, "a", listRPC, sid); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestFailedRecoveryIsBoundedAndPolicyChangeFailsClosed(t *testing.T) {
	g, u, _ := sessionFixture(t)
	sid := startSession(t, g)
	expire(u)
	u.failInit = true
	for i := 0; i < 4; i++ {
		if w := request(g, "a", listRPC, sid); w.Code != 502 {
			t.Fatal(w.Code, w.Body.String())
		}
	}
	if u.initialized != 2 {
		t.Fatal("failed handshake storm", u.initialized)
	}
	p := g.state.Load().Policies[key("space-a", "crm")]
	p.URL += "/changed"
	g.state.Load().Policies[key("space-a", "crm")] = p
	before := u.requests
	if w := request(g, "a", listRPC, sid); w.Code != 409 || u.requests != before {
		t.Fatal("changed upstream reused old session", w.Code)
	}
}
func TestSessionStoreFailureDoesNotExposeUnpersistedIdentity(t *testing.T) {
	g, _, store := sessionFixture(t)
	store.fail = true
	w := request(g, "a", `{"jsonrpc":"2.0","id":1,"method":"initialize"}`, "")
	if w.Code != 503 || w.Header().Get("Mcp-Session-Id") != "" {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestSessionDetectionPreservesResultsAndIgnoresAuthFailures(t *testing.T) {
	for _, status := range []int{401, 403, 502} {
		resp := jsonResponse(status, []byte(`{"error":"unknown_session"}`))
		if rejectedSession(resp) {
			t.Fatal("auth/network failure triggers handshake", status)
		}
		resp.Body.Close()
	}
	data := `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Session not found"}]}}`
	resp := jsonResponse(200, []byte(data))
	if rejectedSession(resp) {
		t.Fatal("tool content mistaken for protocol error")
	}
	recovered, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if string(recovered) != data {
		t.Fatal("result body consumed")
	}
}
