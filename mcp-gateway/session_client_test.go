package main

import (
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"testing"
)

// Opt in using an existing SDK installation/image; never install dependencies
// or start an additional persistent local test environment from the test suite.
func TestUnmodifiedDSHClientSessionRecovery(t *testing.T) {
	sdk := os.Getenv("MCP_TEST_SDK")
	image := os.Getenv("MCP_TEST_DSH_IMAGE")
	if sdk == "" && image == "" {
		t.Skip("existing DSH SDK/image not configured")
	}
	g, u, _ := sessionFixture(t)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/expire" {
			expire(u)
			w.WriteHeader(204)
			return
		}
		g.ServeHTTP(w, r)
	}))
	listener, err := net.Listen("tcp", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	server.Listener.Close()
	server.Listener = listener
	server.Start()
	defer server.Close()
	_, port, _ := net.SplitHostPort(listener.Addr().String())
	host := "127.0.0.1"
	if image != "" {
		host = "host.docker.internal"
	}
	endpoint := "http://" + net.JoinHostPort(host, port)
	script := `
 import assert from 'node:assert/strict';
 const sdk=await import(process.env.MCP_TEST_SDK);
 const {StreamableHTTPClientTransport}=process.env.MCP_TEST_TRANSPORT ? await import(process.env.MCP_TEST_TRANSPORT) : sdk;
 const client=new sdk.Client({name:'unmodified-dsh-client',version:'1'},{capabilities:{},versionNegotiation:{mode:'auto'}});
 const transport=new StreamableHTTPClientTransport(new URL(process.env.MCP_TEST_ENDPOINT+'/mcp/crm'),{requestInit:{headers:{Authorization:'Bearer a'}}});
 try {
  await client.connect(transport);
  const original=transport.sessionId;
  assert.match(original,/^gy1_/);
  await client.listTools();
  await fetch(process.env.MCP_TEST_ENDPOINT+'/expire');
  const tools=await client.listTools();
  assert.equal(tools.tools.length,2);
  assert.equal(transport.sessionId,original);
  await fetch(process.env.MCP_TEST_ENDPOINT+'/expire');
  await assert.rejects(client.callTool({name:'read',arguments:{}}),/未自动重放/);
  const value=await client.callTool({name:'read',arguments:{}});
  assert.equal(value.content[0].text,'ok');
 } finally { await client.close(); }
 `
	var cmd *exec.Cmd
	if image != "" {
		cmd = exec.Command("docker", "run", "--rm", "--entrypoint", "node", "-e", "MCP_TEST_ENDPOINT="+endpoint, "-e", "MCP_TEST_SDK=/opt/dsh-runtime/node_modules/@modelcontextprotocol/client/dist/index.mjs", image, "--input-type=module", "-e", script)
	} else {
		cmd = exec.Command("node", "--input-type=module", "-e", script)
		cmd.Env = append(os.Environ(), "MCP_TEST_ENDPOINT="+endpoint)
	}
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("unmodified SDK failed: %v\n%s", err, output)
	}
}
