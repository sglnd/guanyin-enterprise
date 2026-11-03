package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func fixture(t *testing.T) (*gateway, *atomic.Int32) {
	t.Helper()
	hits := &atomic.Int32{}
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.Header.Get("Authorization") != "Bearer upstream-secret" || r.Header.Get("Cookie") != "" {
			t.Error("credential leakage")
		}
		var m rpc
		_ = json.NewDecoder(r.Body).Decode(&m)
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Mcp-Session-Id", "upstream-session")
		if m.Method == "tools/list" {
			io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"read"},{"name":"delete"}]}}`)
		} else {
			io.WriteString(w, `{"jsonrpc":"2.0","id":1,"result":{}}`)
		}
	}))
	t.Cleanup(up.Close)
	g := newGateway()
	s := &snapshot{At: time.Now(), Tokens: map[string]string{digest("a"): "space-a", digest("b"): "space-b"}, Policies: map[string]policy{}}
	for _, sp := range []string{"space-a", "space-b"} {
		s.Policies[key(sp, "crm")] = policy{Space: sp, Server: "crm", URL: up.URL, Tools: []string{"read"}, Headers: map[string]string{"Authorization": "Bearer upstream-secret"}, Concurrency: 1, RPM: 10}
	}
	g.state.Store(s)
	return g, hits
}
func request(g *gateway, token, body, sid string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/mcp/crm", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+token)
	r.Header.Set("Cookie", "admin=secret")
	r.Header.Set("Mcp-Session-Id", sid)
	w := httptest.NewRecorder()
	g.ServeHTTP(w, r)
	return w
}
func TestAuthorizationAndDiscovery(t *testing.T) {
	g, h := fixture(t)
	for _, c := range []struct {
		token, body string
		status      int
	}{{"fake", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, 401}, {"a", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"delete"}}`, 403}, {"a", `[{"jsonrpc":"2.0","method":"tools/call"}]`, 400}, {"a", `{"jsonrpc":"2.0","method":"resources/read"}`, 403}} {
		if w := request(g, c.token, c.body, ""); w.Code != c.status {
			t.Fatalf("%d %s", w.Code, w.Body)
		}
	}
	if h.Load() != 0 {
		t.Fatal("denied call reached upstream")
	}
	w := request(g, "a", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, "")
	if w.Code != 200 || strings.Contains(w.Body.String(), "delete") || !strings.Contains(w.Body.String(), "read") {
		t.Fatal(w.Code, w.Body.String())
	}
	if w = request(g, "b", `{"jsonrpc":"2.0","id":1,"method":"tools/list"}`, "upstream-session"); w.Code != 404 {
		t.Fatal("cross-space session allowed")
	}
	if w = request(g, "a", `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read"}}`, "upstream-session"); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}
func TestStaleAndRevocation(t *testing.T) {
	g, _ := fixture(t)
	g.state.Load().At = time.Now().Add(-time.Minute)
	if w := request(g, "a", `{}`, ""); w.Code != 503 {
		t.Fatal(w.Code)
	}
	g.state.Store(&snapshot{At: time.Now(), Tokens: map[string]string{digest("a"): "space-a"}, Policies: map[string]policy{}})
	if w := request(g, "a", `{"jsonrpc":"2.0","method":"tools/list"}`, ""); w.Code != 403 {
		t.Fatal(w.Code)
	}
}
func TestLimits(t *testing.T) {
	g, _ := fixture(t)
	p := policy{Concurrency: 1, RPM: 2}
	if !g.acquire("x", p) || g.acquire("x", p) {
		t.Fatal("concurrency")
	}
	g.release("x")
	if !g.acquire("x", p) {
		t.Fatal("release")
	}
	g.release("x")
	if g.acquire("x", p) {
		t.Fatal("rate")
	}
}
func TestSSEDiscovery(t *testing.T) {
	in := "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":1,\n" + "data: \"result\":{\"tools\":[{\"name\":\"read\"},{\"name\":\"delete\"}]}}\n\n"
	out, e := filterDiscovery([]byte(in), "text/event-stream", policy{Tools: []string{"read"}})
	if e != nil || strings.Contains(string(out), "delete") || !strings.Contains(string(out), "read") {
		t.Fatal(e, string(out))
	}
}
func TestProxyDeniesUnknownTokenAndHost(t *testing.T) {
	g, _ := fixture(t)
	for _, auth := range []bool{false, true} {
		r := httptest.NewRequest("CONNECT", "http://forbidden.example:443", nil)
		r.Host = "forbidden.example:443"
		if auth {
			r.Header.Set("Proxy-Authorization", "Basic c3BhY2U6YQ==")
		}
		w := httptest.NewRecorder()
		g.proxy(w, r)
		want := 407
		if auth {
			want = 403
		}
		if w.Code != want {
			t.Fatal(w.Code)
		}
	}
}

func TestModernDiscoveryTriggersLegacyNegotiation(t *testing.T) {
	g, h := fixture(t)
	w := request(g, "a", `{"jsonrpc":"2.0","id":7,"method":"server/discover"}`, "")
	if w.Code != 400 || !strings.Contains(w.Body.String(), "-32601") || !strings.Contains(w.Body.String(), `"id":7`) || h.Load() != 0 {
		t.Fatal(w.Code, w.Body.String())
	}
}
