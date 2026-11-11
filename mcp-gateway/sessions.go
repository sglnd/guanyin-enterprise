package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Persist only downstream identity and initialization metadata, never bearer
// tokens, upstream credentials or tool arguments/results. Upstream sessions are
// deliberately rebuilt after restart, not shared between client connections.
type sessionRecord struct {
	ID, Owner, Fingerprint string
	Initialize             json.RawMessage
	Expires                time.Time
}
type session struct {
	record             sessionRecord
	mu                 sync.Mutex
	gate               chan struct{}
	upstream, protocol string
	epoch              uint64
	retryAfter         time.Time
}
type sessionStore interface {
	Put(context.Context, sessionRecord) error
	Get(context.Context, string) (sessionRecord, error)
	Delete(context.Context, string) error
}
type pgSessions struct{ pool *pgxpool.Pool }

func initSessionStore(ctx context.Context, pool *pgxpool.Pool) (sessionStore, error) {
	_, err := pool.Exec(ctx, `CREATE TABLE IF NOT EXISTS mcp_gateway_sessions (
 id text PRIMARY KEY, owner text NOT NULL, fingerprint text NOT NULL,
 initialize jsonb NOT NULL, expires_at timestamptz NOT NULL);
 CREATE INDEX IF NOT EXISTS mcp_gateway_sessions_expiry ON mcp_gateway_sessions(expires_at)`)
	return &pgSessions{pool}, err
}
func (s *pgSessions) Put(ctx context.Context, r sessionRecord) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	// Enforce a durable global bound, including across process restarts.
	if _, err = tx.Exec(ctx, `SELECT pg_advisory_xact_lock(173510321,2)`); err != nil {
		return err
	}
	if _, err = tx.Exec(ctx, `DELETE FROM mcp_gateway_sessions WHERE expires_at < now()`); err != nil {
		return err
	}
	var count int
	var metadataBytes int64
	if err = tx.QueryRow(ctx, `SELECT count(*),COALESCE(sum(octet_length(initialize::text)),0) FROM mcp_gateway_sessions`).Scan(&count, &metadataBytes); err != nil {
		return err
	}
	if count >= 10000 || metadataBytes+int64(len(r.Initialize)) > 64<<20 {
		return errors.New("session capacity")
	}
	_, err = tx.Exec(ctx, `INSERT INTO mcp_gateway_sessions(id,owner,fingerprint,initialize,expires_at) VALUES($1,$2,$3,$4,$5)`, r.ID, r.Owner, r.Fingerprint, r.Initialize, r.Expires)
	if err != nil {
		return err
	}
	return tx.Commit(ctx)
}
func (s *pgSessions) Get(ctx context.Context, id string) (r sessionRecord, err error) {
	err = s.pool.QueryRow(ctx, `SELECT id,owner,fingerprint,initialize,expires_at FROM mcp_gateway_sessions WHERE id=$1 AND expires_at>now()`, id).Scan(&r.ID, &r.Owner, &r.Fingerprint, &r.Initialize, &r.Expires)
	return
}
func (s *pgSessions) Delete(ctx context.Context, id string) error {
	_, err := s.pool.Exec(ctx, `DELETE FROM mcp_gateway_sessions WHERE id=$1`, id)
	return err
}
func fingerprint(p policy) string {
	data, _ := json.Marshal([]any{p.URL, p.Headers})
	return digest(string(data))
}
func sessionError(status int, message string) error { return &sessionFailure{status, message} }

type sessionFailure struct {
	status  int
	message string
}

func (e *sessionFailure) Error() string   { return e.message }
func newSession(r sessionRecord) *session { return &session{record: r, gate: make(chan struct{}, 1)} }
func (s *session) lock(ctx context.Context) error {
	select {
	case s.gate <- struct{}{}:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}
func (s *session) unlock() { <-s.gate }
func (s *session) current() (string, string, uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.upstream, s.protocol, s.epoch
}
func (s *session) set(sid, protocol string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.upstream, s.protocol = sid, protocol
	s.epoch++
}
func (g *gateway) remember(ctx context.Context, s *session) error {
	g.createMu.Lock()
	defer g.createMu.Unlock()
	g.mu.Lock()
	metadataBytes := 0
	for id, entry := range g.sessions {
		if time.Now().After(entry.record.Expires) {
			delete(g.sessions, id)
		} else {
			metadataBytes += len(entry.record.Initialize)
		}
	}
	if len(g.sessions) >= 10000 || metadataBytes+len(s.record.Initialize) > 64<<20 {
		g.mu.Unlock()
		return sessionError(503, "session_capacity")
	}
	g.mu.Unlock()
	if g.sessionStore != nil {
		if err := g.sessionStore.Put(ctx, s.record); err != nil {
			return sessionError(503, "session_store_unavailable")
		}
	}
	g.mu.Lock()
	g.sessions[s.record.ID] = s
	g.mu.Unlock()
	return nil
}
func (g *gateway) getSession(ctx context.Context, sid, owner string, p policy) (*session, error) {
	id := owner + "/" + sid
	g.mu.Lock()
	s := g.sessions[id]
	g.mu.Unlock()
	if s == nil && g.sessionStore != nil {
		record, err := g.sessionStore.Get(ctx, id)
		if err != nil && !errors.Is(err, pgx.ErrNoRows) {
			return nil, sessionError(503, "session_store_unavailable")
		}
		if err == nil {
			if record.Owner != owner {
				return nil, sessionError(404, "unknown_session")
			}
			loaded := newSession(record)
			g.mu.Lock()
			s = g.sessions[id]
			if s == nil {
				s = loaded
				g.sessions[id] = s
			}
			g.mu.Unlock()
		}
	}
	if s == nil && !strings.HasPrefix(sid, "gy1_") && len(sid) <= 128 {
		// Upgrade compatibility: treat a pre-gateway ID only as an opaque alias.
		// NEVER forward it upstream or claim its old session. Create a fresh,
		// independently initialized connection under the authenticated space/server.
		// Serialize legacy adoption so parallel first requests do not create duplicates.
		g.adoptMu.Lock()
		defer g.adoptMu.Unlock()
		g.mu.Lock()
		s = g.sessions[id]
		g.mu.Unlock()
		if s == nil {
			init := json.RawMessage(`{"jsonrpc":"2.0","id":"gateway-recover","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"guanyin-gateway","version":"1"}}}`)
			s = newSession(sessionRecord{ID: id, Owner: owner, Fingerprint: fingerprint(p), Initialize: init, Expires: time.Now().Add(365 * 24 * time.Hour)})
			if err := g.remember(ctx, s); err != nil {
				return nil, err
			}
		}
	}
	if s == nil || s.record.Owner != owner || time.Now().After(s.record.Expires) {
		return nil, sessionError(404, "unknown_session")
	}
	if s.record.Fingerprint != fingerprint(p) {
		return nil, sessionError(409, "session_configuration_changed")
	}
	return s, nil
}
func (g *gateway) upstreamRequest(ctx context.Context, r *http.Request, p policy, body []byte, sid, protocol string) (*http.Response, error) {
	up, err := http.NewRequestWithContext(ctx, r.Method, p.URL, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	for _, h := range []string{"Content-Type", "Accept", "MCP-Protocol-Version", "Last-Event-ID"} {
		if v := r.Header.Get(h); v != "" {
			up.Header.Set(h, v)
		}
	}
	for h, v := range p.Headers {
		up.Header.Set(h, v)
	}
	up.Header.Del("Mcp-Session-Id")
	if sid != "" {
		up.Header.Set("Mcp-Session-Id", sid)
	}
	if protocol != "" {
		up.Header.Set("MCP-Protocol-Version", protocol)
	}
	resp, err := g.client.Do(up)
	if err != nil {
		return nil, sessionError(502, "upstream_unavailable")
	}
	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		resp.Body.Close()
		return nil, sessionError(502, "upstream_redirect_rejected")
	}
	return resp, nil
}

// Bounded JSON/SSE handshake parser; an SSE stream need not close to complete.
func handshakeResult(resp *http.Response, id json.RawMessage) ([]byte, string, error) {
	defer resp.Body.Close()
	data, err := readDiscoveryResponse(resp.Body, resp.Header.Get("Content-Type"), id, policy{})
	if err != nil {
		return nil, "", err
	}
	if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		var lines []string
		for _, line := range strings.Split(string(data), "\n") {
			if strings.HasPrefix(line, "data:") {
				lines = append(lines, strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			}
		}
		data = []byte(strings.Join(lines, "\n"))
	}
	var result struct {
		ID     json.RawMessage `json:"id"`
		Result *struct {
			Protocol string `json:"protocolVersion"`
		} `json:"result"`
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(data, &result) != nil || !bytes.Equal(result.ID, id) || result.Result == nil || result.Result.Protocol == "" || len(result.Error) > 0 {
		return nil, "", errors.New("invalid initialize result")
	}
	return data, result.Result.Protocol, nil
}
func jsonResponse(status int, body []byte) *http.Response {
	return &http.Response{StatusCode: status, Header: http.Header{"Content-Type": []string{"application/json"}}, Body: io.NopCloser(bytes.NewReader(body))}
}
func (g *gateway) reconnect(ctx context.Context, r *http.Request, p policy, s *session, observed uint64) (err error) {
	if err := s.lock(ctx); err != nil {
		return err
	}
	defer s.unlock()
	_, _, epoch := s.current()
	if epoch != observed {
		return nil
	}
	s.mu.Lock()
	cooling := time.Now().Before(s.retryAfter)
	s.mu.Unlock()
	if cooling {
		return sessionError(502, "session_reconnect_backoff")
	}
	defer func() {
		if err != nil {
			s.mu.Lock()
			s.retryAfter = time.Now().Add(time.Second)
			s.mu.Unlock()
		}
	}()
	handshakeCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	initReq := r.Clone(handshakeCtx)
	initReq.Method = "POST"
	initReq.Header = r.Header.Clone()
	initReq.Header.Set("Content-Type", "application/json")
	initReq.Header.Set("Accept", "application/json, text/event-stream")
	initReq.Header.Del("Last-Event-ID")
	resp, err := g.upstreamRequest(handshakeCtx, initReq, p, s.record.Initialize, "", "")
	if err != nil {
		return err
	}
	if resp.StatusCode != 200 {
		resp.Body.Close()
		return sessionError(502, "session_reinitialize_failed")
	}
	var msg rpc
	_ = json.Unmarshal(s.record.Initialize, &msg)
	_, protocol, err := handshakeResult(resp, msg.ID)
	if err != nil {
		return sessionError(502, "invalid_initialize_response")
	}
	upstream := resp.Header.Get("Mcp-Session-Id")
	notify := []byte(`{"jsonrpc":"2.0","method":"notifications/initialized"}`)
	resp, err = g.upstreamRequest(handshakeCtx, initReq, p, notify, upstream, protocol)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return sessionError(502, "session_notification_failed")
	}
	s.set(upstream, protocol)
	// Empty IDs denote a stateless upstream; ensureLoaded uses protocol as its marker.
	return nil
}
func rejectedSession(resp *http.Response) bool {
	if resp.StatusCode == 404 {
		return true
	}
	if (resp.StatusCode != 200 && resp.StatusCode != 400) || !strings.Contains(resp.Header.Get("Content-Type"), "application/json") {
		return false
	}
	// Sniff only a small prefix; preserve large or streamed tool results verbatim.
	prefix, err := io.ReadAll(io.LimitReader(resp.Body, 8193))
	resp.Body = struct {
		io.Reader
		io.Closer
	}{io.MultiReader(bytes.NewReader(prefix), resp.Body), resp.Body}
	if err != nil || len(prefix) > 8192 {
		return false
	}
	var v struct {
		Error json.RawMessage `json:"error"`
	}
	if json.Unmarshal(prefix, &v) != nil {
		return false
	}
	var object struct {
		Message string `json:"message"`
	}
	var message string
	if json.Unmarshal(v.Error, &object) == nil {
		message = object.Message
	} else {
		_ = json.Unmarshal(v.Error, &message)
	}
	switch strings.ToLower(strings.TrimSpace(message)) {
	case "session not found", "session expired", "session terminated", "unknown_session", "invalid session", "invalid session id":
		return true
	}
	return false
}

// A stable downstream ID hides upstream replacement. Authorization always ran
// before this function; possessing an ID never grants access to another space.
func (g *gateway) forwardSession(ctx context.Context, r *http.Request, p policy, owner string, body []byte, msg rpc) (*http.Response, error) {
	sid := r.Header.Get("Mcp-Session-Id")
	if msg.Method == "initialize" {
		initCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
		defer cancel()
		ctx = initCtx
		if len(body) > 64<<10 {
			return nil, sessionError(413, "initialize_too_large")
		}
		resp, err := g.upstreamRequest(ctx, r, p, body, "", "")
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != 200 {
			return resp, nil
		}
		data, protocol, err := handshakeResult(resp, msg.ID)
		if err != nil {
			return nil, sessionError(502, "invalid_initialize_response")
		}
		var random [32]byte
		if _, err = rand.Read(random[:]); err != nil {
			return nil, err
		}
		id := "gy1_" + base64.RawURLEncoding.EncodeToString(random[:])
		record := sessionRecord{ID: owner + "/" + id, Owner: owner, Fingerprint: fingerprint(p), Initialize: append([]byte(nil), body...), Expires: time.Now().Add(365 * 24 * time.Hour)}
		s := newSession(record)
		s.set(resp.Header.Get("Mcp-Session-Id"), protocol)
		if err = g.remember(ctx, s); err != nil {
			return nil, err
		}
		out := jsonResponse(200, data)
		out.Header.Set("Mcp-Session-Id", id)
		return out, nil
	}
	if sid == "" {
		if r.Method == "GET" || r.Method == "DELETE" {
			return nil, sessionError(400, "session_required")
		}
		resp, err := g.upstreamRequest(ctx, r, p, body, "", "")
		if resp != nil {
			resp.Header.Del("Mcp-Session-Id")
		}
		return resp, err
	}
	s, err := g.getSession(ctx, sid, owner, p)
	if err != nil {
		return nil, err
	}
	upstream, protocol, epoch := s.current()
	if r.Method == "DELETE" {
		// Deleting a downstream identity must not depend on upstream health.
		if g.sessionStore != nil {
			if err = g.sessionStore.Delete(ctx, s.record.ID); err != nil {
				return nil, sessionError(503, "session_store_unavailable")
			}
		}
		g.mu.Lock()
		delete(g.sessions, s.record.ID)
		g.mu.Unlock()
		if upstream != "" {
			cleanupCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
			resp, e := g.upstreamRequest(cleanupCtx, r, p, body, upstream, protocol)
			if e == nil {
				resp.Body.Close()
			}
			cancel()
		}
		return jsonResponse(204, nil), nil
	}
	if protocol == "" {
		if err = g.reconnect(ctx, r, p, s, epoch); err != nil {
			return nil, err
		}
		upstream, protocol, epoch = s.current()
	}
	resp, err := g.upstreamRequest(ctx, r, p, body, upstream, protocol)
	if err != nil {
		return nil, err
	}
	if (r.Method == "GET" || (r.Method == "POST" && msg.Method != "notifications/initialized")) && rejectedSession(resp) {
		resp.Body.Close()
		if err = g.reconnect(ctx, r, p, s, epoch); err != nil {
			return nil, err
		}
		if msg.Method == "tools/call" {
			logSessionRecovery(owner)
			data, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "error": map[string]any{"code": -32000, "message": "MCP 会话已恢复。本次工具未自动重放；查询可重新发起，写操作请先核实执行结果再决定是否重试。"}})
			out := jsonResponse(200, data)
			out.Header.Set("X-Guanyin-Replay-Required", "1")
			return out, nil
		}
		if r.Method == "GET" || msg.Method == "tools/list" || msg.Method == "ping" {
			upstream, protocol, epoch = s.current()
			resp, err = g.upstreamRequest(ctx, r, p, body, upstream, protocol)
			if err != nil {
				return nil, err
			}
		} else {
			return nil, sessionError(502, "session_recovered_retry_required")
		}
	}
	resp.Header.Set("Mcp-Session-Id", sid)
	return resp, nil
}
func logSessionRecovery(owner string) {
	log.Printf("MCP session recovered: owner=%s; tool request not replayed", owner)
}
