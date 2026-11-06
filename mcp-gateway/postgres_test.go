package main

import (
	"context"
	"os"
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
