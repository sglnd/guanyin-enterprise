// Guanyin MCP gateway: one replica, fail-closed policy snapshots, no Redis.
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type policy struct {
	Space, Server, URL string
	Headers            map[string]string
	Tools              []string
	Concurrency, RPM   int
}
type snapshot struct {
	At       time.Time
	Tokens   map[string]string
	Policies map[string]policy
	Origins  map[string][]string
}
type usage struct {
	Active, Count int
	Window        time.Time
}
type call struct {
	Space, Server, Tool string
	Status              int
	Duration            int64
}
type gateway struct {
	state        atomic.Pointer[snapshot]
	mu           sync.Mutex
	adoptMu      sync.Mutex
	createMu     sync.Mutex
	limits       map[string]*usage
	sessions     map[string]*session
	sessionStore sessionStore
	client       *http.Client
	audit        chan call
}

func key(space, server string) string { return space + "/" + server }
func digest(s string) string          { b := sha256.Sum256([]byte(s)); return hex.EncodeToString(b[:]) }
func newGateway() *gateway {
	return &gateway{limits: map[string]*usage{}, sessions: map[string]*session{}, audit: make(chan call, 4096), client: &http.Client{Transport: &http.Transport{MaxIdleConns: 256, MaxIdleConnsPerHost: 64, MaxConnsPerHost: 256, IdleConnTimeout: 90 * time.Second, ResponseHeaderTimeout: 30 * time.Second}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (g *gateway) fresh() bool {
	s := g.state.Load()
	return s != nil && time.Since(s.At) < 30*time.Second
}
func (g *gateway) acquire(k string, p policy) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	u := g.limits[k]
	if u == nil {
		u = &usage{}
		g.limits[k] = u
	}
	now := time.Now()
	if now.Sub(u.Window) >= time.Minute {
		u.Window = now
		u.Count = 0
	}
	if u.Active >= p.Concurrency || u.Count >= p.RPM {
		return false
	}
	u.Active++
	u.Count++
	return true
}
func (g *gateway) release(k string) { g.mu.Lock(); defer g.mu.Unlock(); g.limits[k].Active-- }
func allowed(p policy, name string) bool {
	if len(p.Tools) == 0 {
		return true
	}
	for _, v := range p.Tools {
		if v == name {
			return true
		}
	}
	return false
}
func fail(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{"error": msg})
}

type rpc struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  struct {
		Name string `json:"name"`
	} `json:"params"`
}

func (g *gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/healthz" {
		w.WriteHeader(200)
		return
	}
	if r.URL.Path == "/readyz" {
		if !g.fresh() {
			w.WriteHeader(503)
		}
		return
	}
	if !strings.HasPrefix(r.URL.Path, "/mcp/") {
		http.NotFound(w, r)
		return
	}
	server := strings.TrimPrefix(r.URL.Path, "/mcp/")
	s := g.state.Load()
	if s == nil || time.Since(s.At) >= 30*time.Second {
		fail(w, 503, "policy_unavailable")
		return
	}
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	space := s.Tokens[digest(token)]
	if !ok || space == "" {
		fail(w, 401, "invalid_space_token")
		return
	}
	start := time.Now()
	status := 403
	tool := ""
	defer func() {
		select {
		case g.audit <- call{space, server, tool, status, time.Since(start).Milliseconds()}:
		default:
			log.Print("audit queue full: event dropped")
		}
	}()
	k := key(space, server)
	p, ok := s.Policies[k]
	if !ok {
		log.Printf("mcp denied: space=%s server=%s reason=mcp_not_authorized", space, server)
		fail(w, 403, "mcp_not_authorized")
		return
	}
	var body []byte
	var msg rpc
	if r.Method == "POST" {
		var err error
		body, err = io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			status = 413
			fail(w, status, "request_too_large")
			return
		}
		if json.Unmarshal(body, &msg) != nil || msg.JSONRPC != "2.0" || msg.Method == "" {
			status = 400
			fail(w, status, "invalid_rpc_or_batch")
			return
		}
		switch msg.Method {
		case "server/discover":
			// V1 deliberately exposes the initialization-based MCP era. A 400
			// JSON-RPC method error lets dual-era clients negotiate legacy;
			// HTTP 403 incorrectly looks like an authorization failure.
			status = http.StatusBadRequest
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_ = json.NewEncoder(w).Encode(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "error": map[string]any{"code": -32601, "message": "Legacy MCP endpoint; use initialize (2025-11-25 or earlier)"}})
			return
		case "initialize", "notifications/initialized", "notifications/cancelled", "ping", "tools/list":
		case "tools/call":
			tool = msg.Params.Name
			if !allowed(p, tool) {
				fail(w, 403, "tool_not_authorized")
				return
			}
		default:
			log.Printf("mcp denied: space=%s server=%s method=%q reason=method_not_authorized", space, server, msg.Method)
			fail(w, 403, "method_not_authorized")
			return
		}
	} else if r.Method != "GET" && r.Method != "DELETE" {
		status = 405
		fail(w, status, "method_not_allowed")
		return
	}
	if !g.acquire(k, p) {
		status = 429
		fail(w, status, "space_limit_exceeded")
		return
	}
	defer g.release(k)
	ctx, cancel := context.WithTimeout(r.Context(), 120*time.Second)
	defer cancel()
	resp, err := g.forwardSession(ctx, r, p, k, body, msg)
	if err != nil {
		status = 502
		var failure *sessionFailure
		message := "session_recovery_failed"
		if errors.As(err, &failure) {
			status = failure.status
			message = failure.message
		}
		fail(w, status, message)
		return
	}
	defer resp.Body.Close()
	if resp.Header.Get("X-Guanyin-Replay-Required") == "1" {
		// HTTP 200 carries a JSON-RPC error; do not audit it as a successful tool call.
		defer func() { status = 409 }()
	}
	// Discovery is bounded and filtered for JSON and SSE responses alike.
	if msg.Method == "tools/list" && resp.StatusCode == 200 {
		data, err := readDiscoveryResponse(resp.Body, resp.Header.Get("Content-Type"), msg.ID, p)
		if err != nil {
			status = 502
			fail(w, status, "invalid_discovery")
			return
		}
		copyHeaders(w, resp)
		status = resp.StatusCode
		w.WriteHeader(status)
		_, _ = w.Write(data)
		return
	}
	copyHeaders(w, resp)
	status = resp.StatusCode
	w.WriteHeader(status)
	// Flush incrementally without buffering full tool results.
	buf := make([]byte, 32*1024)
	for {
		n, e := resp.Body.Read(buf)
		if n > 0 {
			if _, err = w.Write(buf[:n]); err != nil {
				return
			}
			_ = http.NewResponseController(w).Flush()
		}
		if e != nil {
			return
		}
	}
}
func copyHeaders(w http.ResponseWriter, r *http.Response) {
	for _, h := range []string{"Content-Type", "Mcp-Session-Id", "MCP-Protocol-Version"} {
		if v := r.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.Header().Set("Cache-Control", "no-store")
}
func filterJSON(data []byte, p policy) ([]byte, error) {
	var v map[string]any
	if json.Unmarshal(data, &v) != nil {
		return nil, errors.New("json")
	}
	if result, ok := v["result"].(map[string]any); ok {
		if tools, ok := result["tools"].([]any); ok {
			out := []any{}
			for _, t := range tools {
				if obj, ok := t.(map[string]any); ok {
					if name, ok := obj["name"].(string); ok && allowed(p, name) {
						out = append(out, t)
					}
				}
			}
			result["tools"] = out
		}
	}
	return json.Marshal(v)
}

// Streamable HTTP servers may keep SSE open after the RPC response.
// Return as soon as this request's response arrives, without waiting for EOF.
func readDiscoveryResponse(body io.Reader, contentType string, requestID json.RawMessage, p policy) ([]byte, error) {
	const maxBytes = 4 << 20
	if !strings.Contains(contentType, "text/event-stream") {
		data, err := io.ReadAll(io.LimitReader(body, maxBytes+1))
		if err != nil || len(data) > maxBytes {
			return nil, errors.New("invalid or oversized discovery")
		}
		return filterJSON(data, p)
	}
	scanner := bufio.NewScanner(io.LimitReader(body, maxBytes+1))
	scanner.Buffer(make([]byte, 4096), maxBytes)
	var frame bytes.Buffer
	var payload []string
	total := 0
	for scanner.Scan() {
		line := scanner.Text()
		total += len(line) + 1
		if total > maxBytes {
			return nil, errors.New("oversized discovery")
		}
		frame.WriteString(line + "\n")
		if strings.HasPrefix(line, "data:") {
			payload = append(payload, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
		if line != "" {
			continue
		}
		if len(payload) > 0 {
			var response struct {
				ID     json.RawMessage `json:"id"`
				Result json.RawMessage `json:"result"`
				Error  json.RawMessage `json:"error"`
			}
			if err := json.Unmarshal([]byte(strings.Join(payload, "\n")), &response); err != nil {
				return nil, err
			}
			if bytes.Equal(response.ID, requestID) && (len(response.Result) > 0 || len(response.Error) > 0) {
				return filterDiscovery(frame.Bytes(), contentType, p)
			}
		}
		frame.Reset()
		payload = nil
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return nil, errors.New("discovery ended without matching response")
}

func filterDiscovery(data []byte, ct string, p policy) ([]byte, error) {
	if !strings.Contains(ct, "text/event-stream") {
		return filterJSON(data, p)
	}
	scanner := bufio.NewScanner(bytes.NewReader(data))
	scanner.Buffer(make([]byte, 4096), 4<<20)
	var out bytes.Buffer
	var fields []string
	var payload []string
	flush := func() error {
		if len(payload) > 0 {
			v, e := filterJSON([]byte(strings.Join(payload, "\n")), p)
			if e != nil {
				return e
			}
			fields = append(fields, "data: "+string(v))
		}
		for _, f := range fields {
			out.WriteString(f + "\n")
		}
		out.WriteByte('\n')
		fields = nil
		payload = nil
		return nil
	}
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if e := flush(); e != nil {
				return nil, e
			}
		} else if strings.HasPrefix(line, "data:") {
			payload = append(payload, strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		} else {
			fields = append(fields, line)
		}
	}
	if e := scanner.Err(); e != nil {
		return nil, e
	}
	if len(fields) > 0 || len(payload) > 0 {
		if e := flush(); e != nil {
			return nil, e
		}
	}
	return out.Bytes(), nil
}
func load(ctx context.Context, pool *pgxpool.Pool) (*snapshot, error) {
	tx, e := pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly})
	if e != nil {
		return nil, e
	}
	defer tx.Rollback(ctx)
	s := &snapshot{At: time.Now(), Tokens: map[string]string{}, Policies: map[string]policy{}}
	rows, e := tx.Query(ctx, `SELECT t.token_hash,t.instance_id::text FROM mcp_gateway_tokens t JOIN instances i ON i.id=t.instance_id WHERE i.deleted_at IS NULL AND i.status<>'deleting'`)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var h, id string
		if e = rows.Scan(&h, &id); e != nil {
			rows.Close()
			return nil, e
		}
		s.Tokens[h] = id
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	rows, e = tx.Query(ctx, `SELECT b.instance_id::text,m.id::text,m.url,m.headers,m.allowed_tools,m.max_concurrency,m.requests_per_minute FROM space_mcp_bindings b JOIN mcp_servers m ON m.id=b.mcp_server_id JOIN instances i ON i.id=b.instance_id WHERE m.enabled AND i.deleted_at IS NULL AND i.status<>'deleting'`)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var p policy
		if e = rows.Scan(&p.Space, &p.Server, &p.URL, &p.Headers, &p.Tools, &p.Concurrency, &p.RPM); e != nil {
			rows.Close()
			return nil, e
		}
		u, err := url.Parse(p.URL)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			rows.Close()
			return nil, fmt.Errorf("invalid MCP URL")
		}
		s.Policies[key(p.Space, p.Server)] = p
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	s.Origins = map[string][]string{}
	rows, e = tx.Query(ctx, `SELECT n.instance_id::text,n.allowed_origins FROM space_network_policies n JOIN instances i ON i.id=n.instance_id WHERE i.deleted_at IS NULL AND i.status<>'deleting'`)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var id string
		var origins []string
		if e = rows.Scan(&id, &origins); e != nil {
			rows.Close()
			return nil, e
		}
		s.Origins[id] = origins
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	// Platform-managed model bindings are trusted outbound destinations. They
	// remain subject to the same proxy authentication and destination checks.
	rows, e = tx.Query(ctx, `SELECT c.instance_id::text,m.config->>'baseURL' FROM space_model_configs c JOIN model_providers m ON m.id=ANY(c.provider_ids) JOIN instances i ON i.id=c.instance_id WHERE m.enabled AND i.deleted_at IS NULL AND i.status<>'deleting'`)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var id, raw string
		if e = rows.Scan(&id, &raw); e != nil {
			rows.Close()
			return nil, e
		}
		u, err := url.Parse(raw)
		if err != nil {
			rows.Close()
			return nil, err
		}
		o, _, err := origin(u.Scheme, u.Host)
		if err != nil {
			rows.Close()
			return nil, err
		}
		s.Origins[id] = append(s.Origins[id], o)
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	if e = tx.Commit(ctx); e != nil {
		return nil, e
	}
	return s, nil
}
func (g *gateway) sync(ctx context.Context, pool *pgxpool.Pool) {
	for ctx.Err() == nil {
		func() {
			conn, e := pool.Acquire(ctx)
			if e != nil {
				return
			}
			defer conn.Release()
			if _, e = conn.Exec(ctx, "LISTEN guanyin_mcp_config"); e != nil {
				return
			}
			defer conn.Exec(context.Background(), "UNLISTEN guanyin_mcp_config")
			for ctx.Err() == nil {
				refresh, cancel := context.WithTimeout(ctx, 5*time.Second)
				s, e := load(refresh, pool)
				cancel()
				if e != nil {
					log.Print("policy refresh failed")
				} else {
					g.state.Store(s)
				}
				wait, c := context.WithTimeout(ctx, 5*time.Second)
				_, e = conn.Conn().WaitForNotification(wait)
				c()
				if e != nil && !errors.Is(e, context.DeadlineExceeded) {
					return
				}
			}
		}()
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}
func (g *gateway) writeAudit(ctx context.Context, pool *pgxpool.Pool) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	batch := []call{}
	flush := func() {
		if len(batch) == 0 {
			return
		}
		c, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		b := &pgx.Batch{}
		for _, v := range batch {
			b.Queue(`INSERT INTO mcp_gateway_calls(instance_id,server_id,tool,status,duration_ms) VALUES($1,CASE WHEN $2::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN $2::text::uuid ELSE NULL END,$3,$4,$5)`, v.Space, v.Server, v.Tool, v.Status, v.Duration)
		}
		if e := pool.SendBatch(c, b).Close(); e != nil {
			log.Print("audit batch failed")
		}
		batch = nil
	}
	for {
		select {
		case v := <-g.audit:
			batch = append(batch, v)
			if len(batch) >= 100 {
				flush()
			}
		case <-ticker.C:
			flush()
		case <-ctx.Done():
			for {
				select {
				case v := <-g.audit:
					batch = append(batch, v)
				default:
					flush()
					return
				}
			}
		}
	}
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	pool, e := pgxpool.New(ctx, os.Getenv("DATABASE_URL"))
	if e != nil {
		log.Fatal(e)
	}
	defer pool.Close()
	g := newGateway()
	storeCtx, storeCancel := context.WithTimeout(ctx, 30*time.Second)
	g.sessionStore, e = initSessionStore(storeCtx, pool)
	storeCancel()
	if e != nil {
		log.Fatal("MCP session store initialization failed: ", e)
	}
	go g.sync(ctx, pool)
	auditCtx, auditCancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { g.writeAudit(auditCtx, pool); close(done) }()
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}
	srv := &http.Server{Addr: ":" + port, Handler: g, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 15 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 32 << 10}
	go func() {
		<-ctx.Done()
		c, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(c)
	}()
	proxyServer := &http.Server{Addr: ":8081", Handler: http.HandlerFunc(g.proxy), ReadHeaderTimeout: 5 * time.Second, MaxHeaderBytes: 32 << 10}
	go func() {
		if err := proxyServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Print(err)
		}
	}()
	defer proxyServer.Close()
	log.Print("MCP gateway listening on " + port)
	if e := srv.ListenAndServe(); e != nil && e != http.ErrServerClosed {
		log.Fatal(e)
	}
	auditCancel()
	<-done
}
