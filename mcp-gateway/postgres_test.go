package main

import (
	"context"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Run only against an isolated database initialized by the control plane.
func TestPostgresSnapshotNotificationAndAudit(t *testing.T) {
	dsn := os.Getenv("MCP_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("isolated PostgreSQL not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, e := pgxpool.New(ctx, dsn)
	if e != nil {
		t.Fatal(e)
	}
	defer pool.Close()
	var space, server, user, tenant string
	if e = pool.QueryRow(ctx, `SELECT id::text,tenant_id::text FROM users WHERE username='admin'`).Scan(&user, &tenant); e != nil {
		t.Fatal(e)
	}
	if e = pool.QueryRow(ctx, `INSERT INTO instances(id,name,slug,version,image,tenant_id,user_id,status) VALUES(gen_random_uuid(),'gateway-test',gen_random_uuid()::text,'test','test',$1,$2,'running') RETURNING id::text`, tenant, user).Scan(&space); e != nil {
		t.Fatal(e)
	}
	defer pool.Exec(context.Background(), "DELETE FROM instances WHERE id=$1", space)
	if e = pool.QueryRow(ctx, `INSERT INTO mcp_servers(id,name,server_name,url,created_by,allowed_tools) VALUES(gen_random_uuid(),'gateway-test',gen_random_uuid()::text,'http://127.0.0.1:9999/mcp',$1,'["read"]') RETURNING id::text`, user).Scan(&server); e != nil {
		t.Fatal(e)
	}
	defer pool.Exec(context.Background(), "DELETE FROM mcp_servers WHERE id=$1", server)
	if _, e = pool.Exec(ctx, `INSERT INTO space_mcp_bindings(instance_id,mcp_server_id,created_by) VALUES($1,$2,$3)`, space, server, user); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, `INSERT INTO mcp_gateway_tokens(instance_id,token_hash) VALUES($1,$2)`, space, digest("integration-token")); e != nil {
		t.Fatal(e)
	}
	s, e := load(ctx, pool)
	if e != nil {
		t.Fatal(e)
	}
	if s.Tokens[digest("integration-token")] != space || !allowed(s.Policies[key(space, server)], "read") {
		t.Fatal("snapshot mismatch")
	}
	conn, e := pool.Acquire(ctx)
	if e != nil {
		t.Fatal(e)
	}
	defer conn.Release()
	if _, e = conn.Exec(ctx, "LISTEN guanyin_mcp_config"); e != nil {
		t.Fatal(e)
	}
	if _, e = pool.Exec(ctx, `UPDATE mcp_servers SET allowed_tools='["other"]' WHERE id=$1`, server); e != nil {
		t.Fatal(e)
	}
	if _, e = conn.Conn().WaitForNotification(ctx); e != nil {
		t.Fatal(e)
	}
	s, e = load(ctx, pool)
	if e != nil || allowed(s.Policies[key(space, server)], "read") {
		t.Fatal("revocation not reflected", e)
	}
	g := newGateway()
	auditCtx, stop := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() { g.writeAudit(auditCtx, pool); close(done) }()
	g.audit <- call{space, server, "read", 403, 5}
	stop()
	<-done
	var n int
	if e = pool.QueryRow(ctx, `SELECT count(*) FROM mcp_gateway_calls WHERE instance_id=$1 AND status=403`, space).Scan(&n); e != nil || n != 1 {
		t.Fatal("audit", n, e)
	}
	_, _ = pool.Exec(ctx, `DELETE FROM mcp_gateway_calls WHERE instance_id=$1`, space)
}

func TestPostgresDurableGatewaySessions(t *testing.T) {
	dsn := os.Getenv("MCP_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("isolated PostgreSQL not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	store, err := initSessionStore(ctx, pool)
	if err != nil {
		t.Fatal(err)
	}
	g, upstream, _ := sessionFixture(t)
	g.sessionStore = store
	sid := startSession(t, g)
	defer store.Delete(context.Background(), key("space-a", "crm")+"/"+sid)
	state := g.state.Load()

	// Use a new gateway and a new database pool, with no in-memory session state.
	newPool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer newPool.Close()
	restarted := newGateway()
	restarted.sessionStore, err = initSessionStore(ctx, newPool)
	if err != nil {
		t.Fatal(err)
	}
	restarted.state.Store(state)
	if w := request(restarted, "b", listRPC, sid); w.Code != 404 {
		t.Fatal("foreign space recovered a persisted session", w.Code)
	}
	w := request(restarted, "a", callRPC, sid)
	if w.Code != 200 || w.Header().Get("Mcp-Session-Id") != sid ||
		!strings.Contains(w.Body.String(), "ok") || upstream.initialized != 2 || upstream.executed != 1 {
		t.Fatal("persisted session did not recover", w.Code, w.Body.String(), upstream.initialized, upstream.executed)
	}

	remove := httptest.NewRequest("DELETE", "/mcp/crm", nil)
	remove.Header.Set("Authorization", "Bearer a")
	remove.Header.Set("Mcp-Session-Id", sid)
	deleted := httptest.NewRecorder()
	restarted.ServeHTTP(deleted, remove)
	if deleted.Code != 204 {
		t.Fatal(deleted.Code, deleted.Body.String())
	}
	afterDelete := newGateway()
	afterDelete.sessionStore = restarted.sessionStore
	afterDelete.state.Store(state)
	if w := request(afterDelete, "a", listRPC, sid); w.Code != 404 {
		t.Fatal("deleted session restored", w.Code)
	}
}
